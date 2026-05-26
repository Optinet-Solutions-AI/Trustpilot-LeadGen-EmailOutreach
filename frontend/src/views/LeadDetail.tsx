'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '../api/client';
import { useNotes } from '../hooks/useNotes';
import { useFollowUps } from '../hooks/useFollowUps';
import { useCheckClaimedJob } from '../hooks/useCheckClaimedJob';
import { useLeadDiscoveries, useDiscoveryActions } from '../hooks/useDiscoveredContacts';
import StatusBadge from '../components/StatusBadge';
import ActivityTimeline from '../components/ActivityTimeline';
import NoteEditor from '../components/NoteEditor';
import FollowUpScheduler from '../components/FollowUpScheduler';
import QuickSendModal from '../components/QuickSendModal';
import JobProgress from '../components/JobProgress';
import type { Lead, LeadStatus } from '../types/lead';

// Per-lead jobId persistence: each lead's active job is stored under its
// own localStorage key so multiple lead detail tabs can run jobs in parallel
// and each tab resumes the right one on refresh.
const claimedJobKey = (leadId: string) => `active_claimed_check_job_${leadId}`;

const STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'converted', 'lost'];

// Extract the lead UUID from window.location.pathname. The /leads/[id] route
// is statically pre-rendered as /leads/_id.html with vercel.json rewriting
// any /leads/<anything> to that shell, so useParams() returns the literal
// placeholder '_id' instead of the real URL segment. Reading the actual
// pathname client-side is the only reliable source of the user-navigated ID
// under this output:'export' setup.
function readLeadIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/\/leads\/([^/?#]+)/);
  if (!match) return null;
  const candidate = decodeURIComponent(match[1]);
  // Guard against the static-shell placeholder ever leaking through.
  return candidate === '_id' ? null : candidate;
}

export default function LeadDetail() {
  const router = useRouter();
  // Start as null on every render path (server build + client mount) so the
  // static HTML and the first client render agree — eliminates the
  // hydration-mismatch warning that a window-aware lazy initializer would
  // throw under output:'export'. The real ID lands one tick later via the
  // mount effect below, which always runs client-side.
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const resolved = readLeadIdFromUrl();
    setId(resolved);
    if (!resolved) {
      // Can't pull a real ID out of the URL — show a clear error instead
      // of leaving the page in a perma-skeleton. Real-world trigger is a
      // malformed link or a paste of an old /leads/_id fixture URL.
      setLoadError('Could not read a lead ID from this URL.');
    }
    // Re-resolve when the URL changes — covers same-component navigation
    // between lead detail pages without full reloads.
    const sync = () => setId(readLeadIdFromUrl());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const [lead, setLead] = useState<Lead | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [quickSendOpen, setQuickSendOpen] = useState(false);
  const [claimedJobId, setClaimedJobId] = useState<string | null>(() => {
    if (typeof window === 'undefined' || !id) return null;
    return localStorage.getItem(claimedJobKey(id));
  });
  const [claimedStartedAt, setClaimedStartedAt] = useState<string | null>(null);
  const [claimedNotice, setClaimedNotice] = useState<string | null>(null);
  const claimedJob = useCheckClaimedJob(claimedJobId);
  const checkingClaimed = claimedJob.status === 'running';

  const handleAddTag = async () => {
    const tag = tagInput.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag || !lead || lead.tags?.includes(tag)) { setTagInput(''); return; }
    const newTags = [...(lead.tags || []), tag];
    const res = await api.patch(`/leads/${id}`, { tags: newTags });
    setLead(res.data.data);
    setTagInput('');
  };

  const handleRemoveTag = async (tag: string) => {
    if (!lead) return;
    const newTags = (lead.tags || []).filter((t) => t !== tag);
    const res = await api.patch(`/leads/${id}`, { tags: newTags });
    setLead(res.data.data);
  };

  const { notes, fetchNotes, addNote } = useNotes(id || '');
  const { followUps, fetchFollowUps, createFollowUp, completeFollowUp } = useFollowUps(id ?? undefined);
  const { data: leadDiscoveries, refresh: refreshDiscoveries } = useLeadDiscoveries(id || null);
  const discoveryActions = useDiscoveryActions();
  const [discoveryBusyId, setDiscoveryBusyId] = useState<string | null>(null);
  // Hide the screenshot section as a whole when the image 404s — otherwise
  // the header sits orphaned above a broken image rectangle. Resets every
  // time the lead's screenshot_path changes so navigating between leads
  // doesn't carry one lead's failure flag to another.
  const [screenshotFailed, setScreenshotFailed] = useState(false);
  useEffect(() => { setScreenshotFailed(false); }, [lead?.screenshot_path]);

  // Loading flag distinct from `lead == null` — without it, a transient
  // network failure followed by an unset `loadError` would re-show the
  // skeleton instead of the error state. Tracks the active lead fetch
  // independently from the side fetches (notes, follow-ups) below.
  const [leadLoading, setLeadLoading] = useState(false);

  const loadLead = useCallback(async () => {
    if (!id) return;
    setLeadLoading(true);
    setLoadError(null);
    // Local AbortController — independent of axios's global timeout so the
    // skeleton can't sit indefinitely if anything in the interceptor chain
    // swallows the timeout error. 12s is long enough for a warm Cloud Run
    // request + DB round trip, short enough that a cold start or upstream
    // stall surfaces the retry UI quickly.
    const controller = new AbortController();
    const timeoutMs = 12_000;
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await api.get(`/leads/${id}`, { signal: controller.signal });
      setLead(res.data.data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string; name?: string; code?: string };
      const aborted = controller.signal.aborted
        || e?.name === 'CanceledError'
        || e?.code === 'ERR_CANCELED'
        || e?.code === 'ECONNABORTED';
      setLoadError(
        aborted
          ? `Lead lookup timed out after ${timeoutMs / 1000}s. The API may be cold-starting or degraded — try Retry.`
          : (e?.response?.data?.error || e?.message || 'Failed to load lead'),
      );
    } finally {
      clearTimeout(abortTimer);
      setLeadLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    // Kick off all three fetches in parallel. Each section renders its own
    // loading / empty / error state, so a slow lead lookup no longer
    // blocks the activity timeline or follow-ups from appearing.
    loadLead();
    fetchNotes();
    fetchFollowUps();
  }, [id, loadLead, fetchNotes, fetchFollowUps]);

  // React to claimed-check job reaching a terminal state — refresh the lead
  // so the Profile Claimed tile picks up the new value.
  useEffect(() => {
    if (!claimedJobId || !id) return;
    if (claimedJob.status === 'completed') {
      const verdict = claimedJob.summary.claimed > 0 ? 'claimed'
        : claimedJob.summary.unclaimed > 0 ? 'unclaimed' : 'unknown';
      setClaimedNotice(`Claimed check complete — result: ${verdict}`);
      setClaimedJobId(null);
      setClaimedStartedAt(null);
      localStorage.removeItem(claimedJobKey(id));
      api.get(`/leads/${id}`).then((res) => setLead(res.data.data)).catch(() => {});
    } else if (claimedJob.status === 'failed') {
      setClaimedNotice(`Claimed check failed: ${claimedJob.error || 'unknown error'}`);
      setClaimedJobId(null);
      setClaimedStartedAt(null);
      localStorage.removeItem(claimedJobKey(id));
    }
  }, [claimedJob.status, claimedJob.summary, claimedJob.error, claimedJobId, id]);

  const handleStatusChange = async (status: LeadStatus) => {
    const res = await api.patch(`/leads/${id}`, { outreach_status: status });
    setLead(res.data.data);
    fetchNotes();
  };

  const handleRecheckClaimed = async () => {
    if (!id || checkingClaimed || claimedJobId) return;
    try {
      const res = await api.post('/leads/check-claimed', { ids: [id] });
      const { jobId } = res.data.data;
      if (!jobId) {
        setClaimedNotice('Failed to start claimed check');
        return;
      }
      localStorage.setItem(claimedJobKey(id), jobId);
      setClaimedJobId(jobId);
      setClaimedStartedAt(new Date().toISOString());
    } catch (e) {
      setClaimedNotice(e instanceof Error ? e.message : 'Failed to start claimed check');
    }
  };

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-8 xl:px-10 xl:py-10 space-y-4 sm:space-y-8">

      {/* Back button */}
      <button
        onClick={() => router.push('/leads')}
        className="flex items-center gap-2 text-sm font-semibold text-secondary hover:text-on-surface transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to Lead Matrix
      </button>

      {/* Discovery banner — surfaces pending discovered_contacts so the user
          can Accept / Dismiss without leaving the lead detail page. */}
      {leadDiscoveries.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-bold text-amber-800">
            <span className="material-symbols-outlined text-[18px]">forward_to_inbox</span>
            Auto-reply suggested {leadDiscoveries.length} discovered contact{leadDiscoveries.length === 1 ? '' : 's'} — review:
          </div>
          <div className="space-y-1.5">
            {leadDiscoveries.map((d) => {
              const busy = discoveryBusyId === d.id;
              return (
                <div key={d.id} className="flex items-center gap-2 text-sm">
                  <span className={`material-symbols-outlined text-[14px] ${d.kind === 'email' ? 'text-blue-500' : 'text-purple-500'}`}>
                    {d.kind === 'email' ? 'alternate_email' : 'link'}
                  </span>
                  <span className="font-medium text-on-surface truncate flex-1">{d.value}</span>
                  {d.role && <span className="text-xs text-secondary capitalize">{d.role}</span>}
                  {d.verification_status && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-white border border-amber-200 text-amber-800 capitalize">
                      {d.verification_status}
                    </span>
                  )}
                  <button
                    onClick={async () => {
                      setDiscoveryBusyId(d.id);
                      try {
                        const result = await discoveryActions.accept(d.id);
                        if (result?.lead) setLead(result.lead);
                        await refreshDiscoveries();
                        await fetchNotes();
                      } finally {
                        setDiscoveryBusyId(null);
                      }
                    }}
                    disabled={busy}
                    className="px-2 py-1 rounded-md bg-green-600 text-white text-xs font-bold hover:bg-green-700 disabled:opacity-50"
                  >
                    Accept
                  </button>
                  {d.kind === 'url' && (
                    <button
                      onClick={async () => {
                        setDiscoveryBusyId(d.id);
                        try {
                          await discoveryActions.spawnLead(d.id);
                          await refreshDiscoveries();
                          await fetchNotes();
                        } finally {
                          setDiscoveryBusyId(null);
                        }
                      }}
                      disabled={busy}
                      className="px-2 py-1 rounded-md bg-purple-600 text-white text-xs font-bold hover:bg-purple-700 disabled:opacity-50"
                    >
                      Spawn lead
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      setDiscoveryBusyId(d.id);
                      try {
                        await discoveryActions.dismiss(d.id);
                        await refreshDiscoveries();
                        await fetchNotes();
                      } finally {
                        setDiscoveryBusyId(null);
                      }
                    }}
                    disabled={busy}
                    className="px-2 py-1 rounded-md bg-white border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Live claimed-check progress — inline log panel (resumes on refresh) */}
      {claimedJobId && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <JobProgress
            kind="check-claimed"
            status={claimedJob.status === 'idle' ? 'running' : claimedJob.status}
            progress={claimedJob.progress}
            error={claimedJob.error}
            startedAt={claimedStartedAt}
          />
        </div>
      )}

      {/* Claimed-check completion notice */}
      {claimedNotice && !claimedJobId && (
        <div className="flex items-center gap-3 rounded-xl px-5 py-3 text-sm border bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]">
          <span className="material-symbols-outlined text-[18px] text-[#006630]">check_circle</span>
          <span className="font-semibold">{claimedNotice}</span>
          <button
            onClick={() => setClaimedNotice(null)}
            className="ml-auto text-[#006630]/60 hover:text-[#006630] transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Lead Info Card — has three states: loading skeleton, error with
          retry, and full data. The activity / follow-ups sections below
          render independently, so even when this card is in skeleton mode
          the user can still browse notes and schedule follow-ups. */}
      {!lead && loadError ? (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <span className="material-symbols-outlined text-slate-300 text-[40px]">error_outline</span>
            <p className="text-base font-bold text-on-surface">Could not load lead</p>
            <p className="text-sm text-secondary max-w-md">{loadError}</p>
            <button
              onClick={loadLead}
              disabled={leadLoading}
              className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-[#b0004a] text-white text-xs font-bold hover:bg-[#90003b] disabled:opacity-50 transition-colors"
            >
              <span className={`material-symbols-outlined text-[16px] ${leadLoading ? 'animate-spin' : ''}`}>
                {leadLoading ? 'progress_activity' : 'refresh'}
              </span>
              {leadLoading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </div>
      ) : !lead ? (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8 animate-pulse">
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-xl bg-surface-container" />
              <div className="space-y-2">
                <div className="h-7 w-64 bg-surface-container rounded" />
                <div className="h-4 w-48 bg-surface-container rounded" />
              </div>
            </div>
            <div className="h-10 w-32 bg-surface-container rounded-lg" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-surface-container rounded-xl p-4 h-20" />
            ))}
          </div>
        </div>
      ) : (
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-[#ffd9de] flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-[#b0004a] text-[24px]">business</span>
            </div>
            <div>
              <h1
                className="text-2xl font-extrabold text-on-surface"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                {lead.company_name}
              </h1>
              {lead.website_url && (
                <a
                  href={lead.website_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[#b0004a] hover:underline inline-flex items-center gap-1 mt-0.5"
                >
                  {lead.website_url}
                  <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                </a>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleRecheckClaimed}
              disabled={checkingClaimed || !!claimedJobId}
              title={checkingClaimed ? 'Checking…' : 'Visit this Trustpilot profile and update the claimed status'}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-bold hover:bg-emerald-50 disabled:opacity-50 transition-colors"
            >
              <span className={`material-symbols-outlined text-[16px] ${checkingClaimed ? 'animate-spin' : ''}`}>
                {checkingClaimed ? 'progress_activity' : 'shield_person'}
              </span>
              {checkingClaimed ? 'Checking…' : 'Recheck Claimed'}
            </button>
            {lead.primary_email && (
              <button
                onClick={() => setQuickSendOpen(true)}
                className="flex items-center gap-2 px-4 py-2.5 primary-gradient text-on-primary rounded-lg text-sm font-bold ambient-shadow hover:scale-[1.02] transition-transform"
              >
                <span className="material-symbols-outlined text-[16px]">send</span>
                Send Email
              </button>
            )}
            <select
              value={lead.outreach_status}
              onChange={(e) => handleStatusChange(e.target.value as LeadStatus)}
              className="bg-surface-container rounded-lg px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none font-semibold"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Trustpilot Email', value: lead.trustpilot_email || '—', icon: 'alternate_email' },
            { label: 'Website Email', value: lead.website_email || '—', icon: 'mark_email_unread' },
            { label: 'Affiliate Email', value: lead.affiliate_email || '—', icon: 'group_add' },
            { label: 'Phone', value: lead.phone || '—', icon: 'phone' },
            { label: 'Rating', value: lead.star_rating ? `${lead.star_rating.toFixed(1)} ★` : '—', icon: 'star' },
            { label: 'Status', value: null, icon: 'flag', badge: lead.outreach_status },
            { label: 'Country', value: lead.country || '—', icon: 'location_on' },
            { label: 'Category', value: lead.category || '—', icon: 'category' },
            { label: 'Verified', value: `${lead.email_verified ? 'Yes' : 'No'} (${lead.verification_status || 'unknown'})`, icon: 'verified' },
            { label: 'Profile Claimed',
              value: lead.profile_claimed === true ? 'Claimed'
                   : lead.profile_claimed === false ? 'Unclaimed' : '—',
              icon: 'shield_person' },
            { label: 'Scraped', value: lead.scraped_at ? new Date(lead.scraped_at).toLocaleDateString() : '—', icon: 'calendar_today' },
          ].map(({ label, value, icon, badge }) => (
            <div key={label} className="bg-surface-container rounded-xl p-4">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="material-symbols-outlined text-secondary text-[14px]">{icon}</span>
                <span className="text-xs font-bold text-secondary uppercase tracking-wide">{label}</span>
              </div>
              {badge ? (
                <StatusBadge status={badge as LeadStatus} />
              ) : (
                <p className="text-sm font-semibold text-on-surface truncate">{value}</p>
              )}
            </div>
          ))}
        </div>

        {/* Tags */}
        <div className="mt-6 pt-6 border-t border-slate-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-secondary text-[16px]">label</span>
            <span className="text-sm font-bold text-on-surface">Tags</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {(lead.tags || []).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 text-xs bg-[#ffd9de] text-[#b0004a] px-3 py-1.5 rounded-full font-bold"
              >
                {tag}
                <button onClick={() => handleRemoveTag(tag)} className="hover:text-[#7a0033] ml-0.5">
                  <span className="material-symbols-outlined text-[12px]">close</span>
                </button>
              </span>
            ))}
            <div className="inline-flex items-center gap-1">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddTag(); } }}
                placeholder="Add tag…"
                className="text-xs bg-surface-container rounded-full px-3 py-1.5 w-28 focus:outline-none focus:ring-2 focus:ring-[#b0004a]/20 border-0"
              />
              <button
                onClick={handleAddTag}
                className="p-1.5 rounded-full hover:bg-[#ffd9de] text-[#b0004a] transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
              </button>
            </div>
          </div>
        </div>

        {/* Screenshot — pass the raw screenshot_path through when it's a
            full URL (Supabase Storage), otherwise route it through the API
            proxy for legacy local-filename rows. The entire section hides
            on load failure so the header never sits orphaned over a broken
            image rectangle. */}
        {lead.screenshot_path && !screenshotFailed && (
          <div className="mt-6 pt-6 border-t border-slate-100">
            <h3 className="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] text-secondary">screenshot</span>
              Trustpilot Profile Screenshot
            </h3>
            <div className="rounded-xl overflow-hidden border border-slate-100">
              <img
                src={
                  /^https?:\/\//i.test(lead.screenshot_path)
                    ? lead.screenshot_path
                    : `/api/screenshots/${lead.screenshot_path.split(/[/\\]/).pop()}`
                }
                alt={`Trustpilot profile of ${lead.company_name}`}
                className="w-full max-h-[400px] object-contain bg-surface-container"
                onError={() => setScreenshotFailed(true)}
              />
            </div>
          </div>
        )}
      </div>
      )}

      {quickSendOpen && lead && (
        <QuickSendModal
          leadIds={[lead.id]}
          leads={[lead]}
          onClose={() => setQuickSendOpen(false)}
          onDone={() => {
            setQuickSendOpen(false);
            api.get(`/leads/${id}`).then((res) => setLead(res.data.data));
            fetchNotes();
          }}
        />
      )}

      {/* Activity + Follow-ups */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Timeline */}
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <h2
            className="text-lg font-extrabold text-on-surface mb-4 flex items-center gap-2"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-[#b0004a] text-[20px]">history</span>
            Activity
          </h2>
          <NoteEditor onSubmit={async (content) => { await addNote(content); }} />
          <div className="mt-4">
            <ActivityTimeline notes={notes} />
          </div>
        </div>

        {/* Follow-ups */}
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
          <h2
            className="text-lg font-extrabold text-on-surface mb-4 flex items-center gap-2"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-[#b0004a] text-[20px]">schedule</span>
            Follow-ups
          </h2>
          <FollowUpScheduler onSchedule={async (date, note) => { await createFollowUp(date, note); }} />
          <div className="mt-4 space-y-2">
            {followUps.map((fu) => (
              <div key={fu.id} className="flex items-center justify-between p-3 bg-surface-container rounded-xl text-sm">
                <div>
                  <p className={`font-semibold ${fu.completed ? 'line-through text-secondary' : 'text-on-surface'}`}>
                    {new Date(fu.due_date).toLocaleDateString()} — {fu.note || 'No note'}
                  </p>
                </div>
                {!fu.completed && (
                  <button
                    onClick={() => completeFollowUp(fu.id)}
                    className="text-xs font-bold text-[#006630] hover:underline flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-[14px]">check_circle</span>
                    Done
                  </button>
                )}
              </div>
            ))}
            {followUps.length === 0 && (
              <p className="text-sm text-secondary text-center py-4">No follow-ups scheduled</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
