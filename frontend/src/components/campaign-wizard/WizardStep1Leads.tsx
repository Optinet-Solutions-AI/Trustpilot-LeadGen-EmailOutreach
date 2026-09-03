'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import api from '../../api/client';
import { COUNTRIES, CATEGORIES } from './scheduleConfig';

interface AppMode {
  manualLeadsOnly: boolean;
  testMode: boolean;
  emailPlatform: string;
  emailMode: string;
}

interface PickerLead {
  id: string;
  company_name: string;
  primary_email: string | null;
  star_rating: number | null;
  outreach_status: string;
  country: string | null;
  category: string | null;
  screenshot_path: string | null;
  verification_status: 'valid' | 'invalid' | 'catch-all' | 'unknown' | null;
}

function buildScreenshotSrc(path: string): string {
  if (path.startsWith('http')) return path;
  const filename = path.split(/[/\\]/).pop() || '';
  return `/api/screenshots/${filename}`;
}

const preloadedScreenshots = new Set<string>();
function preloadScreenshot(src: string): void {
  if (preloadedScreenshots.has(src)) return;
  preloadedScreenshots.add(src);
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
}

interface Props {
  filterCountry: string;
  filterCategory: string;
  /** Outreach language name ('Swedish'), or '' for "any". Selecting one
   *  widens the pool to EVERY market that speaks it — the point being that
   *  one Swedish campaign can cover SE and the Swedish-speaking slice of FI
   *  without running two campaigns. Supersedes filterCountry when set. */
  filterLanguage: string;
  /** Platform slug the campaign targets ('trustpilot' / 'tripadvisor' /
   *  'yelp') — always set; the wizard no longer offers "all platforms" and
   *  defaults to 'trustpilot'. Restricts the lead pool to that platform's
   *  leads; the backend /leads route filters via the lead_platform_presences
   *  join. */
  filterPlatform: string;
  selectedLeadIds: string[];
  manualEmails: string[];
  maxLeads: number;
  /** When true, the picker only shows leads where redirects_to IS NOT NULL.
   *  When false (default), redirected leads are excluded from the picker so
   *  users can't accidentally mix them with the standard cold-outreach pool —
   *  they need different messaging and a different AI prompt. */
  redirectMode?: boolean;
  /** Wizard launched from Prospects → Accepted with leadIds pre-supplied.
   *  Pre-selected discovered-contact leads typically have outreach_status
   *  = 'contacted', so we skip the "hide contacted" filter that the default
   *  cold-outreach mode applies. */
  discoveryMode?: boolean;
  onFilterCountryChange: (v: string) => void;
  onFilterCategoryChange: (v: string) => void;
  onFilterLanguageChange: (v: string) => void;
  onFilterPlatformChange: (v: string) => void;
  onSelectionChange: (ids: string[]) => void;
  onManualEmailsChange: (emails: string[]) => void;
  onMaxLeadsChange: (n: number) => void;
}

// Platforms the user can pick from in the wizard. Mirrors the
// PLATFORM_MANIFESTS list on the backend; keep in sync when adding a
// new scraping platform.
const PLATFORM_OPTIONS: Array<{ slug: string; name: string }> = [
  { slug: 'trustpilot',  name: 'Trustpilot' },
  { slug: 'tripadvisor', name: 'TripAdvisor' },
  { slug: 'yelp',        name: 'Yelp' },
  { slug: 'booking',     name: 'Booking.com' },
];

const LIMIT = 50;

