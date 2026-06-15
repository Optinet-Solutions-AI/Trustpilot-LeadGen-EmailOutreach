'use client';

import { MessageSquare, ArrowRight, Mail, Phone, Clock, ShieldCheck, MailQuestion, MailX, UserCheck, UserX, Sparkles, Search, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { LeadNote } from '../types/lead';

const TYPE_CONFIG: Record<string, { icon: typeof MessageSquare; color: string }> = {
  note: { icon: MessageSquare, color: 'text-gray-500 bg-gray-100' },
  status_change: { icon: ArrowRight, color: 'text-blue-500 bg-blue-100' },
  email_sent: { icon: Mail, color: 'text-green-500 bg-green-100' },
  email_opened: { icon: Mail, color: 'text-purple-500 bg-purple-100' },
  email_replied: { icon: Mail, color: 'text-teal-500 bg-teal-100' },
  email_replied_manually: { icon: Mail, color: 'text-teal-500 bg-teal-100' },
  email_bounced: { icon: Mail, color: 'text-red-500 bg-red-100' },
  call: { icon: Phone, color: 'text-orange-500 bg-orange-100' },
  follow_up: { icon: Clock, color: 'text-yellow-500 bg-yellow-100' },
  verification: { icon: ShieldCheck, color: 'text-cyan-500 bg-cyan-100' },
  // Auto-reply lifecycle (added in migration 028).
  auto_reply_received:        { icon: MailQuestion, color: 'text-amber-600 bg-amber-100' },
  auto_reply_no_contacts:     { icon: MailX,        color: 'text-slate-500 bg-slate-100' },
  auto_reply_candidate:       { icon: Search,       color: 'text-slate-500 bg-slate-100' },
  discovered_contact_accepted:  { icon: UserCheck, color: 'text-green-600 bg-green-100' },
  discovered_contact_dismissed: { icon: UserX,     color: 'text-slate-500 bg-slate-100' },
  lead_spawned_from_discovery:  { icon: Sparkles,  color: 'text-purple-600 bg-purple-100' },
};

// Note types that map to an email conversation — these deep-link to the Inbox
// thread so the user can see what was actually sent / replied.
const INBOX_THREAD_TYPES = new Set([
  'email_sent', 'email_opened', 'email_replied', 'email_replied_manually',
  'email_bounced', 'auto_reply_received', 'auto_reply_no_contacts', 'auto_reply_candidate',
]);

/**
 * Resolve a note to an in-app destination, or null if it isn't linkable.
 *  - email / reply / auto-reply notes → the Inbox conversation. The Inbox opens
 *    by campaign_lead_id; notes carry campaign_id, so we map it via the lead's
 *    campaign memberships (some auto-reply notes carry source_campaign_lead_id
 *    directly, which we prefer).
 *  - a lead spawned from a discovered URL → that new lead's detail page.
 */
function resolveNoteHref(note: LeadNote, campaignLeadByCampaign: Record<string, string>): string | null {
  const md = (note.metadata ?? {}) as Record<string, unknown>;

  if (note.type === 'lead_spawned_from_discovery' && typeof md.new_lead_id === 'string') {
    return `/leads/${md.new_lead_id}`;
  }

  if (INBOX_THREAD_TYPES.has(note.type)) {
    const direct = typeof md.source_campaign_lead_id === 'string' ? md.source_campaign_lead_id : '';
    const viaCampaign = typeof md.campaign_id === 'string' ? campaignLeadByCampaign[md.campaign_id] : undefined;
    const cl = direct || viaCampaign;
    if (cl) return `/inbox?open=${encodeURIComponent(cl)}`;
  }

  return null;
}

export default function ActivityTimeline({
  notes,
  campaignLeadByCampaign = {},
}: {
  notes: LeadNote[];
  /** Map of campaign_id → campaign_lead_id for this lead, used to deep-link notes. */
  campaignLeadByCampaign?: Record<string, string>;
}) {
  const router = useRouter();

  return (
    <div className="space-y-3">
      {notes.map((note) => {
        const cfg = TYPE_CONFIG[note.type] || TYPE_CONFIG.note;
        const Icon = cfg.icon;
        const href = resolveNoteHref(note, campaignLeadByCampaign);
        const isInboxLink = href?.startsWith('/inbox') ?? false;

        return (
          <div key={note.id} className="flex gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${cfg.color}`}>
              <Icon size={14} />
            </div>
            <div className="flex-1 min-w-0">
              {href ? (
                <button
                  type="button"
                  onClick={() => router.push(href)}
                  title={isInboxLink ? 'Open the conversation in the Inbox' : 'Open the linked lead'}
                  className="group inline-flex items-start gap-1 text-left text-sm text-[#b0004a] hover:underline"
                >
                  <span>{note.content || note.type}</span>
                  <ExternalLink size={12} className="mt-0.5 shrink-0 opacity-60 group-hover:opacity-100" />
                </button>
              ) : (
                <p className="text-sm text-gray-700">{note.content || note.type}</p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(note.created_at).toLocaleString()}
              </p>
            </div>
          </div>
        );
      })}
      {notes.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-4">No activity yet</p>
      )}
    </div>
  );
}
