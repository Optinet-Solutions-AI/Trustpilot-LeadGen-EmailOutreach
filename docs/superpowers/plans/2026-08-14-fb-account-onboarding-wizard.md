# FB Account Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-technical VA onboard a country-pinned Facebook account from the Vercel app — pick a country, log into FB in a streamed AdsPower browser, click Done — and have that country become selectable for Facebook scraping.

**Architecture:** A new AdsPower "onboarding" variant of the existing `social_accounts` connect state machine. The EC2 worker creates a fresh AdsPower profile (Enigma proxy + chosen country code), streams it into the app via the existing CDP spawner, and on the VA's confirmation flips the account to `active`. Because an AdsPower profile persists its own FB login, there is **no cookie to capture** — activation is just a verify-and-flip. The FB scrape country dropdown then reads the distinct countries of active accounts (Option A).

**Tech Stack:** Python (AdsPower Local API client), Node/Express + TypeScript (API + EC2 worker), Supabase (PostgREST), React + Vite (frontend).

**Spec:** `docs/superpowers/specs/2026-08-14-fb-account-onboarding-wizard-design.md`

## Global Constraints

- Reuse the existing connect state machine (`connect_status: requested → provisioning → ready → captured`) and the AdsPower CDP spawner (`ec2-windows-spawn-adspower-cdp.ps1`); do not build a new transport.
- No Facebook credential storage: the VA logs in inside the streamed browser. Do not add code that receives or persists FB email/password.
- AdsPower profiles are one-per-host: the wizard only ever **creates** new profiles; never open an existing profile id on the EC2 box.
- All Supabase writes go through the service-role client (`getSupabase()`); never from the frontend.
- Worker code runs only on the Windows EC2 host (gated by the existing `ENABLE_SOCIAL_CONNECT_WORKER` env); Cloud Run never talks to AdsPower directly.
- `connect_mode` values in use: `'connect'` (Brave cookie-capture), `'browse'` (AdsPower stream). This plan adds `'onboard'`.

---

## File Structure

- `tools/scraper/shared/adspower.py` — add `create_profile()` (new AdsPower API call).
- `tests/scraper/test_adspower.py` — add `create_profile` tests.
- `server/src/db/social-connect-requests.ts` — add `enqueueOnboardRequest()`, `activateOnboardedAccount()`.
- `server/src/db/social-accounts-countries.ts` (new) — `listActiveCountries()`.
- `server/src/routes/social-accounts.ts` — add `POST /:id?/onboard`… (see Task 3) and `GET /countries`.
- `server/src/worker/social-connect-worker.ts` — add the `onboard` branch (create profile → adspower-cdp stream → activate).
- `frontend/src/hooks/useOnboardAccount.ts` (new) — wizard hook.
- `frontend/src/components/OnboardAccountModal.tsx` (new) — the 3-screen wizard.
- `frontend/src/views/SocialAccounts.tsx` — add the "Add FB Account" entry point.
- `frontend/src/components/ScrapeForm.tsx` — FB country dropdown reads `GET /api/social-accounts/countries`.

---

## Task 1: AdsPower `create_profile()`

**Files:**
- Modify: `tools/scraper/shared/adspower.py`
- Test: `tests/scraper/test_adspower.py`

**Interfaces:**
- Produces: `create_profile(*, name: str, country: str, proxy_config: dict) -> str` — creates an AdsPower profile via `POST /api/v1/user/create` and returns the new `user_id` (profile id). `proxy_config` is the AdsPower `user_proxy_config` dict, built by the caller. Raises `AdsPowerError` on failure.

- [ ] **Step 1: Write the failing test**

```python
def test_create_profile_returns_new_user_id(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    seen = {}

    def capture(url, **kw):
        seen['url'] = url
        seen['json'] = kw.get('json')
        return _Resp(200, {'code': 0, 'data': {'id': 'knewprof1'}})

    # create uses POST, not GET
    monkeypatch.setattr(adspower.requests, 'post', capture)
    pid = adspower.create_profile(
        name='fleet-GB-1',
        country='GB',
        proxy_config={'proxy_soft': 'other', 'proxy_type': 'http',
                      'proxy_host': 'gb.enigma.io', 'proxy_port': '1000',
                      'proxy_user': 'u', 'proxy_password': 'p'},
    )
    assert pid == 'knewprof1'
    assert seen['url'].endswith('/api/v1/user/create')
    assert seen['json']['user_proxy_config']['proxy_host'] == 'gb.enigma.io'
    assert seen['json']['name'] == 'fleet-GB-1'


def test_create_profile_raises_on_api_error(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'post',
                        lambda url, **kw: _Resp(200, {'code': -1, 'msg': 'group not found'}))
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.create_profile(name='x', country='GB', proxy_config={})
    assert 'group not found' in str(exc.value)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py::test_create_profile_returns_new_user_id -v`
