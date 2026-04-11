'use client';

import { useState } from 'react';

type Folder = 'inbox' | 'sent' | 'drafts' | 'spam';
type Thread = {
  id: string;
  name: string;
  subject: string;
  preview: string;
  time: string;
  tag?: { label: string; color: string };
  unread?: boolean;
};

const MOCK_THREADS: Thread[] = [
  { id: '1', name: 'Prospect — Test', subject: 'Re: OptiRate — Reputation Management Proposal', preview: 'Hi, I reviewed the proposal. Could you clarify the pricing for the growth plan...', time: 'Just now', tag: { label: 'New Lead', color: 'bg-blue-100 text-blue-700' }, unread: true },
  { id: '2', name: 'Demo Company Ltd', subject: 'Follow-up: Let\'s connect this week', preview: 'Following up on my last message. Are you available for a 15-minute call this week?', time: '2h ago', tag: { label: 'Replied', color: 'bg-[#8ff9a8]/40 text-[#006630]' } },
  { id: '3', name: 'Sample Business GmbH', subject: 'Introduction from OptiRate', preview: 'Noticed your Trustpilot rating could use some support. We help companies like yours...', time: 'Yesterday', },
];

const FOLDERS: { key: Folder; icon: string; label: string; count?: number }[] = [
  { key: 'inbox',  icon: 'inbox',                label: 'Inbox',  count: 12 },
  { key: 'sent',   icon: 'send',                 label: 'Sent' },
  { key: 'drafts', icon: 'draft',                label: 'Drafts' },
  { key: 'spam',   icon: 'report_gmailerrorred', label: 'Spam' },
];

