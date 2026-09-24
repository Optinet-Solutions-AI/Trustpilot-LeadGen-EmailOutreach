'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Card from '../ui/Card';
import LoadingState from '../ui/LoadingState';
import SectionHeader from '../ui/SectionHeader';

/**
 * Seed inbox-placement test monitor. Deliberately left out of the nav — it is
 * reached only by its /seed-test/<runId> link. Send status comes from
 * scripts/seed-placement-send.ts; placement is recorded here by whoever
 * checks the seed mailboxes.
 */

type Placement = 'unchecked' | 'inbox' | 'promotions' | 'spam' | 'not_found';

interface SeedRow {
  ref: string; n: number; email: string; sender: string; subject: string | null;
  status: 'queued' | 'sent' | 'failed'; sent_at: string | null; error: string | null;
  /** Manila day the pair went out, or is planned to (YYYY-MM-DD). */
  scheduled_for?: string | null;
  placement: Placement; placement_at: string | null;
}

const PLACEMENTS: Array<{ value: Placement; label: string; tone: string; bar: string }> = [
  { value: 'unchecked',  label: 'Not checked', tone: 'bg-slate-100 text-slate-600',   bar: 'bg-slate-200' },
  { value: 'inbox',      label: 'Inbox',       tone: 'bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500' },
  { value: 'promotions', label: 'Promotions',  tone: 'bg-amber-50 text-amber-700',     bar: 'bg-amber-400' },
  { value: 'spam',       label: 'Spam',        tone: 'bg-red-50 text-[#ba1a1a]',       bar: 'bg-[#ba1a1a]' },
  { value: 'not_found',  label: 'Not found',   tone: 'bg-slate-200 text-slate-700',    bar: 'bg-slate-500' },
];
const P = Object.fromEntries(PLACEMENTS.map((p) => [p.value, p])) as Record<Placement, (typeof PLACEMENTS)[number]>;

