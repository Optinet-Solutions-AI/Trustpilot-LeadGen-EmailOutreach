'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import api from '../api/client';
import { useNotes } from '../hooks/useNotes';
import { useFollowUps } from '../hooks/useFollowUps';
import { useCheckClaimedJob } from '../hooks/useCheckClaimedJob';
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

export default function LeadDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
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
  const { followUps, fetchFollowUps, createFollowUp, completeFollowUp } = useFollowUps(id);

  useEffect(() => {
    if (!id || id === '_id') return;
    setLoadError(null);
    api.get(`/leads/${id}`)
      .then((res) => setLead(res.data.data))
      .catch((err) => setLoadError(err?.response?.data?.error || err.message || 'Failed to load lead'));
    fetchNotes();
    fetchFollowUps();
  }, [id, fetchNotes, fetchFollowUps]);

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

  if (loadError) return (
    <div className="px-6 py-8 xl:px-10 xl:py-10 space-y-6">
      <button
        onClick={() => router.push('/leads')}
        className="flex items-center gap-2 text-sm font-semibold text-secondary hover:text-on-surface transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to Lead Matrix
      </button>
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <span className="material-symbols-outlined text-slate-300 text-[40px]">error_outline</span>
        <p className="text-base font-bold text-on-surface">Could not load lead</p>
        <p className="text-sm text-secondary">{loadError}</p>
      </div>
    </div>
  );

  if (!lead) return (
    <div className="flex items-center justify-center h-64 text-secondary gap-2">
      <span className="material-symbols-outlined text-[#b0004a] text-[20px]" style={{ animation: 'spin 1s linear infinite' }}>progress_activity</span>
      Loading lead...
    </div>
  );

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
    <div className="px-6 py-8 xl:px-10 xl:py-10 space-y-8">

      {/* Back button */}
      <button
        onClick={() => router.push('/leads')}
        className="flex items-center gap-2 text-sm font-semibold text-secondary hover:text-on-surface transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to Lead Matrix
      </button>

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

      {/* Lead Info Card */}
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

        {/* Screenshot */}
        {lead.screenshot_path && (
          <div className="mt-6 pt-6 border-t border-slate-100">
            <h3 className="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] text-secondary">screenshot</span>
              Trustpilot Profile Screenshot
            </h3>
            <div className="rounded-xl overflow-hidden border border-slate-100">
              <img
                src={`/api/screenshots/${lead.screenshot_path.split(/[/\\]/).pop()}`}
                alt={`Trustpilot profile of ${lead.company_name}`}
                className="w-full max-h-[400px] object-contain bg-surface-container"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          </div>
        )}
      </div>

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
