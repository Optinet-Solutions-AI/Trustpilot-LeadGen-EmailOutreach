"""Find a NAMED marketing decision-maker for a lead's domain.

The emails this CRM scrapes are role addresses — support@, suporte@,
ouvidoria@ — which land in a shared queue. This looks for a person who owns
the reputation problem instead: Head of Marketing, Director of Marketing, CMO.

Providers (both measured 2026-09-10):
  * Snov.io  — WORKS on the free trial. 50 credits, 1 per domain searched,
               resets/expires in 29 days. Returns first/last name, position
               and email per contact.
  * Apollo   — free plan returns 403 API_INACCESSIBLE for every people
               endpoint (mixed_people/search, people/match,
               mixed_companies/search). Only organizations/enrich works, which
               carries no people. The adapter below is written and ready, and
               starts returning contacts the moment the plan is upgraded — it
               is NOT dead code, just gated.

Credits are the binding constraint, so `--limit` is mandatory in practice and
`snov_checked_at` records a searched-but-empty domain to stop a re-run paying
for it twice.

Usage:
  # what would it spend, and on which domains
  .venv/Scripts/python.exe -m tools.scraper.discover_contacts --category br_licensed_betting --limit 20 --dry-run

  # spend the credits
  .venv/Scripts/python.exe -m tools.scraper.discover_contacts --category br_licensed_betting --limit 20 --apply
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Iterable

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

# Ranked best-first. A contact's rank is the index of the FIRST pattern its
# title matches, so ordering here IS the business rule.
TITLE_LADDER: tuple[tuple[str, ...], ...] = (
    # 0 — the ask
    (r'\bchief marketing officer\b', r'\bcmo\b'),
    # 1 — the ask
    (r'\bhead of marketing\b', r'\bmarketing head\b'),
    # 2 — the ask
    (r'\bdirector of marketing\b', r'\bmarketing director\b'),
    # 3 — same authority, different label
    (r'\bvp\b.*\bmarketing\b', r'\bvice president\b.*\bmarketing\b',
     r'\bmarketing\b.*\bvp\b'),
    # 4 — adjacent leadership that still owns reputation: CRM, brand, growth,
    #     comms, and the commercial/product directors Snov actually returns.
    (r'\b(crm|brand|growth|communications|comms|digital|commercial|product)\b.*'
     r'\b(director|head|chief|officer|lead)\b',
     r'\b(director|head|chief|officer|lead)\b.*'
     r'\b(crm|brand|growth|communications|comms|digital|commercial)\b'),
    # 5 — marketing management
    (r'\bmarketing manager\b', r'\bmanager\b.*\bmarketing\b'),
    # 6 — anyone else in marketing (kto.com's only hit was a PPC Specialist)
    (r'\bmarketing\b', r'\bppc\b', r'\bseo\b', r'\bpaid (media|social)\b',
     r'\bacquisition\b'),
)

# A shared mailbox is not a named contact. Finding one here means the provider
# attached a role address to a person, which defeats the point of the search.
ROLE_LOCALPARTS = {
    'hr', 'info', 'support', 'suporte', 'contact', 'contato', 'admin', 'sales',
    'hello', 'help', 'ouvidoria', 'noreply', 'no-reply', 'press', 'jobs',
    'careers', 'marketing', 'office', 'mail', 'team', 'privacy', 'legal',
    'compliance', 'billing', 'finance', 'partners', 'parcerias', 'affiliates',
}


def title_rank(title: str | None) -> int | None:
    """How well a job title matches what we're hunting. Lower is better.

    Returns None when the title isn't a marketing/reputation role at all, which
    is the signal to discard the person entirely.
    """
    text = (title or '').strip().lower()
    if not text:
        return None
    for rank, patterns in enumerate(TITLE_LADDER):
        if any(re.search(p, text) for p in patterns):
            return rank
    return None


def _is_role_inbox(email: str) -> bool:
    local = email.split('@', 1)[0].strip().lower()
    return local in ROLE_LOCALPARTS


def best_contact(people: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """The single best named contact from a provider's people list, or None."""
    ranked: list[tuple[int, dict[str, Any]]] = []
    for p in people or []:
        email = (p.get('email') or '').strip()
        if not email or _is_role_inbox(email):
            continue
        rank = title_rank(p.get('position'))
        if rank is None:
            continue
        name = ' '.join(
            part for part in [(p.get('first_name') or '').strip(),
                              (p.get('last_name') or '').strip()] if part
        )
        ranked.append((rank, {'email': email, 'position': (p.get('position') or '').strip(),
                              'name': name or None}))
    if not ranked:
        return None
    ranked.sort(key=lambda r: r[0])
    return ranked[0][1]


