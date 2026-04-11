'use client';

type Folder = 'inbox' | 'sent' | 'drafts' | 'spam';

const FOLDERS: { key: Folder; icon: string; label: string }[] = [
  { key: 'inbox',  icon: 'inbox',                label: 'Inbox'  },
  { key: 'sent',   icon: 'send',                 label: 'Sent'   },
  { key: 'drafts', icon: 'draft',                label: 'Drafts' },
  { key: 'spam',   icon: 'report_gmailerrorred', label: 'Spam'   },
];

const STAGE_LEGEND = [
  { label: 'New Lead',   color: 'bg-blue-100 text-blue-700'          },
  { label: 'Replied',    color: 'bg-[#8ff9a8]/40 text-[#006630]'     },
  { label: 'Interested', color: 'bg-amber-100 text-amber-700'        },
  { label: 'Closed',     color: 'bg-surface-container text-secondary' },
];

export default function Inbox() {
  return (
    <div className="flex h-full" style={{ height: 'calc(100vh - 4rem)' }}>

      {/* Left pane — folder nav */}
      <div className="w-56 border-r border-slate-100 bg-surface-container-lowest flex flex-col shrink-0">
        <div className="px-5 py-6 border-b border-slate-100">
          <h2 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>Inbox</h2>
          <p className="text-xs text-secondary mt-0.5">Reply tracking</p>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {FOLDERS.map((f) => (
            <div
              key={f.key}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold cursor-not-allowed opacity-40 ${
                f.key === 'inbox' ? 'bg-[#ffd9de]/20 text-[#b0004a]' : 'text-secondary'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">{f.icon}</span>
              {f.label}
            </div>
          ))}
        </nav>
        {/* Lead stage legend */}
        <div className="px-5 py-4 border-t border-slate-100">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-secondary mb-3">Lead Stage</p>
          {STAGE_LEGEND.map(({ label, color }) => (
            <div key={label} className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${color}`}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Center + right pane — empty state */}
      <div className="flex-1 flex flex-col items-center justify-center bg-[#f8f9fa] text-center px-8">
        <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-5">
          <span className="material-symbols-outlined text-[32px] text-secondary">inbox</span>
        </div>
        <h3 className="text-xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Inbox syncing coming soon
        </h3>
        <p className="text-sm text-secondary max-w-md leading-relaxed mb-6">
          Replies are already tracked automatically. Check{' '}
          <span className="font-bold text-on-surface">Campaign stats</span> for open/reply counts,
          and each lead&apos;s <span className="font-bold text-on-surface">Activity Timeline</span> for reply snippets and status changes.
        </p>
        <div className="flex flex-col gap-3 items-center">
          <div className="flex items-center gap-3 px-5 py-3 bg-white rounded-xl border border-slate-100 ambient-shadow text-sm text-secondary">
            <span className="material-symbols-outlined text-[#b0004a] text-[20px]">campaign</span>
            <span>Campaign replies → <span className="font-bold text-on-surface">Campaigns → View Details → Lead Status</span></span>
          </div>
          <div className="flex items-center gap-3 px-5 py-3 bg-white rounded-xl border border-slate-100 ambient-shadow text-sm text-secondary">
            <span className="material-symbols-outlined text-[#b0004a] text-[20px]">person</span>
            <span>Individual replies → <span className="font-bold text-on-surface">Lead Matrix → Lead Profile → Activity</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}