Expected: FAIL — `module 'adspower' has no attribute 'create_profile'`.

- [ ] **Step 3: Add a POST-capable `_call_post` and `create_profile`**

`_call` in `adspower.py` currently only does GET. Add a POST variant beside it (mirror its error handling exactly), then `create_profile`:

```python
def _call_post(path: str, body: dict) -> dict:
    _throttle()
    url = f'{_base()}{path}'
    try:
        resp = requests.post(url, json=body, headers=_headers(), timeout=REQUEST_TIMEOUT)
    except requests.exceptions.RequestException as exc:
        raise AdsPowerUnreachable(
            f'Could not reach the AdsPower Local API at {url}. Is the AdsPower '
            f'desktop app running on this host? Underlying error: {exc}'
        ) from exc
    if resp.status_code >= 400:
        raise AdsPowerError(f'AdsPower {path} returned HTTP {resp.status_code}: {resp.text[:200]}')
    try:
        payload = resp.json()
    except ValueError as exc:
        raise AdsPowerError(f'AdsPower {path} returned non-JSON response: {resp.text[:200]}') from exc
    if payload.get('code') != 0:
        raise AdsPowerError(f'AdsPower {path} failed: {payload.get("msg") or payload}')
    return payload.get('data') or {}


def create_profile(*, name: str, country: str, proxy_config: dict) -> str:
    """Create a fresh AdsPower profile bound to a country proxy. Returns the new
    profile id (user_id). The login itself is NOT done here — a human logs into
    Facebook in the streamed browser afterward, and AdsPower persists it in the
    profile. `group_id` '0' = ungrouped; override with ADSPOWER_FLEET_GROUP_ID."""
    group_id = (os.environ.get('ADSPOWER_FLEET_GROUP_ID') or '0').strip()
    body = {
        'name': name,
        'group_id': group_id,
        'user_proxy_config': proxy_config or {'proxy_soft': 'no_proxy'},
        # AdsPower requires a fingerprint_config object; empty = auto-randomised,
        # which is exactly what we want (each account a distinct fingerprint).
        'fingerprint_config': {'automatic_timezone': '1'},
        'remark': f'fleet onboarded country={country}',
    }
    data = _call_post('/api/v1/user/create', body)
    pid = str(data.get('id') or '').strip()
    if not pid:
        raise AdsPowerError(f'AdsPower create returned no profile id. Response: {data}')
    print(f'INFO: AdsPower created profile {pid} (country={country})', file=sys.stderr, flush=True)
    return pid
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_adspower.py -q`
Expected: PASS (all, including the two new tests).

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/shared/adspower.py tests/scraper/test_adspower.py
git commit -m "feat(scraper): add adspower.create_profile for on-demand fleet profiles"
```

---

## Task 2: DB helpers — onboarding enqueue, activate, and active-country list

**Files:**
- Modify: `server/src/db/social-connect-requests.ts`
- Create: `server/src/db/social-accounts-countries.ts`
- Test: `server/src/db/__tests__/social-accounts-countries.test.ts`

**Interfaces:**
- Consumes: `getSupabase()`, `ConnectStatus`, `TTL_MS` (existing).
- Produces:
  - `enqueueOnboardRequest(opts: { country: string; requestedBy: string }) -> Promise<{ accountId: string; sessionId: string }>` — inserts a new `social_accounts` row (`platform:'facebook'`, `country`, `status:'provisioning'`, `connect_mode:'onboard'`, `connect_status:'requested'`) and returns its id + session id.
  - `activateOnboardedAccount(accountId: string) -> Promise<void>` — flips `status:'active'`, `connect_status:'captured'`, `last_login_at`. No cookies.
  - `listActiveCountries() -> Promise<string[]>` — distinct non-null `country` from active facebook accounts.

- [ ] **Step 1: Write the failing test (listActiveCountries)**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { listActiveCountries } from '../social-accounts-countries.js';

vi.mock('../../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ not: () => Promise.resolve({
            data: [{ country: 'GB' }, { country: 'GB' }, { country: 'US' }], error: null }) }),
        }),
      }),
    }),
  }),
}));

describe('listActiveCountries', () => {
  it('returns de-duplicated country codes', async () => {
    const out = await listActiveCountries();
    expect(out.sort()).toEqual(['GB', 'US']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/db/__tests__/social-accounts-countries.test.ts`