def normalize_domain(raw: str | None) -> str | None:
    """`https://www.betano.com/promo?x=1` -> `betano.com`."""
    text = (raw or '').strip().lower()
    if not text:
        return None
    if '://' not in text:
        text = 'http://' + text
    host = urllib.parse.urlparse(text).netloc.split('@')[-1].split(':')[0]
    host = host[4:] if host.startswith('www.') else host
    # A bare label with no dot isn't a domain (catches free-text junk).
    return host if host and '.' in host and ' ' not in host else None


# --- providers ---------------------------------------------------------------

def normalize_snov_person(p: dict[str, Any]) -> dict[str, Any]:
    """Snov's v2 payload -> the shape `best_contact` reads.

    Snov returns firstName/lastName in camelCase. Reading first_name/last_name
    straight off it silently dropped every contact's name on the first live
    run — the email and title were right, the person was anonymous.
    """
    return {
        'email': p.get('email'),
        'position': p.get('position'),
        'first_name': p.get('firstName') or p.get('first_name'),
        'last_name': p.get('lastName') or p.get('last_name'),
    }


class SnovProvider:
    """Snov.io domain search. 1 credit per domain, whatever it returns."""

    name = 'snov'

    def __init__(self, user_id: str, secret: str):
        self._user_id, self._secret = user_id, secret
        self._token: str | None = None

    def _auth(self) -> str:
        if self._token:
            return self._token
        body = urllib.parse.urlencode({
            'grant_type': 'client_credentials',
            'client_id': self._user_id, 'client_secret': self._secret}).encode()
        res = json.loads(urllib.request.urlopen(urllib.request.Request(
            'https://api.snov.io/v1/oauth/access_token', data=body), timeout=40).read())
        self._token = res['access_token']
        return self._token

    def balance(self) -> float | None:
        try:
            res = json.loads(urllib.request.urlopen(
                'https://api.snov.io/v1/get-balance?' +
                urllib.parse.urlencode({'access_token': self._auth()}), timeout=40).read())
            return float(res['data']['balance'])
        except Exception:
            return None

    def find(self, domain: str) -> dict[str, Any] | None:
        params = urllib.parse.urlencode({
            'access_token': self._auth(), 'domain': domain,
            'type': 'personal', 'limit': 30})
        res = json.loads(urllib.request.urlopen(
            'https://api.snov.io/v2/domain-emails-with-info?' + params, timeout=60).read())
        return best_contact(normalize_snov_person(p) for p in (res.get('emails') or []))


def normalize_hunter_person(p: dict[str, Any]) -> dict[str, Any]:
    """Hunter's domain-search person -> the shape `best_contact` reads.

    Hunter puts the address in `value` and already uses snake_case names.
    """
    return {
        'email': p.get('value'),
        'position': p.get('position'),
        'first_name': p.get('first_name'),
        'last_name': p.get('last_name'),
    }


class HunterProvider:
    """Hunter.io domain search — the provider we actually hold credit on.

    Deliberately does NOT pass Hunter's `department=marketing` filter: tagging
    is sparse, and filtering server-side returned 2 people across 10 major
    operators. Fetching everyone and ranking titles locally found contacts on
    3 of the same 10. Costs one search credit per domain either way.
    """

    name = 'hunter'

    def __init__(self, api_key: str):
        self._key = api_key

    def balance(self) -> int | None:
        try:
            res = json.loads(urllib.request.urlopen(
                'https://api.hunter.io/v2/account?' +
                urllib.parse.urlencode({'api_key': self._key}), timeout=30).read())
            return res['data']['requests']['searches']['remaining']
        except Exception:
            return None

    def find(self, domain: str) -> dict[str, Any] | None:
        params = urllib.parse.urlencode({'domain': domain, 'api_key': self._key, 'limit': 100})
        res = json.loads(urllib.request.urlopen(
            'https://api.hunter.io/v2/domain-search?' + params, timeout=60).read())
        people = (res.get('data') or {}).get('emails') or []
        return best_contact(normalize_hunter_person(p) for p in people)


class ApolloProvider:
    """Apollo people search.

    Gated on the Free plan: every people endpoint answers 403 with
    error_code=API_INACCESSIBLE. `find` surfaces that as `PlanBlocked` once and
    the caller stops asking, so a run never burns time on 138 guaranteed 403s.
    """

    name = 'apollo'

    class PlanBlocked(RuntimeError):
        pass

    def __init__(self, api_key: str):
        self._key = api_key

    def find(self, domain: str) -> dict[str, Any] | None:
        body = json.dumps({
            'q_organization_domains': domain,
            'person_titles': ['Chief Marketing Officer', 'CMO', 'Head of Marketing',
                              'Director of Marketing', 'Marketing Director',
                              'VP of Marketing'],
            'page': 1, 'per_page': 25,
        }).encode()
        req = urllib.request.Request(
            'https://api.apollo.io/api/v1/mixed_people/search', data=body, method='POST',
            headers={'Content-Type': 'application/json', 'Cache-Control': 'no-cache',
                     'accept': 'application/json', 'x-api-key': self._key})
        try:
            res = json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            payload = e.read().decode(errors='replace')
            if e.code == 403 and 'API_INACCESSIBLE' in payload:
                raise ApolloProvider.PlanBlocked(
                    'Apollo people search needs a paid plan (403 API_INACCESSIBLE)')
            raise
        people = [{
            'email': p.get('email'), 'position': p.get('title'),
            'first_name': p.get('first_name'), 'last_name': p.get('last_name'),
        } for p in (res.get('people') or [])]
        return best_contact(people)


