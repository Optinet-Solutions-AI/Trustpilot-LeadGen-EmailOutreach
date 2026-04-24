/**
 * Translate structured progress events from the scrape/enrich SSE stream into
 * friendly plain-English log lines. The backend emits terse pipe-delimited
 * detail strings — keeping translation on the frontend lets us iterate on
 * wording without redeploying the API.
 *
 * Each translated entry carries a `kind` that drives color + iconography.
 */

import type { ScrapeProgress } from '../../types/scrape';

export type FeedKind = 'info' | 'progress' | 'success' | 'warn' | 'error' | 'phase';

export interface FeedLine {
  kind: FeedKind;
  text: string;
  timestamp?: string;
}

// Stages we never want to show as their own log line — they're purely numeric
// updaters consumed by the progress bar / summary cards.
const SILENT_STAGES = new Set([
  'profile_progress',
  'enrich_progress',
  'upsert_progress',
  'verify_batch_start',
  'current',
]);

// Human-readable labels for known blockReasons / reason codes. Keeps the
// log user-friendly — a non-technical reader shouldn't see "cloudflare_challenge".
const REASON_LABEL: Record<string, string> = {
  cloudflare_challenge: 'security wall (Cloudflare)',
  access_denied: 'access denied (403)',
  bot_detected: 'bot-check blocked us',
  empty_page: 'page loaded but was empty',
  nav_error: 'could not reach the site',
  invalid_url: 'the URL was invalid',
  deadline_exceeded: 'took too long, moving on',
  per_lead_deadline: 'took too long, moving on',
  timeout: 'took too long to respond',
  error: 'ran into an unexpected issue',
};

function labelReason(code: string): string {
  if (!code) return 'unexpected issue';
  // Strip wrapping prefixes the TS enricher sometimes adds (e.g. "error:TimeoutError: ...")
  const cleaned = code.replace(/^error:/, '').trim();
  // Partial-match lookup — block reasons occasionally include extra context
  for (const key of Object.keys(REASON_LABEL)) {
    if (cleaned.includes(key)) return REASON_LABEL[key];
  }
  return cleaned.slice(0, 80) || 'unexpected issue';
}

function splitPipes(detail: string): string[] {
  return detail.split('|');
}

