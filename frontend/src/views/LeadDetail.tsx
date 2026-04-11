'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import api from '../api/client';
import { useNotes } from '../hooks/useNotes';
import { useFollowUps } from '../hooks/useFollowUps';
import StatusBadge from '../components/StatusBadge';
import ActivityTimeline from '../components/ActivityTimeline';
import NoteEditor from '../components/NoteEditor';
import FollowUpScheduler from '../components/FollowUpScheduler';
import QuickSendModal from '../components/QuickSendModal';
import type { Lead, LeadStatus } from '../types/lead';

const STATUSES: LeadStatus[] = ['new', 'contacted', 'replied', 'converted', 'lost'];

export default function LeadDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const [lead, setLead] = useState<Lead | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [quickSendOpen, setQuickSendOpen] = useState(false);

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
    api.get(`/leads/${id}`).then((res) => setLead(res.data.data));
    fetchNotes();
    fetchFollowUps();
  }, [id, fetchNotes, fetchFollowUps]);

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

  return (
    <div className="px-10 py-10 space-y-8">

      {/* Back button */}
      <button
        onClick={() => router.push('/leads')}
        className="flex items-center gap-2 text-sm font-semibold text-secondary hover:text-on-surface transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to Lead Matrix
      </button>

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
          <div className="flex items-center gap-3">
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
            { label: 'Email', value: lead.primary_email || '—', icon: 'alternate_email' },
            { label: 'Phone', value: lead.phone || '—', icon: 'phone' },
            { label: 'Rating', value: lead.star_rating ? `${lead.star_rating.toFixed(1)} ★` : '—', icon: 'star' },
            { label: 'Status', value: null, icon: 'flag', badge: lead.outreach_status },
            { label: 'Country', value: lead.country || '—', icon: 'location_on' },
            { label: 'Category', value: lead.category || '—', icon: 'category' },
            { label: 'Verified', value: `${lead.email_verified ? 'Yes' : 'No'} (${lead.verification_status || 'unknown'})`, icon: 'verified' },
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
