'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, Mail, Phone, Star, Tag, X, Plus, Send } from 'lucide-react';
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

  if (!lead) return <div className="text-gray-400 text-center py-12">Loading...</div>;

  const handleStatusChange = async (status: LeadStatus) => {
    const res = await api.patch(`/leads/${id}`, { outreach_status: status });
    setLead(res.data.data);
    fetchNotes();
  };

  return (
    <div className="space-y-6">
      <button onClick={() => router.push('/leads')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={14} /> Back to leads
      </button>

      {/* Lead Info */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold">{lead.company_name}</h1>
            {lead.website_url && (
              <a href={lead.website_url} target="_blank" rel="noopener noreferrer"
                className="text-sm text-blue-500 hover:underline inline-flex items-center gap-1 mt-1">
                {lead.website_url} <ExternalLink size={12} />
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            {lead.primary_email && (
              <button
                onClick={() => setQuickSendOpen(true)}
                className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700"
              >
                <Send size={13} /> Send Email
              </button>
            )}
            <select value={lead.outreach_status} onChange={(e) => handleStatusChange(e.target.value as LeadStatus)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 text-sm">
          <div>
            <span className="text-gray-500">Email</span>
            <p className="font-medium flex items-center gap-1">
              <Mail size={12} /> {lead.primary_email || '-'}
            </p>
          </div>
          <div>
            <span className="text-gray-500">Phone</span>
            <p className="font-medium flex items-center gap-1">
              <Phone size={12} /> {lead.phone || '-'}
            </p>
          </div>
          <div>
            <span className="text-gray-500">Rating</span>
            <p className="font-medium flex items-center gap-1">
              <Star size={12} /> {lead.star_rating?.toFixed(1) || '-'}
            </p>
          </div>
          <div>
            <span className="text-gray-500">Status</span>
            <p><StatusBadge status={lead.outreach_status} /></p>
          </div>
          <div>
            <span className="text-gray-500">Country</span>
            <p className="font-medium">{lead.country || '-'}</p>
          </div>
          <div>
            <span className="text-gray-500">Category</span>
            <p className="font-medium">{lead.category || '-'}</p>
          </div>
          <div>
            <span className="text-gray-500">Verified</span>
            <p className="font-medium">{lead.email_verified ? 'Yes' : 'No'} ({lead.verification_status})</p>
          </div>
          <div>
            <span className="text-gray-500">Scraped</span>
            <p className="font-medium">{lead.scraped_at ? new Date(lead.scraped_at).toLocaleDateString() : '-'}</p>
          </div>
        </div>

        {/* Tags */}
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <Tag size={13} className="text-gray-400" />
            <span className="text-sm font-medium text-gray-700">Tags</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {(lead.tags || []).map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 text-xs bg-violet-100 text-violet-700 px-2 py-1 rounded-full">
                {tag}
                <button onClick={() => handleRemoveTag(tag)} className="hover:text-violet-900">
                  <X size={10} />
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
                className="text-xs border border-gray-300 rounded-full px-3 py-1 w-28 focus:outline-none focus:border-violet-400"
              />
              <button onClick={handleAddTag}
                className="text-xs text-violet-600 hover:text-violet-800 p-1">
                <Plus size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Trustpilot Profile Screenshot */}
        {lead.screenshot_path && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Trustpilot Profile Screenshot</h3>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <img
                src={`/api/screenshots/${lead.screenshot_path.split(/[/\\]/).pop()}`}
                alt={`Trustpilot profile of ${lead.company_name}`}
                className="w-full max-h-[400px] object-contain bg-gray-50"
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Timeline */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Activity</h2>
          <NoteEditor onSubmit={async (content) => { await addNote(content); }} />
          <div className="mt-4">
            <ActivityTimeline notes={notes} />
          </div>
        </div>

        {/* Follow-ups */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Follow-ups</h2>
          <FollowUpScheduler onSchedule={async (date, note) => { await createFollowUp(date, note); }} />
          <div className="mt-4 space-y-2">
            {followUps.map((fu) => (
              <div key={fu.id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                <div>
                  <p className={fu.completed ? 'line-through text-gray-400' : ''}>
                    {new Date(fu.due_date).toLocaleDateString()} — {fu.note || 'No note'}
                  </p>
                </div>
                {!fu.completed && (
                  <button onClick={() => completeFollowUp(fu.id)}
                    className="text-xs text-green-600 hover:underline">Done</button>
                )}
              </div>
            ))}
            {followUps.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-2">No follow-ups scheduled</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