function splitFraction(detail: string): { current: number; total: number } | null {
  if (!detail.includes('/')) return null;
  const [a, b] = detail.split('/').map((s) => parseInt(s, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return { current: a, total: b };
}

/**
 * Translate a single SSE event into a user-facing feed line. Returns null
 * when the event is silent (numeric updater, noise). Idempotent — called once
 * per event.
 */
export function translate(event: ScrapeProgress): FeedLine | null {
  const { stage, detail = '', timestamp } = event;
  if (SILENT_STAGES.has(stage)) return null;

  switch (stage) {
    case 'started':
      return { kind: 'phase', text: 'Starting up — preparing the scraper…', timestamp };

    case 'category_progress': {
      // detail = "{page}:{running_total}"
      const [page, total] = detail.split(':');
      return {
        kind: 'progress',
        text: `Looking through listings — on page ${page}, ${total} companies found so far`,
        timestamp,
      };
    }
    case 'category_page_done': {
      // detail = "{page}|{found_on_page}|{total_so_far}"
      const [page, onPage, total] = splitPipes(detail);
      return {
        kind: 'progress',
        text: `Finished page ${page} — added ${onPage} more companies (${total} total)`,
        timestamp,
      };
    }
    case 'category_done':
      return {
        kind: 'success',
        text: `Found ${detail} companies matching your filter`,
        timestamp,
      };

    case 'dedup_start':
      return {
        kind: 'info',
        text: `Checking ${detail} companies against ones you've already scraped…`,
        timestamp,
      };
    case 'dedup_done': {
      const [skip, total] = detail.split('/').map((s) => parseInt(s, 10));
      const newOnes = Math.max((total || 0) - (skip || 0), 0);
      return {
        kind: 'success',
        text: `Ready to scrape ${newOnes} new companies (${skip || 0} already in your list)`,
        timestamp,
      };
    }

    case 'profile_start': {
      // detail = "{idx}|{total}|{slug}"
      const [, , slug] = splitPipes(detail);
      return { kind: 'info', text: `Scanning ${slug}…`, timestamp };
    }
    case 'profile_saved': {
      // detail = "{idx}|{total}|{slug}|{email_src}|{shot_flag}|{site_flag}"
      const [idx, total, slug, emailSrc, shotFlag, siteFlag] = splitPipes(detail);
      const parts: string[] = [];
      if (emailSrc === 'trustpilot') parts.push('got email from Trustpilot');
      else if (siteFlag === 'site') parts.push('no Trustpilot email, but found their website');
      else parts.push('no contact info on profile');
      if (shotFlag === 'shot') parts.push('saved screenshot');
      return {
        kind: emailSrc === 'trustpilot' ? 'success' : 'info',
        text: `(${idx}/${total}) Saved ${slug} — ${parts.join(', ')}`,
        timestamp,
      };
    }
    case 'profile_done':
      return { kind: 'success', text: `Finished profile scraping — ${detail} companies processed`, timestamp };

    case 'checkpoint_save':
      return { kind: 'phase', text: 'Saving everything to your database…', timestamp };
    case 'checkpoint_done':
      return { kind: 'success', text: 'Profile data saved to your database', timestamp };
    case 'partial_save':
      return { kind: 'info', text: detail || 'Saved a batch of leads so far', timestamp };
    case 'partial_flush':
      // Python writes a partial results file every N profiles; surface that so
      // the user knows we're resilient to a mid-run crash.
      return {
        kind: 'info',
        text: `Checkpointed ${detail} profiles to disk — safe against interruptions`,
        timestamp,
      };

    case 'enrich_start':
      if (detail && /^\d+$/.test(detail)) {
        return { kind: 'phase', text: `Starting website enrichment for ${detail} leads…`, timestamp };
      }
      return { kind: 'phase', text: 'Starting website enrichment…', timestamp };
    case 'enrich_start_item': {
      // detail = "{idx}|{total}|{domain}"
      const [idx, total, domain] = splitPipes(detail);
      return { kind: 'info', text: `(${idx}/${total}) Visiting ${domain}…`, timestamp };
    }
    case 'enrich_email': {
      // detail = "{idx}|{total}|{domain}|{email}|{tier}"
      const [idx, total, domain, email, tier] = splitPipes(detail);
      const mxNote = tier === 'mx' ? ' (couldn\'t scrape page, but domain accepts mail)' : '';
      return {
        kind: 'success',
        text: `(${idx}/${total}) ${domain} — got ${email}${mxNote}`,
        timestamp,
      };
    }
    case 'enrich_no_email': {
      // detail = "{idx}|{total}|{domain}|{reason?}"
      const [idx, total, domain, reason] = splitPipes(detail);
      const reasonSuffix = reason ? ` (${labelReason(reason)})` : '';
      return {
        kind: 'warn',
        text: `(${idx}/${total}) ${domain} — no public contact email found${reasonSuffix}`,
        timestamp,
      };
    }
    case 'enrich_timeout':
      return { kind: 'warn', text: `Enrichment ran out of time — ${detail}`, timestamp };
    case 'enrich_done': {
      const found = parseInt(detail, 10) || 0;
      return {
        kind: found > 0 ? 'success' : 'warn',
        text: found > 0
          ? `Website enrichment done — found ${found} new email${found === 1 ? '' : 's'}`
          : 'Website enrichment done — no new emails found this round',
        timestamp,
      };
    }

    case 'item_failed': {
      // detail = "{stage}|{url}|{reason_code}|{msg}"
      const [itemStage, url, reasonCode] = splitPipes(detail);
      const friendlyReason = labelReason(reasonCode);
      const who = url || (itemStage === 'profile' ? 'a profile' : 'a website');
      return {
        kind: 'error',
        text: `${who} — ${friendlyReason}. Moving to next lead.`,
        timestamp,
      };
    }

    case 'final_save':
      return { kind: 'phase', text: 'Saving enriched data…', timestamp };
    case 'upsert_done': {
      const saved = detail.split('/')[0] || detail;
      return { kind: 'success', text: `Saved ${saved} leads to the database`, timestamp };
    }

    case 'completed': {
      try {
        const m = JSON.parse(detail) as {
          saved?: number;
          skipped?: number;
          enriched?: number;
          failed?: number;
        };
        const bits: string[] = [];
        if (typeof m.saved === 'number') bits.push(`saved ${m.saved}`);
        if (m.skipped && m.skipped > 0) bits.push(`skipped ${m.skipped} duplicate${m.skipped === 1 ? '' : 's'}`);
        if (m.enriched && m.enriched > 0) bits.push(`found ${m.enriched} email${m.enriched === 1 ? '' : 's'}`);
        if (m.failed && m.failed > 0) bits.push(`${m.failed} need${m.failed === 1 ? 's' : ''} a look`);
        return { kind: 'success', text: `All done — ${bits.join(', ')}`, timestamp };
      } catch {
        return { kind: 'success', text: detail || 'All done', timestamp };
      }
    }

    // ── Verify stages ──────────────────────────────────────────────────────
    case 'verify_start':
      return { kind: 'phase', text: `Starting email verification for ${detail} address${parseInt(detail) === 1 ? '' : 'es'}…`, timestamp };

    case 'verify_batch_done': {
      // detail = "{batchNum}|{totalBatches}|{done}|{total}"
      const [batchNum, totalBatches, done, total] = splitPipes(detail);
      if (totalBatches === '1') {
        return { kind: 'success', text: `Verified all ${total} emails`, timestamp };
      }
      return { kind: 'success', text: `Batch ${batchNum} of ${totalBatches} done — ${done} of ${total} checked`, timestamp };
    }

    case 'verify_saving':
      return { kind: 'phase', text: `Saving verification results to your database…`, timestamp };

    case 'failed':
      return { kind: 'error', text: `Stopped — ${detail || 'something went wrong'}`, timestamp };
    case 'error':
      return { kind: 'error', text: detail || 'Unknown error', timestamp };

    default:
      // Unknown stage — fall back to raw detail so nothing is silently dropped
      return { kind: 'info', text: detail || stage, timestamp };
  }
}

/**
 * Summary counters derived from the event stream. Drives the phase cards.
 */
export interface JobSummary {
  companiesFound: number;
  profilesProcessed: number;
  profilesTotal: number;
  emailsCaptured: number;
  sitesChecked: number;
  sitesTotal: number;
  emailsFound: number;
  failures: number;
  // verify-specific
  verifiesChecked: number;
  verifiesTotal: number;
  verifiesValid: number;
  verifiesInvalid: number;
  verifiedCatchAll: number;
  currentPhase: 'idle' | 'category' | 'dedup' | 'profile' | 'checkpoint' | 'enrich' | 'verify' | 'final' | 'done' | 'failed';
}

const EMPTY_SUMMARY: JobSummary = {
  companiesFound: 0,
  profilesProcessed: 0,
  profilesTotal: 0,
  emailsCaptured: 0,
  sitesChecked: 0,
  sitesTotal: 0,
  emailsFound: 0,
  failures: 0,
  verifiesChecked: 0,
  verifiesTotal: 0,
  verifiesValid: 0,
  verifiesInvalid: 0,
  verifiedCatchAll: 0,
  currentPhase: 'idle',
};

export function summarize(events: ScrapeProgress[]): JobSummary {
  const s: JobSummary = { ...EMPTY_SUMMARY };

  for (const e of events) {
    switch (e.stage) {
      case 'category_progress': {
        const [, total] = e.detail.split(':');
        const n = parseInt(total, 10);
        if (Number.isFinite(n)) s.companiesFound = Math.max(s.companiesFound, n);
        s.currentPhase = 'category';
        break;
      }
      case 'category_done': {
        const n = parseInt(e.detail, 10);
        if (Number.isFinite(n)) s.companiesFound = n;
        break;
      }
      case 'dedup_start':
        s.currentPhase = 'dedup';
        break;
      case 'dedup_done':
        s.currentPhase = 'dedup';
        break;

      case 'profile_progress': {
        const frac = splitFraction(e.detail);
        if (frac) {
          s.profilesProcessed = frac.current;
          s.profilesTotal = frac.total;
        }
        s.currentPhase = 'profile';
        break;
      }
      case 'profile_saved': {
        const parts = splitPipes(e.detail);
        if (parts[3] === 'trustpilot') s.emailsCaptured++;
        s.currentPhase = 'profile';
        break;
      }
      case 'checkpoint_save':
      case 'checkpoint_done':
        s.currentPhase = 'checkpoint';
        break;

      case 'enrich_start':
        s.currentPhase = 'enrich';
        // `detail` may be an integer (total leads) when a standalone enrich kicks off
        if (e.detail && /^\d+$/.test(e.detail)) {
          s.sitesTotal = parseInt(e.detail, 10);
        }
        break;
      case 'enrich_progress': {
        const frac = splitFraction(e.detail);
        if (frac) {
          s.sitesChecked = frac.current;
          s.sitesTotal = frac.total;
        }
        s.currentPhase = 'enrich';
        break;
      }
      case 'enrich_email':
        s.emailsFound++;
        s.currentPhase = 'enrich';
        break;
      case 'enrich_done': {
        const n = parseInt(e.detail, 10);
        if (Number.isFinite(n)) s.emailsFound = n;
        break;
      }
      case 'item_failed':
        s.failures++;
        break;
      case 'final_save':
        s.currentPhase = 'final';
        break;

      case 'verify_start': {
        s.currentPhase = 'verify';
        const n = parseInt(e.detail, 10);
        if (Number.isFinite(n)) s.verifiesTotal = n;
        break;
      }
      case 'verify_batch_start':
        s.currentPhase = 'verify';
        break;
      case 'verify_batch_done': {
        // detail = "{batchNum}|{totalBatches}|{done}|{total}"
        const parts = splitPipes(e.detail);
        const done = parseInt(parts[2], 10);
        const total = parseInt(parts[3], 10);
        if (Number.isFinite(done)) s.verifiesChecked = done;
        if (Number.isFinite(total)) s.verifiesTotal = total;
        s.currentPhase = 'verify';
        break;
      }
      case 'verify_saving':
        s.currentPhase = 'final';
        break;
      case 'completed': {
        // Handle verify-specific completed payload
        try {
          const m = JSON.parse(e.detail || '{}') as {
            verified?: number;
            invalid?: number;
            catchAll?: number;
            unknown?: number;
            total?: number;
          };
          if (typeof m.verified === 'number') s.verifiesValid = m.verified;
          if (typeof m.invalid === 'number') s.verifiesInvalid = m.invalid;
          if (typeof m.catchAll === 'number') s.verifiedCatchAll = m.catchAll;
          if (typeof m.total === 'number') s.verifiesTotal = m.total;
        } catch { /* non-JSON completed detail is fine */ }
        s.currentPhase = 'done';
        break;
      }
      case 'failed':
        s.currentPhase = 'failed';
        break;
    }
  }
  return s;
}