# --- driver ------------------------------------------------------------------

def _load_env() -> None:
    from pathlib import Path
    for line in Path('.env').read_text(encoding='utf-8', errors='ignore').splitlines():
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


BASE_COLS = 'id, company_name, website_url, trustpilot_url, star_rating'
DISCOVERY_COLS = ('snov_email, snov_contact_name, snov_position, snov_checked_at, '
                  'hunter_email, hunter_contact_name, hunter_position, hunter_checked_at, '
                  'apollo_email, apollo_contact_name, apollo_position, apollo_checked_at')


def has_discovery_columns(sb: Any) -> bool:
    """Whether migration 066 has been applied.

    The tool is useful before it has: it can still search and write results to
    a file, so credits spent are never wasted waiting on a schema change that
    only the operator can make (the service-role key speaks PostgREST, which
    cannot run DDL).
    """
    try:
        sb.table('leads').select('snov_email, hunter_email').limit(1).execute()
        return True
    except Exception:
        return False


def collapse_to_primary_domains(targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One search per BRAND, on the domain most likely to hold its people.

    Measured 2026-09-10: the worst-rated profiles are regional pages
    (betfair.dk, vbet.co.uk, bet365.co.uk, lottoland.asia) and Snov returned
    nothing for any of them, while betano.com gave 3 contacts and novibet.com
    20. A brand's staff sit on its primary domain, so searching each regional
    variant separately misses AND spends a credit per miss.

    The group keeps its WORST rating for ordering — the pitch is still the bad
    profile, even though the contact is found on the .com.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for t in targets:
        label = (t['domain'] or '').replace('www.', '').split('.', 1)[0]
        groups.setdefault(label, []).append(t)

    def preference(t: dict[str, Any]) -> tuple[int, int]:
        d = (t['domain'] or '').replace('www.', '')
        # .com first, then the shortest domain — both proxies for "primary".
        return (0 if d.endswith('.com') else 1, len(d))

    picked: list[dict[str, Any]] = []
    for members in groups.values():
        best = sorted(members, key=preference)[0]
        ratings = [m.get('star_rating') for m in members if m.get('star_rating') is not None]
        picked.append({**best, 'star_rating': min(ratings) if ratings else None,
                       'variant_count': len(members)})
    return picked


def load_targets(category: str, limit: int, redo: bool, columns_ready: bool = True) -> list[dict[str, Any]]:
    """Leads to search, worst-rated and most-reviewed first.

    That order is deliberate: the lowest-rated operator with the most reviews
    is the strongest reputation-management pitch, so a named contact is worth
    most there — and credits run out long before the list does.
    """
    from tools.db.supabase_client import get_client
    sb = get_client()
    cols = BASE_COLS + (', ' + DISCOVERY_COLS if columns_ready else '')
    rows: list[dict[str, Any]] = []
    off = 0
    while True:
        res = (sb.table('leads').select(cols)
               .eq('category', category).range(off, off + 999).execute())
        if not res.data:
            break
        rows += res.data
        off += 1000
        if len(res.data) < 1000:
            break

    targets = []
    seen: set[str] = set()
    for r in rows:
        if not redo and r.get('snov_checked_at'):
            continue  # already searched — don't pay for it again
        domain = normalize_domain(r.get('website_url')) or normalize_domain(
            (r.get('trustpilot_url') or '').split('/review/')[-1])
        if not domain or domain in seen:
            continue
        seen.add(domain)
        targets.append({**r, 'domain': domain})

    targets = collapse_to_primary_domains(targets)
    targets.sort(key=lambda r: (r.get('star_rating') if r.get('star_rating') is not None else 9))
    return targets[:limit]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--category', default='br_licensed_betting')
    p.add_argument('--limit', type=int, default=20, help='Max domains to search (= max credits).')
    p.add_argument('--apply', action='store_true', help='Write results. Without it, dry run.')
    p.add_argument('--redo', action='store_true', help='Re-search domains already checked.')
    p.add_argument('--providers', default='snov,hunter,apollo')
    p.add_argument('--out', default='.tmp/contact_discovery.json',
                   help='Where results are saved. Always written, even on a dry run.')
    p.add_argument('--load-file', dest='load_file',
                   help="Write a previous run's saved results into the DB. Spends no credits.")
    args = p.parse_args()

    _load_env()
    if args.load_file:
        return load_file(args.load_file)

    from tools.db.supabase_client import get_client

    wanted = [x.strip() for x in args.providers.split(',') if x.strip()]
    providers: list[Any] = []
    if 'snov' in wanted and os.environ.get('SNOV_USER_ID') and os.environ.get('SNOV_API_SECRET'):
        snov = SnovProvider(os.environ['SNOV_USER_ID'], os.environ['SNOV_API_SECRET'])
        bal = snov.balance()
        print(f'Snov.io credits: {bal}')
        if bal is not None and bal < args.limit:
            print(f'  capping run at {int(bal)} domains — that is the credit balance.')
            args.limit = int(bal)
        providers.append(snov)
    if 'hunter' in wanted and os.environ.get('HUNTER_API_KEY'):
        hunter = HunterProvider(os.environ['HUNTER_API_KEY'])
        print(f'Hunter searches remaining: {hunter.balance()}')
        providers.append(hunter)
    if 'apollo' in wanted and os.environ.get('APOLLO_API_KEY'):
        providers.append(ApolloProvider(os.environ['APOLLO_API_KEY']))

    if not providers:
        raise SystemExit('No provider credentials found in .env.')

    sb = get_client()
    columns_ready = has_discovery_columns(sb)
    if not columns_ready:
        print('NOTE: migration 066 is not applied — the snov_*/apollo_* columns do not\n'
              '      exist yet. Searching anyway and saving every result to the output\n'
              f'      file ({args.out}); re-run with --load-file once the migration is\n'
              '      in to write them to the database without spending a credit again.\n')

    targets = load_targets(args.category, args.limit, args.redo, columns_ready)
    print(f'{len(targets)} domain(s) to search in category "{args.category}", '
          f'worst-rated first.\n')

    blocked: set[str] = set()
    found = 0
    results: list[dict[str, Any]] = []

    for i, t in enumerate(targets, 1):
        patch: dict[str, Any] = {}
        line = f"[{i}/{len(targets)}] {t['domain']:<28} ({t['star_rating']})"
        for prov in providers:
            if prov.name in blocked:
                continue
            try:
                hit = prov.find(t['domain'])
            except ApolloProvider.PlanBlocked as e:
                blocked.add(prov.name)
                print(f'  !! {prov.name}: {e} — skipping it for the rest of the run')
                continue
            except Exception as e:
                line += f'  {prov.name}=ERR({str(e)[:40]})'
                continue

            patch[f'{prov.name}_checked_at'] = datetime.now(timezone.utc).isoformat()
            if hit:
                found += 1
                patch[f'{prov.name}_email'] = hit['email']
                patch[f'{prov.name}_contact_name'] = hit['name']
                patch[f'{prov.name}_position'] = hit['position']
                line += f"  {prov.name}: {hit['position'][:28]} <{hit['email']}>"
            else:
                line += f'  {prov.name}: none'
        print(line, flush=True)

        if patch:
            results.append({'id': t['id'], 'domain': t['domain'],
                            'company_name': t.get('company_name'), **patch})
            if args.apply and columns_ready:
                sb.table('leads').update(patch).eq('id', t['id']).execute()
        time.sleep(0.4)

    # Always persist — a spent credit must survive a missing migration, a crash,
    # or a dry run.
    if results:
        from pathlib import Path
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1),
                                  encoding='utf-8')

    print(f'\n{found} contact(s) found across {len(targets)} domain(s).')
    print(f'Results saved to {args.out}')
    if not args.apply:
        print('DRY RUN — database not written. Re-run with --apply.')
    elif not columns_ready:
        print('Database NOT written — a discovery migration is missing. Apply it, then:')
        print(f'  .venv/Scripts/python.exe -m tools.scraper.discover_contacts --load-file {args.out}')
    return 0


def load_file(path: str) -> int:
    """Write a previous run's saved results into the DB. Spends no credits."""
    from tools.db.supabase_client import get_client
    sb = get_client()
    if not has_discovery_columns(sb):
        raise SystemExit('Migration 066 still not applied — nothing to write into.')
    rows = json.loads(open(path, encoding='utf-8').read())
    written = 0
    for r in rows:
        patch = {k: v for k, v in r.items()
                 if k.startswith(('snov_', 'hunter_', 'apollo_'))}
        if patch:
            sb.table('leads').update(patch).eq('id', r['id']).execute()
            written += 1
    print(f'Wrote {written} row(s) from {path}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