/** Share of the matching list. Never rounds a real count down to "0%". */
function pctOf(n: number, total: number): string {
  if (total <= 0 || n === 0) return '0%';
  const pct = (n / total) * 100;
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

type SourceMode = 'matrix' | 'manual';

export default function WizardStep1Leads({
  filterCountry, filterCategory, filterLanguage, filterPlatform, selectedLeadIds, manualEmails, maxLeads,
  redirectMode, discoveryMode,
  onFilterCountryChange, onFilterCategoryChange, onFilterLanguageChange, onFilterPlatformChange,
  onSelectionChange, onManualEmailsChange, onMaxLeadsChange,
}: Props) {
  const [appMode, setAppMode] = useState<AppMode | null>(null);
  const [dynamicCountries, setDynamicCountries] = useState<string[]>([]);
  const [dynamicCategories, setDynamicCategories] = useState<string[]>([]);
  const [languageOptions, setLanguageOptions] = useState<
    Array<{ language: string; countries: string[]; leadCount: number }>
  >([]);
  const [sourceMode, setSourceMode] = useState<SourceMode>('matrix');
  const [manualInput, setManualInput] = useState(manualEmails.join('\n'));
  const [leads, setLeads]         = useState<PickerLead[]>([]);
  const [total, setTotal]         = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading]     = useState(false);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [debSearch, setDebSearch] = useState('');
  const [sortBy, setSortBy]       = useState('star_rating');
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('asc');
  const [rotation, setRotation]   = useState<'oldest' | 'random'>('oldest');
  // How much of the matching list to actually LIST.
  //
  // Defaults to 'sendable' in standard outreach mode, because that is this
  // screen's whole job: produce a list a campaign can mail. Showing all 402
  // matching CA leads when 1 was mailable is what made the panel read as a
  // lie — the operator saw a big number and a table full of rows with no
  // address (reported 2026-09-02). Redirect and discovery modes default to
  // 'all': they are scoped populations judged on a different email column,
  // so a primary-email verdict would wrongly empty the picker.
  const [reach, setReach] = useState<'sendable' | 'has_email' | 'all'>(
    redirectMode || discoveryMode ? 'all' : 'sendable',
  );
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>('');
  const [previewLoaded, setPreviewLoaded] = useState(false);

  // Fetch app mode and dynamic filters on mount
  useEffect(() => {
    api.get('/campaigns/config/mode').then((res) => {
      const mode: AppMode = res.data.data;
      setAppMode(mode);
      if (mode.manualLeadsOnly) setSourceMode('manual');
    }).catch(() => { /* ignore — fall back to defaults */ });

    api.get('/leads/filters').then((res) => {
      const { countries, categories } = res.data.data;
      if (countries?.length) setDynamicCountries(countries);
      if (categories?.length) setDynamicCategories(categories);
    }).catch(() => { /* fall back to static lists */ });

    // Languages that actually have leads, with live counts. Served from the
    // API because the language -> countries expansion is the same logic the
    // filter applies server-side; mirroring it here would let the two drift.
    api.get('/leads/languages')
      .then((res) => setLanguageOptions(res.data?.data ?? []))
      .catch(() => setLanguageOptions([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (filterCountry) p.set('country', filterCountry);
      if (filterCategory) p.set('category', filterCategory);
      if (filterLanguage) p.set('language', filterLanguage);
      if (filterPlatform) p.set('platform', filterPlatform);
      // 'sendable' is the pair of conditions the send gate actually enforces:
      // an address on file AND a valid verdict. Anything less is not mailable
      // today, so listing it in a recipient picker only invites a launch that
      // gets blocked.
      if (reach === 'sendable') { p.set('hasEmail', 'true'); p.set('verificationStatus', 'valid'); }
      else if (reach === 'has_email') p.set('hasEmail', 'true');
      if (debSearch) p.set('search', debSearch);
      p.set('page', String(page));
      p.set('limit', String(LIMIT));
      p.set('sortBy', sortBy);
      p.set('sortDir', sortDir);
      // Standard wizard hides redirected leads (different messaging needed);
      // redirect-aware wizard shows ONLY redirected leads.
      p.set('redirected', redirectMode ? 'only' : 'exclude');
      // Default outreach mode hides already-contacted leads to prevent
      // accidental double-emailing. Redirect and Discovery flows are scoped
      // to their own populations (redirected leads / discovered prospects)
      // and are exempt — those leads are typically already 'contacted' and
      // are surfaced through dedicated entry points (Redirected Leads page,
      // Prospects → Send Follow-Up Campaign).
      if (!redirectMode && !discoveryMode) {
        p.set('status', 'new');
      }
      const res = await api.get(`/leads?${p}`);
      setLeads(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
    } catch {
      setLeads([]); setTotal(0); setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [filterCountry, filterCategory, filterLanguage, filterPlatform, reach, debSearch, page, sortBy, sortDir, redirectMode, discoveryMode]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // ── Hand-off reconciliation ──────────────────────────────────────────
  // Leads pre-selected elsewhere (the Lead Matrix "Send" button, Redirected
  // Leads, Prospects) arrive as bare ids. They never passed through this
  // picker's rules, and they are usually NOT on the page the picker happens
  // to be showing — so the operator could neither see nor uncheck them. That
  // is exactly how invalid addresses reached the send gate and killed the
  // Canada and Australia launches (2026-09-02).
  //
  // So: read the handed-over ids back once, drop the ones a campaign can
  // never send to, and say plainly what was dropped. `?ids=` runs through the
  // same filter path as the list query, so the verdicts agree.
  const [handoffNotice, setHandoffNotice] = useState<{ removed: number; unverified: number } | null>(null);
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (reconciledRef.current) return;
    if (selectedLeadIds.length === 0) return;
    // Discovery follow-ups are exempt: they send to lead.discovered_email,
    // the address the recipient's own auto-reply gave us, while
    // verification_status describes primary_email — which for these leads is
    // usually the address that already bounced. Judging them on it would
    // strip exactly the leads this flow exists to rescue. The send gate
    // applies the discovered_email verdict for these instead.
    if (discoveryMode) { reconciledRef.current = true; return; }
    reconciledRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const p = new URLSearchParams();
        p.set('ids', selectedLeadIds.join(','));
        p.set('limit', String(selectedLeadIds.length));
        p.set('page', '1');
        const res = await api.get(`/leads?${p}`);
        const rows: PickerLead[] = res.data?.data ?? [];
        if (cancelled || rows.length === 0) return;
        const invalid = rows.filter((l) => l.verification_status === 'invalid').map((l) => l.id);
        const unverified = rows.filter((l) => l.verification_status == null).length;
        if (invalid.length > 0) {
          const invalidSet = new Set(invalid);
          onSelectionChange(selectedLeadIds.filter((id) => !invalidSet.has(id)));
        }
        if (invalid.length > 0 || unverified > 0) {
          setHandoffNotice({ removed: invalid.length, unverified });
        }
      } catch {
        // Leave the selection untouched — the send gate is still the
        // authoritative backstop, so a failed read degrades to old behaviour.
      }
    })();
    return () => { cancelled = true; };
    // Intentionally mount-only: this reconciles the INCOMING selection, not
    // every later click. reconciledRef guards a StrictMode double-invoke.
    // discoveryMode is a launch-time mode that never changes for a given
    // wizard instance, so reading it once here is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-row in-flight tracking for re-verification. Clicking a row whose
  // verification_status is 'invalid' fires ZeroBounce on both source emails
  // (POST /api/verify/sync, capped at 5 leads per call) and replaces the row
  // in place with the freshened verdict. If still invalid afterwards, the
  // checkbox stays unchecked. The send-gate at /api/campaigns/:id/send is
  // the safety net — anything that bypasses this still gets blocked there.
  const [reverifying, setReverifying] = useState<Set<string>>(new Set());
  const isInvalid = (l: PickerLead) => l.verification_status === 'invalid';

  const reverifyLead = async (id: string) => {
    setReverifying((prev) => { const n = new Set(prev); n.add(id); return n; });
    try {
      const res = await api.post('/verify/sync', { leadIds: [id] });
      const updated = res.data?.data?.[0];
      if (updated) {
        setLeads((prev) => prev.map((l) => l.id === id ? { ...l, ...updated } : l));
        if (updated.verification_status !== 'invalid' && !selectedLeadIds.includes(id)) {
          onSelectionChange([...selectedLeadIds, id]);
        }
      }
    } catch {
      // Swallow — row stays as-is and the user can retry.
    } finally {
      setReverifying((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const toggleLead = (id: string) => {
    const lead = leads.find((l) => l.id === id);
    if (!lead) return;
    if (isInvalid(lead)) {
      if (reverifying.has(id)) return;
      void reverifyLead(id);
      return;
    }
    if (selectedLeadIds.includes(id)) onSelectionChange(selectedLeadIds.filter((x) => x !== id));
    else onSelectionChange([...selectedLeadIds, id]);
  };

  // Select-page only auto-adds leads with verification_status === 'valid'.
  // Everything else (invalid, catch-all, unknown, not-yet-verified) requires
  // a deliberate row click. Reasoning:
  //   - invalid: would bounce; bulk-reverify is too credit-hungry.
  //   - catch-all: domain accepts any address; spam-trap risk.
  //   - unknown: verifier returned inconclusive; treat as risky.
  //   - null (not verified): never run through verify; sending blind risks
  //     bouncing on dead addresses and burning sender reputation.
  // Manual click on any row still works as a conscious override.
  const pageIds = leads.filter((l) => l.verification_status === 'valid').map((l) => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedLeadIds.includes(id));
  const togglePage = () => {
    if (allPageSelected) onSelectionChange(selectedLeadIds.filter((id) => !pageIds.includes(id)));
    else onSelectionChange([...selectedLeadIds, ...pageIds.filter((id) => !selectedLeadIds.includes(id))]);
  };

  const toggleSort = (col: string) => {
    if (col === sortBy) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  };

  // ── List health, from the real verdict split ──────────────────────────
  // The old "health score" here was `% of the CURRENT PAGE carrying any
  // primary_email`, rendered under the label "Verified & Reachable" beside a
  // hardcoded "cleaned recently, bouncing risk <2%". All three were wrong at
  // once: it measured one page not the list, it measured "has an address" not
  // "verified", and the reassurance was a constant string that rendered
  // identically for a perfect list and an empty one. A CA list showing "402
  // verified leads available / 2% reachable" was reported on 2026-09-02 —
  // both numbers were right about different things and every label was wrong.
  //
  // Now served by /api/leads/verification-counts, which takes the same query
  // string as the list itself, so the panel and the rows can never disagree.
  const [counts, setCounts] = useState<{
    total: number; valid: number; invalid: number; 'catch-all': number;
    unknown: number; unverified: number; sendable: number;
    // Optional: the frontend can go live before the API that returns it.
    no_email?: number;
  } | null>(null);

  useEffect(() => {
    const p = new URLSearchParams();
    if (filterCountry) p.set('country', filterCountry);
    if (filterCategory) p.set('category', filterCategory);
    if (filterLanguage) p.set('language', filterLanguage);
    if (filterPlatform) p.set('platform', filterPlatform);
    if (debSearch) p.set('search', debSearch);
    p.set('redirected', redirectMode ? 'only' : 'exclude');
    if (!redirectMode && !discoveryMode) p.set('status', 'new');
    let cancelled = false;
    api.get(`/leads/verification-counts?${p}`)
      .then((res) => { if (!cancelled) setCounts(res.data?.data ?? null); })
      .catch(() => { if (!cancelled) setCounts(null); });
    return () => { cancelled = true; };
  }, [filterCountry, filterCategory, filterLanguage, filterPlatform, debSearch, redirectMode, discoveryMode]);

  // Share of the matching list that can actually go out today. This is the
  // number the operator was reading off the old bar.
  const sendablePct = counts && counts.total > 0
    ? Math.round((counts.sendable / counts.total) * 100)
    : 0;

  // A discovery follow-up sends to discovered_email, so a verdict on
  // primary_email says nothing about whether it can be mailed. Don't dress
  // these counts up as a sendable figure in that mode.
  const sendableApplies = !discoveryMode;

  // Use dynamic lists if loaded, fall back to static
  const countryOptions = dynamicCountries.length > 0
    ? [{ code: '', name: 'All Countries' }, ...dynamicCountries.map((c) => ({ code: c, name: c }))]
    : COUNTRIES;
  // The curated list FIRST, so the "(all)" roll-ups are actually offered here.
  // This dropdown used to be built purely from the distinct raw values in the
  // database, which meant the wizard showed `online_casino_or_bookmaker` and
  // friends as separate entries and never offered "Gambling (all)" at all --
  // so a gambling campaign had to be built once per sub-category. Any stored
  // category the curated list doesn't know about is still appended, so
  // nothing in the book becomes unreachable.
  const categoryOptions = (() => {
    const known = new Set(CATEGORIES.map((c) => c.slug));
    const extras = dynamicCategories
      .filter((c) => !known.has(c))
      .map((c) => ({ slug: c, name: c }));
    return [...CATEGORIES, ...extras];
  })();

  const categoryLabel = categoryOptions.find((c) => c.slug === filterCategory)?.name || 'All Categories';
  const countryLabel  = countryOptions.find((c) => c.code === filterCountry)?.name  || 'All Countries';
  const listLabel     = [countryLabel !== 'All Countries' ? countryLabel : '', categoryLabel !== 'All Categories' ? categoryLabel : '']
    .filter(Boolean).join(' · ') || 'All Leads';

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-6 py-5 sm:py-10">

      {/* Headline */}
      <div className="text-center mb-6 sm:mb-10">
        <h1 className="text-xl sm:text-3xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Where should we find your leads?
        </h1>
        <p className="text-secondary text-xs sm:text-sm">
          Build your outreach list by selecting from your existing Lead Matrix,
          uploading a file, or entering them manually.
        </p>
      </div>

      {/* Testing-mode banner */}
      {appMode?.manualLeadsOnly && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-6">
          <span className="material-symbols-outlined text-amber-600 text-[20px] shrink-0 mt-0.5">science</span>
          <p className="text-sm text-amber-700">
            <span className="font-bold">Testing mode active</span> — only manually entered email addresses can be used as recipients. Scraped leads are locked until testing is complete.
          </p>
        </div>
      )}

      {/* Hand-off reconciliation notice — what the picker silently fixed, and
          what the operator still has to decide about. */}
      {handoffNotice && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-6">
          <span className="material-symbols-outlined text-amber-600 text-[20px] shrink-0 mt-0.5">rule</span>
          <div className="text-sm text-amber-800 space-y-1">
            {handoffNotice.removed > 0 && (
              <p>
                <span className="font-bold">
                  {handoffNotice.removed} lead{handoffNotice.removed === 1 ? '' : 's'} removed
                </span>{' '}
                — the address was verified as invalid, so a campaign can never send to it.
              </p>
            )}
            {handoffNotice.unverified > 0 && (
              <p>
                <span className="font-bold">
                  {handoffNotice.unverified} lead{handoffNotice.unverified === 1 ? ' is' : 's are'} not verified yet
                </span>{' '}
                — still selected, but the launch will be held back until you verify or remove them. Run
                verification from the Lead Matrix first.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Redirect-aware campaign banner */}
      {redirectMode && (
        <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl px-5 py-4 mb-6">
          <span className="material-symbols-outlined text-rose-600 text-[20px] shrink-0 mt-0.5">alt_route</span>
          <p className="text-sm text-rose-800">
            <span className="font-bold">Redirect-aware campaign</span> — picker is filtered to leads whose Trustpilot listing redirects to a different brand. The AI generator will write copy that asks whether they're the same operator (rebrand) or new owners. Don't use the standard cold-outreach template here.
          </p>
        </div>
      )}

      {/* Source selection cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6 sm:mb-8">
        {/* Lead Matrix */}
        <div
          onClick={() => !appMode?.manualLeadsOnly && setSourceMode('matrix')}
          className={`relative group bg-white rounded-2xl p-6 flex flex-col items-center text-center transition-all ${
            appMode?.manualLeadsOnly
              ? 'border border-slate-100 opacity-40 cursor-not-allowed'
              : sourceMode === 'matrix'
                ? 'border-2 border-[#b0004a] ambient-shadow cursor-pointer'
                : 'border border-slate-100 hover:border-slate-200 cursor-pointer'
          }`}
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${sourceMode === 'matrix' && !appMode?.manualLeadsOnly ? 'bg-[#ffd9de]' : 'bg-slate-100'}`}>
            <span className={`material-symbols-outlined text-[22px] ${sourceMode === 'matrix' && !appMode?.manualLeadsOnly ? 'text-[#b0004a]' : 'text-secondary'}`}>database</span>
          </div>
          <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>Lead Matrix</h3>
          <p className="text-xs text-secondary leading-relaxed mb-4">
            Choose from your pre-scraped, verified lists and saved searches in the system.
          </p>
          <span className={`text-xs font-extrabold uppercase tracking-wider flex items-center gap-1 ${sourceMode === 'matrix' && !appMode?.manualLeadsOnly ? 'text-[#b0004a]' : 'text-secondary'}`}>
            Browse Lists
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
          {appMode?.manualLeadsOnly && (
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
              Locked in testing mode
            </div>
          )}
        </div>

        {/* Import Leads — coming soon */}
        <div className="relative group bg-white rounded-2xl p-6 border border-slate-100 cursor-not-allowed opacity-50 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-secondary text-[22px]">upload_file</span>
          </div>
          <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>Import Leads</h3>
          <p className="text-xs text-secondary leading-relaxed mb-4">
            Upload a CSV, Excel, or Google Sheets file containing your target contact information.
          </p>
          <span className="text-xs font-extrabold text-secondary uppercase tracking-wider flex items-center gap-1">
            Select File
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
          {/* Tooltip */}
          <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Coming soon
          </div>
        </div>

        {/* Add Manually — active */}
        <div
          onClick={() => setSourceMode('manual')}
          className={`bg-white rounded-2xl p-6 cursor-pointer flex flex-col items-center text-center transition-all ${
            sourceMode === 'manual' ? 'border-2 border-[#b0004a] ambient-shadow' : 'border border-slate-100 hover:border-slate-200'
          }`}
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${sourceMode === 'manual' ? 'bg-[#ffd9de]' : 'bg-slate-100'}`}>
            <span className={`material-symbols-outlined text-[22px] ${sourceMode === 'manual' ? 'text-[#b0004a]' : 'text-secondary'}`}>edit_note</span>
          </div>
          <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>Add Manually</h3>
          <p className="text-xs text-secondary leading-relaxed mb-4">
            Quickly paste a list of email addresses or fill in a simple form for direct entry.
          </p>
          <span className={`text-xs font-extrabold uppercase tracking-wider flex items-center gap-1 ${sourceMode === 'manual' ? 'text-[#b0004a]' : 'text-secondary'}`}>
            Open Editor
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
        </div>
      </div>

      {/* ── Manual entry panel ── */}
      {sourceMode === 'manual' && (
        <div className="bg-white rounded-2xl border-2 border-[#b0004a] ambient-shadow overflow-hidden mb-6">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 bg-[#ffd9de]/20">
            <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-on-primary text-[14px]">edit_note</span>
            </div>
            <div>
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Manual Email Entry
              </p>
              <p className="text-xs text-secondary">
                Paste one email address per line. These will be added as leads when you create the campaign.
              </p>
            </div>
          </div>
          <div className="p-6">
            <textarea
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              rows={8}
              placeholder={`john@example.com\njane@acmecorp.com\ninfo@bigcompany.co.uk`}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm font-mono border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none resize-none"
            />
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-secondary">
                {manualInput.split('\n').filter((l) => l.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.trim())).length} valid email{manualInput.split('\n').filter((l) => l.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.trim())).length !== 1 ? 's' : ''} detected
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setManualInput(''); onManualEmailsChange([]); }}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-secondary bg-surface-container hover:bg-surface-container-high transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={() => {
                    const emails = manualInput
                      .split('\n')
                      .map((l) => l.trim())
                      .filter((l) => l && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l));
                    onManualEmailsChange(emails);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-extrabold primary-gradient text-on-primary ambient-shadow hover:scale-[1.02] transition-transform"
                >
                  Apply ({manualInput.split('\n').filter((l) => l.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.trim())).length})
                </button>
              </div>
            </div>
            {manualEmails.length > 0 && (
              <div className="mt-3 flex items-center gap-2 p-3 bg-[#8ff9a8]/20 rounded-xl border border-[#006630]/20">
                <span className="material-symbols-outlined text-[#006630] text-[16px]">check_circle</span>
                <p className="text-xs font-bold text-[#006630]">
                  {manualEmails.length} email{manualEmails.length !== 1 ? 's' : ''} saved — click &quot;Continue to Sequence&quot; when ready
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Configuration panel — Lead Matrix only */}
      {sourceMode === 'matrix' && <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden mb-6">
        {/* Panel header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100">
          <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-primary text-[14px]">info</span>
          </div>
          <div>
            <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Configuration: Lead Matrix
            </p>
            <p className="text-xs text-secondary">
              {counts && sendableApplies
                ? <>{counts.total.toLocaleString()} leads match your filters &mdash; <strong className={counts.sendable > 0 ? 'text-[#006630]' : 'text-error'}>{counts.sendable.toLocaleString()} can be mailed today</strong>.</>
                : <>{(counts?.total ?? total).toLocaleString()} leads match your filters.</>}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 p-4 lg:p-6">
          {/* Left: filters + controls */}
          <div className="space-y-4 min-w-0">
            <div>
              <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                Select Target List
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select
                  value={filterPlatform}
                  onChange={(e) => { onFilterPlatformChange(e.target.value); setPage(1); }}
                  className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  aria-label="Platform"
                >
                  {PLATFORM_OPTIONS.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </select>
                <select
                  value={filterCountry}
                  onChange={(e) => { onFilterCountryChange(e.target.value); setPage(1); }}
                  className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  aria-label="Country"
                >
                  {countryOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
                <select
                  value={filterCategory}
                  onChange={(e) => { onFilterCategoryChange(e.target.value); setPage(1); }}
                  className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  aria-label="Category"
                >
                  {categoryOptions.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select>
                {/* Language — the only filter that spans markets, and the one
                    that decides what language the AI writes in. */}
                <select
                  value={filterLanguage}
                  onChange={(e) => { onFilterLanguageChange(e.target.value); setPage(1); }}
                  className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  aria-label="Outreach language"
                  title="Target every market that shares a language — and write the emails in it"
                >
                  <option value="">Language: auto (from country)</option>
                  {languageOptions.map((o) => (
                    <option key={o.language} value={o.language}>
                      {o.language} ({o.leadCount.toLocaleString()})
                    </option>
                  ))}
                </select>
              </div>
              {filterLanguage && (
                <p className="text-xs text-[#b0004a] mt-1.5 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">translate</span>
                  Emails will be generated in <strong className="mx-0.5">{filterLanguage}</strong>
                  {(() => {
                    const o = languageOptions.find((x) => x.language === filterLanguage);
                    return o ? ` · ${o.countries.join(', ')}` : '';
                  })()}
                </p>
              )}
              <p className="text-xs text-secondary mt-1.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px]">filter_alt</span>
                {listLabel} &mdash; {total.toLocaleString()} shown
                {counts && counts.total > total && (
                  <span className="text-secondary">
                    {' '}of {counts.total.toLocaleString()} matching
                  </span>
                )}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Max Leads to Import
                </label>
                <input
                  type="number"
                  value={maxLeads}
                  min={1}
                  max={5000}
                  onChange={(e) => onMaxLeadsChange(Number(e.target.value))}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Lead Rotation
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRotation('oldest')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                      rotation === 'oldest' ? 'primary-gradient text-on-primary ambient-shadow' : 'bg-surface-container text-secondary hover:bg-surface-container-high'
                    }`}
                  >
                    Oldest First
                  </button>
                  <button
                    onClick={() => setRotation('random')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                      rotation === 'random' ? 'primary-gradient text-on-primary ambient-shadow' : 'bg-surface-container text-secondary hover:bg-surface-container-high'
                    }`}
                  >
                    Random
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right: List Health Insight - every figure below is derived, and
              the wording changes with the data. Nothing here is a constant. */}
          <div className="bg-surface-container rounded-xl p-4">
            <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider mb-4">List Health Insight</p>
            {counts === null ? (
              <p className="text-xs text-secondary">Measuring this list&hellip;</p>
            ) : (
              <div>
                <div className="flex justify-between text-xs font-semibold mb-1.5">
                  <span className="text-secondary">
                    {sendableApplies ? 'Ready to send' : 'Verified on primary email'}
                  </span>
                  <span className={`font-extrabold ${sendablePct >= 50 ? 'text-[#006630]' : sendablePct >= 15 ? 'text-amber-700' : 'text-error'}`}>
                    {sendablePct}%
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${Math.max(sendablePct, counts.sendable > 0 ? 2 : 0)}%`,
                      background: sendablePct >= 50
                        ? 'linear-gradient(90deg, #006630, #00a050)'
                        : sendablePct >= 15
                          ? 'linear-gradient(90deg, #b45309, #d97706)'
                          : 'linear-gradient(90deg, #b0004a, #d81b60)',
                    }}
                  />
                </div>
                <p className="text-[10px] text-secondary mt-2 leading-relaxed">
                  {!sendableApplies ? (
                    <>These leads are mailed at their discovered address, so the verdict on their
                    primary email does not decide whether they can be contacted.</>
                  ) : counts.sendable === 0 ? (
                    <>
                      <span className="font-bold text-error">Nothing here can be sent yet.</span>{' '}
                      {(counts.no_email ?? 0) > 0 && (counts.no_email ?? 0) >= counts.unverified
                        ? <>{(counts.no_email ?? 0).toLocaleString()} have no address on file at all &mdash; run Enrich from the Lead Matrix first, then Verify.</>
                        : counts.unverified > 0
                          ? <>{counts.unverified.toLocaleString()} still need verifying &mdash; run it from the Lead Matrix first.</>
                          : <>No address on file has come back valid.</>}
                    </>
                  ) : sendablePct < 15 ? (
                    <>
                      Only <span className="font-bold text-on-surface">{counts.sendable.toLocaleString()}</span> of{' '}
                      {counts.total.toLocaleString()} can be mailed today. The rest have no address on file
                      or no verified verdict &mdash; verify them before counting on them.
                    </>
                  ) : (
                    <>
                      <span className="font-bold text-on-surface">{counts.sendable.toLocaleString()}</span> of{' '}
                      {counts.total.toLocaleString()} are verified with an address on file. Bounce risk on those is low.
                    </>
                  )}
                </p>

                {/* The split behind the bar. Without it "2%" is unreadable -
                    the operator cannot tell a list that needs verifying from
                    one that has no addresses at all. */}
                <div className="mt-3 flex flex-wrap gap-1">
                  {([
                    { key: 'valid',      label: 'valid',        classes: 'bg-[#8ff9a8]/40 text-[#006630]' },
                    { key: 'catch-all',  label: 'catch-all',    classes: 'bg-amber-50 text-amber-800' },
                    { key: 'unknown',    label: 'unknown',      classes: 'bg-slate-100 text-slate-600' },
                    { key: 'unverified', label: 'not verified', classes: 'bg-slate-100 text-slate-600' },
                    { key: 'invalid',    label: 'invalid',      classes: 'bg-red-50 text-error' },
                    // Not a verdict — nothing was ever checked. Shown here so
                    // a list that needs Enrich is distinguishable from one
                    // that needs Verify.
                    { key: 'no_email',   label: 'no address',   classes: 'bg-slate-100 text-slate-500' },
                  ] as const).filter((c) => (counts[c.key] ?? 0) > 0).map((c) => (
                    <span
                      key={c.key}
                      title={`${(counts[c.key] ?? 0).toLocaleString()} of ${counts.total.toLocaleString()} matching leads`}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums ${c.classes}`}
                    >
                      {(counts[c.key] ?? 0).toLocaleString()} {c.label}
                      <span className="font-semibold opacity-70"> · {pctOf(counts[c.key] ?? 0, counts.total)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-3 gap-2">
              <div className="text-center">
                <p className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>{(counts?.total ?? total).toLocaleString()}</p>
                <p className="text-[10px] text-secondary font-semibold uppercase tracking-wider">Matching</p>
              </div>
              <div className="text-center">
                <p
                  className={`text-xl font-extrabold ${counts && counts.sendable > 0 ? 'text-[#006630]' : 'text-secondary'}`}
                  style={{ fontFamily: 'Manrope, sans-serif' }}
                  title="Verified valid AND has an address on file - the only leads a campaign can actually mail today"
                >
                  {sendableApplies ? (counts?.sendable ?? 0).toLocaleString() : '\u2014'}
                </p>
                <p className="text-[10px] text-secondary font-semibold uppercase tracking-wider">Sendable</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-extrabold text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>{selectedLeadIds.length.toLocaleString()}</p>
                <p className="text-[10px] text-secondary font-semibold uppercase tracking-wider">Selected</p>
              </div>
            </div>
          </div>
        </div>
      </div>}

      {/* Lead table — Lead Matrix only */}
      {sourceMode === 'matrix' && <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
        {/* Table toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-surface-container">
          <div className="flex items-center gap-3">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[17px]">search</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search companies..."
                className="bg-white rounded-xl pl-9 pr-4 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none w-56"
              />
            </div>
            {/* What the table lists. The counts panel always describes the
                FULL matching set, so narrowing here hides nothing. */}
            <select
              value={reach}
              onChange={(e) => { setReach(e.target.value as typeof reach); setPage(1); }}
              title="Which of the matching leads to list"
              className="bg-white rounded-xl px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
            >
              <option value="sendable">Sendable only ({counts?.sendable?.toLocaleString() ?? '…'})</option>
              <option value="has_email">Has an address</option>
              <option value="all">All matching ({counts?.total?.toLocaleString() ?? '…'})</option>
            </select>
            {selectedLeadIds.length > 0 && (
              <span className="text-xs font-bold bg-[#ffd9de] text-[#b0004a] px-3 py-1.5 rounded-full">
                {selectedLeadIds.length} selected
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {leads.length > 0 && (
              <button onClick={togglePage} className="text-xs font-bold text-[#b0004a] hover:underline">
                {allPageSelected ? 'Deselect page' : 'Select page'}
              </button>
            )}
            {selectedLeadIds.length > 0 && (
              <button onClick={() => onSelectionChange([])} className="text-xs font-bold text-secondary hover:text-error">
                Clear all
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-secondary">
            <Loader2 size={16} className="animate-spin text-[#b0004a]" /> Loading leads...
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-slate-100 text-left bg-surface-container">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" checked={allPageSelected} onChange={togglePage}
                    className="rounded border-slate-300 accent-[#b0004a] w-3.5 h-3.5" />
                </th>
                {[
                  { label: 'Company', col: 'company_name' },
                  { label: 'Email',   col: 'primary_email' },
                  { label: 'Country', col: null },
                  { label: 'Rating',  col: 'star_rating' },
                  { label: 'Shot',    col: null },
                  { label: 'Status',  col: null },
                ].map(({ label, col }) => (
                  <th
                    key={label}
                    onClick={() => col && toggleSort(col)}
                    className={`px-4 py-3 text-xs font-extrabold uppercase tracking-wider text-secondary ${col ? 'cursor-pointer hover:text-on-surface select-none' : ''}`}
                  >
                    {label}
                    {col && (
                      <span className={`material-symbols-outlined text-[13px] ml-0.5 align-middle ${sortBy === col ? 'text-[#b0004a]' : 'text-slate-200'}`}>
                        {sortBy === col ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {leads.map((lead) => {
                const sel = selectedLeadIds.includes(lead.id);
                const blocked = isInvalid(lead);
                const isReverifying = reverifying.has(lead.id);
                const hasAddress = !!lead.primary_email;
                const isCatchAll = hasAddress && lead.verification_status === 'catch-all';
                const isUnknown = hasAddress && lead.verification_status === 'unknown';
                const isNotVerified = hasAddress && lead.verification_status == null;
                return (
                  <tr
                    key={lead.id}
                    onClick={() => toggleLead(lead.id)}
                    title={blocked ? 'Click to re-verify with ZeroBounce. If both addresses still fail, the row stays blocked.' : undefined}
                    className={`transition-colors ${
                      blocked
                        ? `bg-red-50/30 ${isReverifying ? 'cursor-wait' : 'cursor-pointer hover:bg-red-50/50'}`
                        : sel
                          ? 'bg-[#ffd9de]/20 cursor-pointer'
                          : 'hover:bg-surface-container-low cursor-pointer'
                    }`}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {isReverifying ? (
                        <Loader2 size={14} className="animate-spin text-[#b0004a]" />
                      ) : (
                        <input type="checkbox" checked={sel} onChange={() => toggleLead(lead.id)}
                          className="rounded border-slate-300 accent-[#b0004a] w-3.5 h-3.5" />
                      )}
                    </td>
                    <td className="px-4 py-3 font-bold text-on-surface">{lead.company_name}</td>
                    <td className="px-4 py-3 text-xs">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-secondary ${blocked ? 'line-through text-slate-400' : ''}`}>
                          {lead.primary_email || <span className="text-slate-300">—</span>}
                        </span>
                        {blocked && !isReverifying && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-red-50 text-red-700 px-1.5 py-0.5 rounded-full" title="Will bounce — click row to re-verify">
                            <span className="material-symbols-outlined text-[9px]">cancel</span>invalid
                          </span>
                        )}
                        {isReverifying && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full">
                            <Loader2 size={9} className="animate-spin" />re-verifying
                          </span>
                        )}
                        {isCatchAll && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full" title="Domain accepts all mail — individual mailbox can't be proven. Not added by 'Select page'; click the row to include manually.">
                            <span className="material-symbols-outlined text-[9px]">help</span>catch-all
                          </span>
                        )}
                        {isUnknown && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-slate-50 text-slate-500 px-1.5 py-0.5 rounded-full" title="Verification was inconclusive. Not added by 'Select page'; click the row to include manually.">
                            <span className="material-symbols-outlined text-[9px]">help_outline</span>unknown
                          </span>
                        )}
                        {isNotVerified && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full" title="Not verified yet. Not added by 'Select page'; click the row to include manually, or run Verify on the Leads page first.">
                            <span className="material-symbols-outlined text-[9px]">pending</span>not verified
                          </span>
                        )}
                        {!hasAddress && (
                          <span
                            className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full"
                            title="No email address on file, so there is nothing to verify. Run Enrich on the Lead Matrix to try to find one from the company website."
                          >
                            <span className="material-symbols-outlined text-[9px]">mail_off</span>no address
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-secondary text-xs">{lead.country || '—'}</td>
                    <td className="px-4 py-3 font-bold text-[#b0004a] text-xs">{lead.star_rating != null ? `${lead.star_rating} ★` : '—'}</td>
                    <td className="px-4 py-3 w-12" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const hasShot = !!lead.screenshot_path;
                        const shotSrc = hasShot ? buildScreenshotSrc(lead.screenshot_path as string) : null;
                        return (
                          <button
                            type="button"
                            disabled={!hasShot}
                            onMouseEnter={() => { if (shotSrc) preloadScreenshot(shotSrc); }}
                            onFocus={() => { if (shotSrc) preloadScreenshot(shotSrc); }}
                            onClick={() => {
                              if (!shotSrc) return;
                              setPreviewLoaded(false);
                              setPreviewSrc(shotSrc);
                              setPreviewName(lead.company_name);
                            }}
                            title={hasShot ? 'View Trustpilot screenshot' : 'No screenshot captured'}
                            className={`p-1 rounded-lg transition-colors ${
                              hasShot
                                ? 'text-[#b0004a] hover:bg-[#ffd9de]'
                                : 'text-slate-200 cursor-not-allowed'
                            }`}
                          >
                            <span className="material-symbols-outlined text-[18px]">image</span>
                          </button>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-bold bg-surface-container text-secondary px-2 py-0.5 rounded-full capitalize">
                        {lead.outreach_status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {leads.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-secondary text-sm">No leads found.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-surface-container text-xs">
            <span className="font-semibold text-secondary">
              {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
                className="p-1.5 rounded-lg bg-white border border-slate-100 disabled:opacity-40 hover:bg-surface-container transition-colors">
                <span className="material-symbols-outlined text-[16px]">chevron_left</span>
              </button>
              <span className="px-3 font-bold text-secondary">Page {page} of {totalPages}</span>
              <button disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}
                className="p-1.5 rounded-lg bg-white border border-slate-100 disabled:opacity-40 hover:bg-surface-container transition-colors">
                <span className="material-symbols-outlined text-[16px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </div>}

      {previewSrc && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPreviewSrc(null)}
        >
          <div
            className="bg-white rounded-2xl ambient-shadow max-w-4xl w-full max-h-[90vh] overflow-hidden border border-slate-100 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-surface-container">
              <div className="flex items-center gap-2 min-w-0">
                <span className="material-symbols-outlined text-[18px] text-[#b0004a] shrink-0">screenshot</span>
                <span className="text-sm font-bold text-on-surface truncate">{previewName}</span>
              </div>
              <button
                onClick={() => setPreviewSrc(null)}
                className="text-slate-400 hover:text-on-surface p-1 rounded-lg hover:bg-surface-container-high transition-colors"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="overflow-auto bg-surface-container flex items-center justify-center p-4 relative min-h-[200px]">
              {!previewLoaded && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="w-8 h-8 rounded-full border-2 border-[#ffd9de] border-t-[#b0004a] animate-spin" />
                </div>
              )}
              <img
                src={previewSrc}
                alt={`Trustpilot profile of ${previewName}`}
                decoding="async"
                fetchPriority="high"
                onLoad={() => setPreviewLoaded(true)}
                onError={() => setPreviewLoaded(true)}
                className={`max-w-full max-h-[75vh] object-contain rounded-lg transition-opacity duration-200 ${previewLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
