'use client';

import { useState } from 'react';
import { useGroupQueue, GroupCandidate } from '../hooks/useGroupQueue';

const TABS: GroupCandidate['status'][] = ['candidate', 'requested', 'questions', 'joined', 'ignored'];

export default function GroupQueue() {
  const [tab, setTab] = useState<GroupCandidate['status']>('candidate');
  const { rows, loading, error, setStatus, triggerAutoJoin, joining } = useGroupQueue(tab);

  return (
    <div className="p-6 max-w-6xl mx-auto" style={{ fontFamily: 'Manrope, sans-serif' }}>
      <h1 className="text-2xl font-black tracking-tight text-[#b0004a] mb-1">Group Queue</h1>
      <p className="text-sm text-slate-500 mb-5">
        High-value Facebook groups the scraping account hasn&apos;t joined. Open one, join it in
        your logged-in session, and the next scrape will search it automatically.
      </p>

      <div className="flex gap-2 mb-4 items-center justify-between">
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold capitalize transition-colors ${
                tab === t ? 'bg-[#b0004a] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          // TODO: derive from active social_accounts — GB is the only account today
          onClick={() => void triggerAutoJoin('GB')}
          disabled={joining}
          className="px-3 py-1.5 rounded-md bg-[#006630] text-white text-sm font-bold hover:bg-[#005225] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {joining ? 'Joining…' : 'Auto-join eligible groups'}
        </button>
      </div>

      {loading && <p className="text-slate-500 text-sm">Loading…</p>}
      {error && <p className="text-error text-sm">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-slate-400 text-sm">No groups in &quot;{tab}&quot;.</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-2 font-semibold">Group</th>
                <th className="px-4 py-2 font-semibold">Members</th>
                <th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Niche / Location</th>
                <th className="px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <a
                      href={`https://www.facebook.com/groups/${r.group_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#b0004a] font-semibold hover:underline"
                    >
                      {r.name || r.group_id}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{r.member_count_text || '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{r.is_private ? 'Private' : 'Public'}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {[r.niche, r.location].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-2">
                      <a
                        href={`https://www.facebook.com/groups/${r.group_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1 rounded-md bg-[#006630] text-white text-xs font-bold"
                      >
                        Open in FB
                      </a>
                      {tab !== 'joined' && (
                        <button
                          onClick={() => void setStatus(r.id, 'joined')}
                          className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                        >
                          Mark joined
                        </button>
                      )}
                      {tab !== 'ignored' && (
                        <button
                          onClick={() => void setStatus(r.id, 'ignored')}
                          className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                        >
                          Ignore
                        </button>
                      )}
                      {tab !== 'candidate' && (
                        <button
                          onClick={() => void setStatus(r.id, 'candidate')}
                          className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
                        >
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