Expected: FAIL — cannot find module `../social-accounts-countries.js`.

- [ ] **Step 3: Implement `social-accounts-countries.ts`**

```typescript
import { getSupabase } from '../lib/supabase.js';

/** Distinct countries that have at least one ACTIVE facebook account.
 * Drives the "active markets" FB scrape dropdown (Option A). */
export async function listActiveCountries(): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from('social_accounts')
    .select('country')
    .eq('platform', 'facebook')
    .eq('status', 'active')
    .not('country', 'is', null);
  if (error) throw new Error(`listActiveCountries: ${error.message}`);
  const seen = new Set<string>();
  for (const row of (data as { country: string | null }[]) ?? []) {
    if (row.country) seen.add(row.country);
  }
  return [...seen];
}
```

- [ ] **Step 4: Add `enqueueOnboardRequest` + `activateOnboardedAccount` to `social-connect-requests.ts`**

Append after `finalizeConnectRequest`:

```typescript
export async function enqueueOnboardRequest(
  opts: { country: string; requestedBy: string },
): Promise<{ accountId: string; sessionId: string }> {
  const sb = getSupabase();
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  const { data, error } = await sb
    .from('social_accounts')
    .insert({
      platform: 'facebook',
      country: opts.country,
      status: 'provisioning',
      connect_mode: 'onboard',
      connect_session_id: sessionId,
      connect_status: 'requested' as ConnectStatus,
      connect_requested_by: opts.requestedBy,
      connect_started_at: now.toISOString(),
      connect_expires_at: expires.toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`enqueueOnboardRequest: ${error.message}`);
  return { accountId: (data as { id: string }).id, sessionId };
}

export async function activateOnboardedAccount(accountId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('social_accounts')
    .update({
      status: 'active',
      connect_status: 'captured' as ConnectStatus,
      last_login_at: new Date().toISOString(),
    })
    .eq('id', accountId)
    .eq('connect_mode', 'onboard');
  if (error) throw new Error(`activateOnboardedAccount: ${error.message}`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/db/__tests__/social-accounts-countries.test.ts && npx tsc --noEmit`
Expected: PASS + clean type-check.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/social-connect-requests.ts server/src/db/social-accounts-countries.ts server/src/db/__tests__/social-accounts-countries.test.ts
git commit -m "feat(backend): db helpers for FB account onboarding + active-country list"
```

---

## Task 3: API routes — `POST /onboard` and `GET /countries`

**Files:**
- Modify: `server/src/routes/social-accounts.ts`
- Test: `server/src/routes/__tests__/social-accounts-onboard.test.ts`

**Interfaces:**
- Consumes: `enqueueOnboardRequest`, `activateOnboardedAccount`, `getConnectRequestStatus` (Task 2 + existing), `listActiveCountries` (Task 2).
- Produces HTTP:
  - `POST /api/social-accounts/onboard` body `{ country: string }` → `{ success: true, data: { accountId } }`.
  - `GET  /api/social-accounts/:id/connect-status` — already exists; reused by the wizard to poll for the tunnel URL.
  - `POST /api/social-accounts/:id/onboard-complete` → calls `activateOnboardedAccount`, `{ success: true }`.
  - `GET  /api/social-accounts/countries` → `{ success: true, data: { countries: string[] } }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../db/social-connect-requests.js', () => ({
  enqueueOnboardRequest: vi.fn(async () => ({ accountId: 'acc-1', sessionId: 's-1' })),
  activateOnboardedAccount: vi.fn(async () => {}),
}));
vi.mock('../../db/social-accounts-countries.js', () => ({
  listActiveCountries: vi.fn(async () => ['GB', 'US']),
}));

import router from '../social-accounts.js';

function app() { const a = express(); a.use(express.json()); a.use('/api/social-accounts', router); return a; }