const STATUS_TONE: Record<SeedRow['status'], string> = {
  queued: 'bg-slate-100 text-slate-600',
  sent: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-[#ba1a1a]',
};

type Filter = 'all' | 'unchecked' | 'spam' | 'failed';
type SortKey = 'n' | 'email' | 'sender' | 'status' | 'when' | 'placement';

/** When a row went out, or is planned to: sent rows by their timestamp,
 *  planned rows by their day, so both sort on one timeline. */
const whenKey = (r: SeedRow) => r.sent_at ?? (r.scheduled_for ? `${r.scheduled_for}T23:59:59` : '9999');
const PLACEMENT_ORDER: Record<Placement, number> = { inbox: 0, promotions: 1, spam: 2, not_found: 3, unchecked: 4 };
const STATUS_ORDER: Record<SeedRow['status'], number> = { sent: 0, queued: 1, failed: 2 };

/** "Fri 25 Sep" for a YYYY-MM-DD Manila day. */
const fmtDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const todayManila = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const HEADER_SELECT =
  'mt-1 block w-full min-w-[7rem] normal-case tracking-normal font-semibold text-xs text-on-surface ' +
  'rounded-md border border-slate-200 bg-white px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a]';

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/** The route is served from a static `_id` shell, so the real run id comes
 *  from the browser URL rather than useParams(). */
function runIdFromUrl(): string {
  if (typeof window === 'undefined') return '';
  const m = window.location.pathname.match(/\/seed-test\/([^/?#]+)/);
  const id = m ? decodeURIComponent(m[1]) : '';
  return id === '_id' ? '' : id;
}

export default function SeedTest() {
  const [runId, setRunId] = useState('');
  useEffect(() => { setRunId(runIdFromUrl()); }, []);
  const [rows, setRows] = useState<SeedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [senderF, setSenderF] = useState('all');
  const [statusF, setStatusF] = useState<'all' | SeedRow['status']>('all');
  const [placementF, setPlacementF] = useState<'all' | Placement>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'n', dir: 1 });
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await api.get(`/seed-tests/${encodeURIComponent(runId)}`);
      setRows(res.data.data.results);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this seed test');
    }
  }, [runId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const setPlacement = async (ref: string, placement: Placement) => {
    const before = rows;
    setRows((rs) => rs?.map((r) => (r.ref === ref ? { ...r, placement } : r)) ?? rs);
    setSaving(ref);
    try {
      await api.patch(`/seed-tests/${encodeURIComponent(runId)}/${encodeURIComponent(ref)}`, { placement });
    } catch {
      setRows(before);
      setError('That placement did not save — try again.');
    } finally {
      setSaving(null);
    }
  };

  const senders = useMemo(() => {
    const m = new Map<string, SeedRow[]>();
    for (const r of rows ?? []) m.set(r.sender, [...(m.get(r.sender) ?? []), r]);
    return [...m.entries()];
  }, [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (rows ?? []).filter((r) => {
      if (filter === 'unchecked' && !(r.status === 'sent' && r.placement === 'unchecked')) return false;
      if (filter === 'spam' && r.placement !== 'spam') return false;
      if (filter === 'failed' && r.status !== 'failed') return false;
      if (senderF !== 'all' && r.sender !== senderF) return false;
      if (statusF !== 'all' && r.status !== statusF) return false;
      if (placementF !== 'all' && r.placement !== placementF) return false;
      return !needle || r.email.includes(needle) || r.ref.toLowerCase().includes(needle);
    });
    const val = (r: SeedRow): string | number => {
      switch (sort.key) {
        case 'n': return r.n;
        case 'email': return r.email;
        case 'sender': return r.sender;
        case 'status': return STATUS_ORDER[r.status];
        case 'when': return whenKey(r);
        case 'placement': return PLACEMENT_ORDER[r.placement];
      }
    };
    // Ties fall back to seed number, then sender, so the order is stable.
    return [...list].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va !== vb) return (va < vb ? -1 : 1) * sort.dir;
      return a.n - b.n || a.sender.localeCompare(b.sender);
    });
  }, [rows, filter, q, senderF, statusF, placementF, sort]);

  const anyColumnFilter = senderF !== 'all' || statusF !== 'all' || placementF !== 'all';
  const toggleSort = (key: SortKey) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  if (!rows && !error) return <div className="p-4 lg:p-8"><LoadingState /></div>;

  const sentTotal = (rows ?? []).filter((r) => r.status === 'sent').length;
  const subject = rows?.find((r) => r.subject)?.subject;

  return (
    <div className="p-4 lg:p-8 space-y-6">
      <SectionHeader
        title="Seed Placement"
        accent="Test"
        subtitle={
          <span>
            Run <span className="font-mono">{runId}</span>
            {subject && <> · “{subject}”</>}
            {' '}· {sentTotal} of {rows?.length ?? 0} sent · refreshes every 30s
          </span>
        }
      />

      {error && (
        <div className="rounded-lg bg-red-50 text-[#ba1a1a] px-4 py-3 text-sm">{error}</div>
      )}

      {rows && rows.length === 0 && (
        <Card><p className="text-on-surface-variant">No seeds recorded for this run yet — they appear as soon as the send starts.</p></Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {senders.map(([sender, list]) => {
          const sent = list.filter((r) => r.status === 'sent');
          const failed = list.filter((r) => r.status === 'failed').length;
          const count = (p: Placement) => sent.filter((r) => r.placement === p).length;
          const checked = sent.length - count('unchecked');
          const reached = count('inbox') + count('promotions');
          const [local, domain] = sender.split('@');
          return (
            <Card key={sender} variant="compact">
              <p className="font-bold text-on-surface break-all">{local}@</p>
              <p className="text-xs text-on-surface-variant font-mono break-all">{domain}</p>
              <div className="grid grid-cols-4 gap-2 mt-4">
                {[['Planned', list.length], ['Sent', sent.length], ['Failed', failed], ['Checked', checked]].map(([l, v]) => (
                  <div key={l as string}>
                    <p className="text-[10px] uppercase tracking-wider text-on-surface-variant font-bold">{l}</p>
                    <p className={`text-2xl font-extrabold tabular-nums ${l === 'Failed' && failed ? 'text-[#ba1a1a]' : 'text-on-surface'}`}>{v}</p>
                  </div>
                ))}
              </div>
              <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100 mt-4" role="img"
                   aria-label={PLACEMENTS.slice(1).map((p) => `${p.label} ${count(p.value)}`).join(', ')}>
                {PLACEMENTS.slice(1).map((p) => count(p.value) > 0 && (
                  <div key={p.value} className={p.bar} style={{ width: `${(count(p.value) / Math.max(sent.length, 1)) * 100}%` }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-on-surface-variant">
                {PLACEMENTS.slice(1).map((p) => (
                  <span key={p.value} className="inline-flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-sm ${p.bar}`} />{p.label} {count(p.value)}
                  </span>
                ))}
              </div>
              <p className="text-sm text-on-surface-variant mt-3">
                {checked === 0
                  ? 'No placements recorded yet'
                  : <><span className="font-bold text-on-surface">{Math.round((reached / checked) * 100)}%</span> reached the mailbox (inbox + promotions) of {checked} checked</>}
              </p>
            </Card>
          );
        })}
      </div>

      {rows && rows.some((r) => r.scheduled_for) && (() => {
        const days = [...new Set(rows.map((r) => r.scheduled_for).filter(Boolean) as string[])].sort();
        const today = todayManila();
        const last = days[days.length - 1];
        return (
          <Card variant="flush">
            <div className="px-4 pt-4">
              <p className="font-bold text-on-surface">Send plan</p>
              <p className="text-sm text-on-surface-variant">
                Every seed is mailed once by each sender, at most 20 per sender per day (Manila time).
                {last && <> Last batch: <span className="font-semibold text-on-surface">{fmtDay(last)}</span>.</>}
              </p>
            </div>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-on-surface-variant">
                    <th className="px-4 py-2 font-bold">Day</th>
                    {senders.map(([s]) => <th key={s} className="px-4 py-2 font-bold whitespace-nowrap">{s.split('@')[0]}@</th>)}
                    <th className="px-4 py-2 font-bold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => {
                    const onDay = rows.filter((r) => r.scheduled_for === d);
                    const cell = (list: SeedRow[]) => {
                      const sent = list.filter((r) => r.status === 'sent').length;
                      return sent === list.length ? `${sent} sent` : sent ? `${sent} of ${list.length} sent` : `${list.length} planned`;
                    };
                    return (
                      <tr key={d} className={`border-t border-slate-50 ${d === today ? 'bg-[#b0004a]/5' : ''}`}>
                        <td className="px-4 py-2 whitespace-nowrap font-semibold text-on-surface">
                          {fmtDay(d)}{d === today && <span className="ml-2 text-xs font-bold text-[#b0004a]">today</span>}
                        </td>
                        {senders.map(([s]) => (
                          <td key={s} className="px-4 py-2 whitespace-nowrap text-on-surface-variant">{cell(onDay.filter((r) => r.sender === s))}</td>
                        ))}
                        <td className="px-4 py-2 whitespace-nowrap text-on-surface">{cell(onDay)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })()}

      <Card variant="flush">
        <div className="flex flex-wrap items-center gap-2 p-4 border-b border-slate-50">
          {([['all', 'All'], ['unchecked', 'Not checked yet'], ['spam', 'Spam'], ['failed', 'Send failed']] as Array<[Filter, string]>).map(([f, l]) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a] ${
                filter === f ? 'bg-[#b0004a] text-white' : 'bg-surface-container text-on-surface-variant hover:bg-surface-variant'}`}>
              {l}
            </button>
          ))}
          <span className="text-sm text-on-surface-variant tabular-nums">
            {visible.length} of {rows?.length ?? 0} rows
          </span>
          {anyColumnFilter && (
            <button type="button" onClick={() => { setSenderF('all'); setStatusF('all'); setPlacementF('all'); }}
              className="text-sm font-bold text-[#b0004a] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a] rounded px-1">
              Clear column filters
            </button>
          )}
          <input id="seed-filter" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by address or ref" aria-label="Filter by address or ref"
            className="ml-auto min-w-0 flex-1 sm:flex-none sm:w-64 px-3 py-1.5 rounded-lg border border-slate-200 text-sm bg-white" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-on-surface-variant">
                {([
                  ['n', '#'], ['email', 'Seed'], ['sender', 'Sender'], ['status', 'Send'],
                  ['when', 'Sent / planned'], ['placement', 'Placement'],
                ] as Array<[SortKey, string]>).map(([key, label]) => {
                  const active = sort.key === key;
                  return (
                    <th key={key} className="px-4 py-2 font-bold whitespace-nowrap align-top"
                        aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleSort(key)}
                        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b0004a] rounded ${active ? 'text-on-surface' : ''}`}>
                        {label}
                        <span className={`material-symbols-outlined text-[16px] leading-none ${active ? '' : 'opacity-30'}`}>
                          {active && sort.dir === -1 ? 'arrow_downward' : 'arrow_upward'}
                        </span>
                      </button>
                      {key === 'sender' && (
                        <select id="seed-sender-filter" value={senderF} onChange={(e) => setSenderF(e.target.value)}
                          aria-label="Filter by sender" className={HEADER_SELECT}>
                          <option value="all">All senders</option>
                          {senders.map(([s]) => <option key={s} value={s}>{s.split('@')[0]}@</option>)}
                        </select>
                      )}
                      {key === 'status' && (
                        <select id="seed-status-filter" value={statusF}
                          onChange={(e) => setStatusF(e.target.value as typeof statusF)}
                          aria-label="Filter by send status" className={HEADER_SELECT}>
                          <option value="all">All</option>
                          <option value="sent">Sent</option>
                          <option value="queued">Scheduled</option>
                          <option value="failed">Failed</option>
                        </select>
                      )}
                      {key === 'placement' && (
                        <select id="seed-placement-filter" value={placementF}
                          onChange={(e) => setPlacementF(e.target.value as typeof placementF)}
                          aria-label="Filter by placement" className={HEADER_SELECT}>
                          <option value="all">All</option>
                          {PLACEMENTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                        </select>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.ref} className="border-t border-slate-50">
                  <td className="px-4 py-2 text-on-surface-variant">{r.n}</td>
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{r.email}</td>
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{r.sender.split('@')[0]}@</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_TONE[r.status]}`}>{r.status === 'queued' ? 'scheduled' : r.status}</span>
                    {r.error && <p className="text-xs text-[#ba1a1a] mt-1 max-w-xs">{r.error}</p>}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-on-surface-variant">
                    {r.status === 'queued' && r.scheduled_for ? `Planned ${fmtDay(r.scheduled_for)}` : fmt(r.sent_at)}
                  </td>
                  <td className="px-4 py-2">
                    <select id={`placement-${r.ref}`} value={r.placement} disabled={r.status !== 'sent' || saving === r.ref}
                      onChange={(e) => setPlacement(r.ref, e.target.value as Placement)}
                      aria-label={`Placement for ${r.email}`}
                      className={`rounded-md px-2 py-1 text-xs font-semibold border-0 disabled:opacity-50 ${P[r.placement].tone}`}>
                      {PLACEMENTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && rows && rows.length > 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-on-surface-variant">No seeds match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