export default function Inbox() {
  const [folder, setFolder] = useState<Folder>('inbox');
  const [selected, setSelected] = useState<Thread | null>(MOCK_THREADS[0]);

  return (
    <div className="ml-0 flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Pane 1 — Folder Nav */}
      <div className="w-48 bg-surface-container-low flex-shrink-0 flex flex-col py-6 border-r border-surface-container">
        <p className="px-6 mb-6 text-xs font-bold text-slate-400 uppercase tracking-widest">Mailboxes</p>
        <nav className="space-y-1 px-3">
          {FOLDERS.map(({ key, icon, label, count }) => (
            <button
              key={key}
              onClick={() => setFolder(key)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                folder === key
                  ? 'bg-surface-container-lowest text-[#b0004a] font-bold'
                  : 'text-slate-600 hover:bg-surface-container-high'
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={folder === key ? { fontVariationSettings: "'FILL' 1" } : undefined}
                >
                  {icon}
                </span>
                {label}
              </div>
              {count && (
                <span className="text-[10px] bg-[#b0004a] text-white px-1.5 py-0.5 rounded-full font-black">
                  {count}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="px-6 mt-8 mb-4 text-xs font-bold text-slate-400 uppercase tracking-widest">Lead Stage</div>
        <div className="space-y-3 px-6">
          {[
            { dot: 'bg-blue-500',   label: 'New Lead' },
            { dot: 'bg-amber-500',  label: 'Negotiating' },
            { dot: 'bg-[#006630]',  label: 'Closed-Won' },
            { dot: 'bg-error',      label: 'Lost' },
          ].map(({ dot, label }) => (
            <div key={label} className="flex items-center gap-2 cursor-pointer group">
              <div className={`w-2 h-2 rounded-full ${dot}`} />
              <span className="text-sm text-slate-600 group-hover:text-on-surface transition-colors">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Pane 2 — Thread List */}
      <div className="w-96 flex-shrink-0 bg-white border-r border-surface-container-high flex flex-col">
        <div className="p-6 border-b border-surface-container">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {folder === 'inbox' ? `Unread (${MOCK_THREADS.filter((t) => t.unread).length})` : folder.charAt(0).toUpperCase() + folder.slice(1)}
            </h2>
            <button className="text-xs font-semibold text-[#b0004a] hover:underline">
              Mark all read
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {MOCK_THREADS.map((thread) => (
            <button
              key={thread.id}
              onClick={() => setSelected(thread)}
              className={`w-full text-left p-6 border-b border-surface-container hover:bg-surface-container-low transition-colors ${
                selected?.id === thread.id ? 'border-l-4 border-l-[#b0004a] bg-[#b0004a]/[0.02]' : 'border-l-4 border-l-transparent'
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className={`font-bold text-sm ${thread.unread ? 'text-on-surface' : 'text-on-surface/80'}`}>
                  {thread.name}
                </span>
                <span className="text-[10px] text-slate-400 font-medium flex-shrink-0 ml-2">{thread.time}</span>
              </div>
              <p className={`text-sm mb-1 line-clamp-1 ${thread.unread ? 'text-[#b0004a] font-semibold' : 'text-on-surface font-medium'}`}>
                {thread.subject}
              </p>
              <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{thread.preview}</p>
              {thread.tag && (
                <div className="mt-3">
                  <span className={`px-2 py-0.5 rounded-full ${thread.tag.color} text-[10px] font-bold`}>
                    {thread.tag.label}
                  </span>
                </div>
              )}
            </button>
          ))}

          {MOCK_THREADS.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 text-secondary gap-3">
              <span className="material-symbols-outlined text-4xl text-slate-300">inbox</span>
              <p className="text-sm">No messages yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Pane 3 — Reading Pane */}
      <div className="flex-1 bg-background overflow-y-auto relative flex flex-col">
        {selected ? (
          <div className="max-w-3xl mx-auto py-10 px-10 flex-1">
            {/* Email Header */}
            <div className="bg-surface-container-lowest rounded-xl p-8 ambient-shadow mb-6">
              <div className="flex items-start justify-between mb-8">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-full primary-gradient flex items-center justify-center text-white text-xl font-bold">
                    {selected.name.charAt(0)}
                  </div>
                  <div>
                    <h2
                      className="text-xl font-bold text-on-surface"
                      style={{ fontFamily: 'Manrope, sans-serif' }}
                    >
                      {selected.name}
                    </h2>
                    <p className="text-sm text-slate-500">reply@{selected.name.toLowerCase().replace(/\s+/g, '')}.com</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button className="p-2 rounded-lg hover:bg-surface-container text-slate-400 transition-colors">
                    <span className="material-symbols-outlined">star</span>
                  </button>
                  <button className="p-2 rounded-lg hover:bg-surface-container text-slate-400 transition-colors">
                    <span className="material-symbols-outlined">more_vert</span>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-y-3 text-sm">
                <span className="text-slate-400 font-medium">From:</span>
                <span className="font-semibold text-on-surface">{selected.name}</span>
                <span className="text-slate-400 font-medium">To:</span>
                <span className="text-on-surface">jordi@optiratesolutions.com</span>
                <span className="text-slate-400 font-medium">Subject:</span>
                <span className="text-[#b0004a] font-bold text-base">{selected.subject}</span>
              </div>
            </div>

            {/* Email Body */}
            <div className="bg-surface-container-lowest rounded-xl p-10 ambient-shadow flex-1">
              <div className="text-on-surface leading-relaxed space-y-4 text-sm">
                <p>Hi,</p>
                <p>{selected.preview}</p>
                <p className="text-slate-500 italic text-xs mt-6 pt-4 border-t border-slate-100">
                  — Original message from jordi@optiratesolutions.com —
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center flex-col gap-4 text-secondary">
            <span className="material-symbols-outlined text-6xl text-slate-200">mark_email_unread</span>
            <p className="font-medium">Select a conversation to read</p>
          </div>
        )}

        {/* Reply Bar */}
        {selected && (
          <div className="sticky bottom-0 left-0 right-0 px-10 pb-8 pointer-events-none">
            <div className="max-w-3xl mx-auto glass-panel rounded-full shadow-lg border border-white/20 p-2 flex items-center justify-between pointer-events-auto">
              <div className="flex items-center gap-2 pl-4 flex-1">
                <span className="material-symbols-outlined text-[#b0004a] text-[20px]">reply</span>
                <input
                  type="text"
                  placeholder={`Reply to ${selected.name}...`}
                  className="flex-1 bg-transparent border-none focus:outline-none text-sm text-on-surface placeholder-slate-400"
                />
              </div>
              <div className="flex items-center gap-2">
                <button className="px-6 py-2 primary-gradient text-white rounded-full text-sm font-bold hover:scale-[1.02] transition-transform">
                  Send
                </button>
                <button className="p-2 rounded-full hover:bg-surface-container transition-colors">
                  <span className="material-symbols-outlined text-slate-500 text-[18px]">attach_file</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