describe('onboarding routes', () => {
  it('POST /onboard requires a country', async () => {
    const res = await request(app()).post('/api/social-accounts/onboard').send({});
    expect(res.status).toBe(400);
  });
  it('POST /onboard returns the new account id', async () => {
    const res = await request(app()).post('/api/social-accounts/onboard').send({ country: 'GB' });
    expect(res.body.data.accountId).toBe('acc-1');
  });
  it('GET /countries returns the active markets', async () => {
    const res = await request(app()).get('/api/social-accounts/countries');
    expect(res.body.data.countries).toEqual(['GB', 'US']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/__tests__/social-accounts-onboard.test.ts`
Expected: FAIL — routes 404 (not yet defined).

- [ ] **Step 3: Add the routes to `social-accounts.ts`**

Add near the other routes (import the new helpers at the top). Register `GET /countries` **before** any `/:id` route so `countries` is not parsed as an id:

```typescript
import { enqueueOnboardRequest, activateOnboardedAccount } from '../db/social-connect-requests.js';
import { listActiveCountries } from '../db/social-accounts-countries.js';

// GET distinct active-account countries (drives the FB scrape dropdown, Option A).
router.get('/countries', async (_req: Request, res: Response) => {
  try {
    const countries = await listActiveCountries();
    res.json({ success: true, data: { countries } });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// Start onboarding a NEW country-pinned FB account (creates the row; the EC2
// worker does the AdsPower profile creation + stream).
router.post('/onboard', async (req: Request, res: Response) => {
  const country = String(req.body?.country ?? '').trim();
  if (!country) {
    return res.status(400).json({ success: false, error: 'country is required' });
  }
  try {
    const requestedBy = String(req.body?.requestedBy ?? 'va');
    const { accountId } = await enqueueOnboardRequest({ country, requestedBy });
    res.json({ success: true, data: { accountId } });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

// VA clicked "Done" in the streamed browser — verify + activate.
router.post('/:id/onboard-complete', async (req: Request, res: Response) => {
  try {
    await activateOnboardedAccount(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});
```

- [ ] **Step 4: Run tests + type-check**

Run: `cd server && npx vitest run src/routes/__tests__/social-accounts-onboard.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/social-accounts.ts server/src/routes/__tests__/social-accounts-onboard.test.ts
git commit -m "feat(backend): onboarding + active-countries API routes"
```

---

## Task 4: Worker — the `onboard` branch (create profile → stream → wait)

**Files:**
- Modify: `server/src/worker/social-connect-worker.ts`
- Test: `server/src/worker/__tests__/onboard-branch.test.ts`

**Interfaces:**
- Consumes: `claimPendingConnectRequest`, `updateConnectStatus` (existing), `create_profile` via a spawned Python call, `SPAWN_SCRIPT_ADSPOWER_CDP` (existing const).
- Produces: when the worker claims a `connect_mode='onboard'` row, it (1) creates the AdsPower profile via `python -m tools.scraper.fleet_session` (see Step 3), (2) writes `adspower_profile_id`, (3) spawns `ec2-windows-spawn-adspower-cdp.ps1` for that profile, (4) writes `connect_tunnel_url` + `connect_status='ready'`. Activation happens via the API route (Task 3), not the worker.

**Design note:** the worker already spawns `SPAWN_SCRIPT_ADSPOWER_CDP` for browse mode. The onboard branch differs only in: it first **creates** a profile (browse opens an existing one), and it does **not** capture cookies (activation is the VA's Done click). Add a Python CLI for create so the worker stays a thin orchestrator.

- [ ] **Step 1: Add a `--create` action to `fleet_session.py` (Python side first)**

Test in `tests/scraper/test_fleet_session.py`:

```python
def test_create_prints_new_profile_id(monkeypatch, capsys):
    monkeypatch.setattr(fs.adspower, 'create_profile', lambda **kw: 'knew1')
    rc = fs.main_with_args(['--create', '--country', 'GB', '--proxy-json', '{}'])
    assert rc == 0
    assert capsys.readouterr().out.strip() == 'knew1'
```

Implement in `fleet_session.py`: add `--create`, `--country`, `--proxy-json` args; when `--create`, call `adspower.create_profile(name=f'fleet-{country}-{shortid}', country=country, proxy_config=json.loads(proxy_json or '{}'))` and `print(pid)`. (Refactor `main()` body into `main_with_args(argv)` so it is testable, and have `main()` call `main_with_args(sys.argv[1:])`.)

Run: `.venv/Scripts/python.exe -m pytest tests/scraper/test_fleet_session.py -q` → PASS.

- [ ] **Step 2: Write the failing worker test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildOnboardSteps } from '../onboard-branch.js';

describe('onboard branch', () => {
  it('creates a profile, records the id, then requests the stream', async () => {
    const calls: string[] = [];
    const deps = {
      createProfile: vi.fn(async () => { calls.push('create'); return 'knew1'; }),
      recordProfileId: vi.fn(async (_id: string, pid: string) => { calls.push(`record:${pid}`); }),
      spawnStream: vi.fn(async () => { calls.push('spawn'); return 'https://t.example'; }),
      setReady: vi.fn(async (_id: string, url: string) => { calls.push(`ready:${url}`); }),
    };
    await buildOnboardSteps({ accountId: 'a1', country: 'GB', proxyJson: '{}' }, deps);
    expect(calls).toEqual(['create', 'record:knew1', 'spawn', 'ready:https://t.example']);
  });
});
```

- [ ] **Step 3: Extract `buildOnboardSteps` into `server/src/worker/onboard-branch.ts`**

```typescript
export interface OnboardDeps {
  createProfile: (country: string, proxyJson: string) => Promise<string>;
  recordProfileId: (accountId: string, profileId: string) => Promise<void>;
  spawnStream: (accountId: string, profileId: string) => Promise<string>;
  setReady: (accountId: string, tunnelUrl: string) => Promise<void>;
}

export async function buildOnboardSteps(
  job: { accountId: string; country: string; proxyJson: string },
  deps: OnboardDeps,
): Promise<void> {
  const profileId = await deps.createProfile(job.country, job.proxyJson);
  await deps.recordProfileId(job.accountId, profileId);
  const tunnelUrl = await deps.spawnStream(job.accountId, profileId);
  await deps.setReady(job.accountId, tunnelUrl);
}
```

- [ ] **Step 4: Run the worker test → PASS**

Run: `cd server && npx vitest run src/worker/__tests__/onboard-branch.test.ts`

- [ ] **Step 5: Wire `buildOnboardSteps` into `pollOnce`**

In `social-connect-worker.ts`, after claiming a request, branch on `connect_mode`. For `'onboard'`, build the concrete deps:
- `createProfile`: `spawn(PYTHON, ['-m','tools.scraper.fleet_session','--create','--country',country,'--proxy-json',proxyJson], {cwd: config.projectRoot})`, resolve the trimmed stdout as the profile id. **Attach `.on('error')`** (ENOENT would crash the worker — mirror the existing `finishSession` handler).
- `recordProfileId`: `getSupabase().from('social_accounts').update({ adspower_profile_id: profileId }).eq('id', accountId)`.
- `spawnStream`: reuse the existing adspower-cdp spawn path (the same one browse mode uses via `SPAWN_SCRIPT_ADSPOWER_CDP`), passing the new `profileId`; resolve the tunnel URL from its stdout as browse mode already does.
- `setReady`: `updateConnectStatus(accountId, { connect_status: 'ready', connect_tunnel_url: tunnelUrl })`.
Build `proxyJson` from the account's country using the same proxy wiring browse/connect already use for `proxy_location` (read the existing proxy-config builder in the worker/`social-routing.ts`; do not invent new env names). Wrap the whole branch in try/catch → on error `updateConnectStatus(accountId, { connect_status: 'failed', connect_error: String(err) })`.

- [ ] **Step 6: Type-check + run all worker tests**

Run: `cd server && npx tsc --noEmit && npx vitest run src/worker`
Expected: clean + PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/worker/social-connect-worker.ts server/src/worker/onboard-branch.ts server/src/worker/__tests__/onboard-branch.test.ts tools/scraper/fleet_session.py tests/scraper/test_fleet_session.py
git commit -m "feat(backend): worker onboard branch — create AdsPower profile then stream it"
```

---

## Task 5: Frontend — the onboarding wizard

**Files:**
- Create: `frontend/src/hooks/useOnboardAccount.ts`
- Create: `frontend/src/components/OnboardAccountModal.tsx`
- Modify: `frontend/src/views/SocialAccounts.tsx`

**Interfaces:**
- Consumes: `POST /api/social-accounts/onboard`, `GET /api/social-accounts/:id/connect-status`, `POST /api/social-accounts/:id/onboard-complete`.
- Produces: an "Add FB Account" button in `SocialAccounts.tsx` that opens `OnboardAccountModal`.

**Before writing:** read `frontend/src/hooks/useBrowseSession.ts` and the connect UI in `frontend/src/views/SocialAccounts.tsx` — the wizard mirrors their polling + embedded-iframe pattern. Match their fetch/error/loading conventions exactly.

- [ ] **Step 1: Implement `useOnboardAccount.ts`**

A hook exposing `start(country)`, `status`, `tunnelUrl`, `complete()`, `error`, `loading`. `start` POSTs `/onboard`, stores `accountId`, then polls `GET /:id/connect-status` every 2s until `connect_status==='ready'` (sets `tunnelUrl`) or `'failed'` (sets `error`). `complete` POSTs `/:id/onboard-complete`. Mirror the polling in `useBrowseSession.ts` (same interval, same cleanup-on-unmount).

- [ ] **Step 2: Implement `OnboardAccountModal.tsx` (3 screens)**

1. **Pick country** — a country `<select>` (reuse the country list component the app already uses; if none, a plain ISO-code select) → "Create" calls `start(country)`.
2. **Log in** — while `status!=='ready'` show "Setting up your browser…"; once `tunnelUrl` is set, embed it in an `<iframe>` (same as the browse view) with an "Open in new tab" link (for captcha) and a note "Log into Facebook, then click Done".
3. **Done** — a "Done" button calls `complete()`, then closes the modal and refreshes the accounts list.

- [ ] **Step 3: Add the entry point in `SocialAccounts.tsx`**

Add an "Add FB Account" button that opens `OnboardAccountModal`; on close, re-fetch the accounts list (reuse the existing refresh).

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useOnboardAccount.ts frontend/src/components/OnboardAccountModal.tsx frontend/src/views/SocialAccounts.tsx
git commit -m "feat(frontend): FB account onboarding wizard (country -> streamed login -> done)"
```

---

## Task 6: FB scrape country dropdown reads active markets

**Files:**
- Modify: `frontend/src/components/ScrapeForm.tsx`
- Test: manual (frontend) — covered by the live smoke below.

**Interfaces:**
- Consumes: `GET /api/social-accounts/countries`.

**Before writing:** read `frontend/src/components/ScrapeForm.tsx` to find how the country field renders for `platform === 'facebook'` today (fixed list vs manifest). Replace only the FB branch's option source.

- [ ] **Step 1: Fetch active countries when platform is facebook**

On mount / when `platform === 'facebook'`, fetch `GET /api/social-accounts/countries` and use `data.countries` as the country dropdown options. Show a hint when the list is empty: "No onboarded Facebook accounts yet — add one on the Social Accounts page." Do not change other platforms' country sources.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ScrapeForm.tsx
git commit -m "feat(frontend): FB scrape country dropdown lists onboarded active markets"
```

---

## Task 7: Live smoke (owner, on the EC2 box)

**Not automated — a real Facebook login cannot be scripted.**

- [ ] **Step 1:** From the Vercel app → Social Accounts → "Add FB Account" → pick a throwaway country.
- [ ] **Step 2:** Confirm the streamed browser opens (AdsPower profile created with the right country proxy — check the profile's IP geolocation).
- [ ] **Step 3:** Log into a throwaway FB account in the stream; solve any captcha via "Open in new tab".
- [ ] **Step 4:** Click Done → confirm the account shows `status='active'` and its country appears in the FB scrape dropdown.
- [ ] **Step 5:** Abandon a second attempt mid-login → confirm the TTL sweep marks it `disabled` and it never enters the dropdown.

---

## Self-Review

- **Spec coverage:** wizard (T5), auto profile creation + proxy country (T1, T4), streamed login + captcha (T5), country appears in dropdown (T3 `/countries`, T6), Option A dropdown (T2 `listActiveCountries`, T6), no credential storage (no cookie capture in T4; login in-stream in T5), error handling — failed create/proxy/abandon (T4 catch, T7 sweep). All covered.
- **Placeholder scan:** none — every step has concrete code or a concrete file+pattern to mirror, with the read-first instruction where frontend patterns must match existing components.
- **Type consistency:** `create_profile(*, name, country, proxy_config) -> str` (T1) is consumed by `fleet_session --create` (T4); `enqueueOnboardRequest`/`activateOnboardedAccount`/`listActiveCountries` (T2) are consumed by the routes (T3); `buildOnboardSteps`/`OnboardDeps` (T4) are internal to the worker; the three endpoints (T3) are consumed by the wizard hook (T5) and the scrape form (T6). Names match across tasks.

## Open item for the executor
Tasks 5 and 6 intentionally say "read the existing component first, then mirror" for the parts that must match unread frontend conventions (fetch wrapper, iframe embed, country picker). This is deliberate: fabricating props/hook names for unread components would be worse than directing the executor to match what's there. All *new* logic is specified as real code.
