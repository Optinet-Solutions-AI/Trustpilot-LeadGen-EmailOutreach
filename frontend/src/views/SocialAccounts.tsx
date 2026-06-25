'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import Button from '../ui/Button';
import LoadingState from '../ui/LoadingState';
import Pill from '../ui/Pill';
import SectionHeader from '../ui/SectionHeader';

type Platform = 'facebook' | 'instagram';
type Status = 'active' | 'checkpoint' | 'banned' | 'disabled';

interface SocialAccount {
  id: string;
  platform: Platform;
  handle: string;
  display_name: string | null;
  status: Status;
  daily_cap: number;
  hourly_cap: number;
  used_today: number;
  used_this_hour: number;
  last_login_at: string | null;
  last_used_at: string | null;
  last_checkpoint_at: string | null;
  checkpoint_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  has_cookies: boolean;
}

// ── Connect flow (DB-row poll) ──────────────────────────────────────────
// The Connect button writes a request row to the DB and the Windows EC2
// worker fulfills it asynchronously. We poll /connect-status every 2s
// for the tunnel URL, open it in a new tab when ready, and close the
// modal when the worker captures the FB session cookie.
interface ConnectStream {
  kind: 'connect';
  status: 'idle' | 'requesting' | 'provisioning' | 'ready' | 'captured' | 'failed' | 'expired';
  tunnelUrl: string | null;
  error?: string;
  // Whether we've already opened the tab — guards against the polling
  // loop re-opening it every tick once the URL appears.
  tabOpened: boolean;
}

// ── Recover flow (SSE) ─────────────────────────────────────────────────
// The /recover endpoint streams stage events over SSE. Shape unchanged.
interface RecoverStream {
  kind: 'recover';
  stages: { stage: string; detail: string | null }[];
  // Raw stdout/stderr lines for debugging silent failures (missing env
  // key, missing python dep, etc.). Surface in the UI so the operator
  // sees SOMETHING when Python explodes before emitting STAGE events.
  diagnostics: { kind: 'stdout' | 'stderr' | 'http'; line: string }[];
  status: 'idle' | 'streaming' | 'done' | 'failed';
  error?: string;
}

type AccountStream = ConnectStream | RecoverStream;

const STATUS_VARIANT: Record<Status, 'success' | 'info' | 'error' | 'neutral'> = {
  active: 'success',
  checkpoint: 'info',
  banned: 'error',
  disabled: 'neutral',
};

const STAGE_LABEL: Record<string, string> = {
  browser_open: 'Browser launching',
  autofilled: 'Login form pre-filled — click Log in inside the browser',
  waiting_for_login: 'Log in inside the browser window',
  waiting_for_checkpoint_clear: 'Clear the captcha inside the browser window',
  cookies_captured: 'Cookies captured',
  done: 'Done',
  failed: 'Failed',
};

export default function SocialAccounts() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    platform: 'facebook' as Platform,
    handle: '',
    display_name: '',
    password: '',  // optional autofill; never stored in DB or persisted in browser state
  });
  const [streams, setStreams] = useState<Record<string, AccountStream>>({});
  const eventSources = useRef<Record<string, EventSource>>({});
  const pollIntervals = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // ── load ──
  const load = useCallback(async () => {
    try {
      const res = await api.get('/social-accounts');
      setAccounts(res.data.data ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      // Cleanup any open SSE streams on unmount.
      Object.values(eventSources.current).forEach((es) => es.close());
      // Cleanup any in-flight polling intervals on unmount.
      Object.values(pollIntervals.current).forEach(clearInterval);
      pollIntervals.current = {};
    };
  }, [load]);

  // ── connect (DB-row poll) ────────────────────────────────────────────
  // POST /connect to create the request row, then poll /connect-status
  // every 2s. When the worker marks status=ready the tunnel URL is opened
  // in a new tab. Polling self-terminates on captured/failed/expired.
  const driveConnect = useCallback(async (accountId: string) => {
    // Cancel any in-flight interval for this account before starting a new one.
    if (pollIntervals.current[accountId]) {
      clearInterval(pollIntervals.current[accountId]);
      delete pollIntervals.current[accountId];
    }

    setStreams((prev) => ({
      ...prev,
      [accountId]: { kind: 'connect', status: 'requesting', tunnelUrl: null, tabOpened: false },
    }));

    try {
      await api.post(`/social-accounts/${accountId}/connect`);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        .response?.data?.error ?? (err as Error).message ?? 'Failed to start connect flow';
      setStreams((prev) => ({
        ...prev,
        [accountId]: { kind: 'connect', status: 'failed', tunnelUrl: null, tabOpened: false, error: msg },
      }));
      return;
    }

    // Poll every 2s until terminal status.
    const pollInterval = setInterval(() => {
      void (async () => {
        try {
          const res = await api.get(`/social-accounts/${accountId}/connect-status`);
          const view = res.data.data as {
            connect_status: string | null;
            connect_tunnel_url: string | null;
            connect_error: string | null;
          };
          setStreams((prev) => {
            const cur = prev[accountId];
            if (!cur || cur.kind !== 'connect' || cur.status === 'idle') {
              clearInterval(pollIntervals.current[accountId]);
              delete pollIntervals.current[accountId];
              return prev;
            }
            const next: ConnectStream = { ...cur };
            const s = view.connect_status ?? 'requested';
            if (s === 'requested') next.status = 'requesting';
            else if (s === 'provisioning') next.status = 'provisioning';
            else if (s === 'ready') next.status = 'ready';
            else if (s === 'captured') next.status = 'captured';
            else if (s === 'failed') { next.status = 'failed'; next.error = view.connect_error ?? 'unknown'; }
            else if (s === 'expired') { next.status = 'expired'; next.error = 'login window expired (10 min)'; }

            if (view.connect_tunnel_url && !cur.tabOpened) {
              next.tunnelUrl = view.connect_tunnel_url;
              next.tabOpened = true;
              window.open(view.connect_tunnel_url, '_blank', 'noopener,noreferrer');
            }

            if (next.status === 'captured' || next.status === 'failed' || next.status === 'expired') {
              clearInterval(pollIntervals.current[accountId]);
              delete pollIntervals.current[accountId];
              if (next.status === 'captured') {
                // Refresh the accounts list so the new active status shows.
                void load();
              }
            }
            return { ...prev, [accountId]: next };
          });
        } catch (err) {
          setStreams((prev) => {
            const cur = prev[accountId];
            if (!cur || cur.kind !== 'connect') return prev;
            return {
              ...prev,
              [accountId]: { ...cur, status: 'failed' as const, error: (err as Error).message },
            };
          });
          clearInterval(pollIntervals.current[accountId]);
          delete pollIntervals.current[accountId];
        }
      })();
    }, 2_000);
    pollIntervals.current[accountId] = pollInterval;
  }, [load]);

  // ── recover (SSE over POST via fetch) ───────────────────────────────
  // /recover streams stage events over SSE — shape unchanged from before.
  const driveLoginFlow = useCallback(async (
    id: string,
    mode: 'recover',
    creds?: { username?: string; password?: string },
  ) => {
    setStreams((prev) => ({ ...prev, [id]: { kind: 'recover', stages: [], diagnostics: [], status: 'streaming' } }));

    // Mirror the axios client's base resolution: NEXT_PUBLIC_API_BASE_URL + '/api'.
    // We can't use axios for SSE (it consumes the body as JSON), so this raw
    // fetch has to reconstruct the same URL shape by hand.
    const envBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
    const apiBase = envBase ? `${envBase}/api` : '/api';
    const url = `${apiBase}/social-accounts/${id}/${mode}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.NEXT_PUBLIC_API_SECRET_KEY
          ? { 'x-api-key': process.env.NEXT_PUBLIC_API_SECRET_KEY }
          : {}),
      },
      body: creds ? JSON.stringify(creds) : undefined,
    });
    if (!resp.ok || !resp.body) {
      setStreams((prev) => ({
        ...prev,
        [id]: {
          kind: 'recover',
          stages: [],
          diagnostics: [{ kind: 'http', line: `HTTP ${resp.status} ${resp.statusText}` }],
          status: 'failed',
          error: `HTTP ${resp.status}`,
        },
      }));
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let lastEvent: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) {
            lastEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const payload = JSON.parse(line.slice(6)) as { stage?: string; detail?: string | null; line?: string; code?: number };
            setStreams((prev) => {
              const cur = prev[id];
              if (!cur || cur.kind !== 'recover') return prev;
              if (lastEvent === 'stage') {
                return {
                  ...prev,
                  [id]: {
                    ...cur,
                    stages: [...cur.stages, payload as { stage: string; detail: string | null }],
                    status: payload.stage === 'done'
                      ? 'done'
                      : payload.stage === 'failed'
                      ? 'failed'
                      : 'streaming',
                    error: payload.stage === 'failed' ? (payload.detail ?? undefined) : cur.error,
                  },
                };
              }
              if (lastEvent === 'stdout' || lastEvent === 'stderr') {
                return {
                  ...prev,
                  [id]: {
                    ...cur,
                    diagnostics: [...cur.diagnostics, { kind: lastEvent as 'stdout' | 'stderr', line: payload.line ?? '' }],
                  },
                };
              }
              if (lastEvent === 'exit') {
                void load();
                // If Python exited non-zero without ever emitting a 'failed' stage,
                // surface that so the card doesn't look stuck on "streaming".
                if (payload.code !== 0 && cur.status === 'streaming') {
                  return {
                    ...prev,
                    [id]: { ...cur, status: 'failed', error: `Python exited ${payload.code}` },
                  };
                }
              }
              return prev;
            });
          }
        }
      }
    }
  }, [load]);

  // ── create ── one click: write the row, then immediately start the
  // connect flow. Password is POSTed once, never persisted in the DB or
  // in browser state after the request resolves.
  const onCreate = async () => {
    try {
      const res = await api.post('/social-accounts', {
        platform: form.platform,
        handle: form.handle.trim(),
        display_name: form.display_name.trim() || undefined,
      });
      const newId: string | undefined = res.data?.data?.id;
      // Reset form FIRST so the password leaves React state immediately.
      setForm({ platform: 'facebook', handle: '', display_name: '', password: '' });
      setShowCreate(false);
      await load();
      if (newId) {
        void driveConnect(newId);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── caps edit ──
  const [editCapsId, setEditCapsId] = useState<string | null>(null);
  const [capsDraft, setCapsDraft] = useState<{ daily_cap: number; hourly_cap: number }>({ daily_cap: 50, hourly_cap: 10 });
  const onSaveCaps = async (id: string) => {
    try {
      await api.patch(`/social-accounts/${id}`, capsDraft);
      setEditCapsId(null);
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── delete ──
  const onDelete = async (id: string) => {
    if (!confirm('Delete this account? Cookies will be lost.')) return;
    try {
      await api.delete(`/social-accounts/${id}`);
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── render ──
  const grouped = useMemo(() => ({
    facebook: accounts.filter((a) => a.platform === 'facebook'),
    instagram: accounts.filter((a) => a.platform === 'instagram'),
  }), [accounts]);

  if (loading) return <LoadingState />;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <SectionHeader
        title="Social Accounts"
        subtitle="Connected Facebook and Instagram sessions used by the scraper. (build: v3-poll)"
        actions={
          <Button onClick={() => setShowCreate((v) => !v)}>
            <span className="material-symbols-outlined text-[18px] mr-1">add</span>
            Add account
          </Button>
        }
      />

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Platform</span>
              <select
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}
              >
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Username / email</span>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                placeholder={form.platform === 'facebook' ? 'jane@example.com' : '@jane_doe'}
                value={form.handle}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, handle: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">
                Password <span className="text-slate-400 font-normal">(optional)</span>
              </span>
              <input
                type="password"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                placeholder="Not stored"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Label (optional)</span>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                placeholder="e.g. OptiRate-FB-01"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-xs text-slate-500 max-w-2xl">
              <strong>Save &amp; connect</strong> creates the row and queues a remote browser session
              on the Windows worker. A new tab will open automatically when the browser is ready —
              log into Facebook there. {' '}
              <span className="text-amber-700">Password field is unused in the new flow and will be removed shortly.</span>
            </p>
            <Button onClick={onCreate} disabled={!form.handle.trim()}>
              <span className="material-symbols-outlined text-[18px] mr-1">login</span>
              Save &amp; connect
            </Button>
          </div>
        </div>
      )}

      {/* Accounts list, grouped by platform */}
      {(['facebook', 'instagram'] as Platform[]).map((p) => (
        <section key={p} className="mt-8">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-3">
            {p === 'facebook' ? 'Facebook' : 'Instagram'} ({grouped[p].length})
          </h3>
          {grouped[p].length === 0 ? (
            <p className="text-sm text-slate-400 italic">No accounts connected.</p>
          ) : (
            <div className="space-y-3">
              {grouped[p].map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  stream={streams[a.id]}
                  editingCaps={editCapsId === a.id}
                  capsDraft={capsDraft}
                  onConnect={() => void driveConnect(a.id)}
                  onRecover={() => void driveLoginFlow(a.id, 'recover')}
                  onRetryConnect={() => void driveConnect(a.id)}
                  onEditCaps={() => {
                    setEditCapsId(a.id);
                    setCapsDraft({ daily_cap: a.daily_cap, hourly_cap: a.hourly_cap });
                  }}
                  onChangeCaps={setCapsDraft}
                  onSaveCaps={() => onSaveCaps(a.id)}
                  onCancelCaps={() => setEditCapsId(null)}
                  onDelete={() => onDelete(a.id)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// ── AccountCard component ────────────────────────────────────────────
interface AccountCardProps {
  account: SocialAccount;
  stream: AccountStream | undefined;
  editingCaps: boolean;
  capsDraft: { daily_cap: number; hourly_cap: number };
  onConnect: () => void;
  onRecover: () => void;
  onRetryConnect: () => void;
  onEditCaps: () => void;
  onChangeCaps: (v: { daily_cap: number; hourly_cap: number }) => void;
  onSaveCaps: () => void;
  onCancelCaps: () => void;
  onDelete: () => void;
}

function AccountCard({
  account: a, stream, editingCaps, capsDraft,
  onConnect, onRecover, onRetryConnect, onEditCaps, onChangeCaps, onSaveCaps, onCancelCaps, onDelete,
}: AccountCardProps) {
  const lastSeen = a.last_login_at
    ? new Date(a.last_login_at).toLocaleString()
    : 'never';

  // Derive disabled state for connect/recover buttons from stream activity.
  const connectBusy = stream?.kind === 'connect' &&
    (stream.status === 'requesting' || stream.status === 'provisioning' || stream.status === 'ready');
  const recoverBusy = stream?.kind === 'recover' && stream.status === 'streaming';

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-900 truncate">
              {a.display_name || a.handle}
            </span>
            <Pill variant={STATUS_VARIANT[a.status]}>{a.status}</Pill>
            {a.has_cookies && <Pill variant="info">cookies on file</Pill>}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            <code className="bg-slate-100 px-1 rounded">{a.handle}</code>
            {' · '}last login {lastSeen}
            {a.checkpoint_reason && (
              <span className="text-amber-700 ml-2">
                checkpoint: {a.checkpoint_reason}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {!a.has_cookies && (
            <Button onClick={onConnect} disabled={connectBusy || recoverBusy}>
              Connect
            </Button>
          )}
          {a.status === 'checkpoint' && (
            <Button onClick={onRecover} disabled={connectBusy || recoverBusy}>
              Recover
            </Button>
          )}
          {a.has_cookies && a.status === 'active' && (
            <Button onClick={onConnect} disabled={connectBusy || recoverBusy}>
              Re-login
            </Button>
          )}
        </div>
      </div>

      {/* Caps + counters */}
      <div className="mt-3 flex items-center gap-4 text-xs text-slate-600">
        {editingCaps ? (
          <>
            <label className="flex items-center gap-1">
              daily cap
              <input
                type="number"
                className="w-16 rounded border border-slate-300 px-1 py-0.5"
                value={capsDraft.daily_cap}
                onChange={(e) => onChangeCaps({ ...capsDraft, daily_cap: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1">
              hourly cap
              <input
                type="number"
                className="w-16 rounded border border-slate-300 px-1 py-0.5"
                value={capsDraft.hourly_cap}
                onChange={(e) => onChangeCaps({ ...capsDraft, hourly_cap: Number(e.target.value) })}
              />
            </label>
            <Button onClick={onSaveCaps}>Save</Button>
            <button className="text-slate-500 underline" onClick={onCancelCaps}>cancel</button>
          </>
        ) : (
          <>
            <span>
              daily {a.used_today}/{a.daily_cap}
            </span>
            <span>
              hourly {a.used_this_hour}/{a.hourly_cap}
            </span>
            <button className="text-blue-600 underline" onClick={onEditCaps}>edit caps</button>
            <button className="text-red-600 underline ml-auto" onClick={onDelete}>delete</button>
          </>
        )}
      </div>

      {/* Connect flow status (DB-row poll) */}
      {stream?.kind === 'connect' && stream.status !== 'idle' && (
        <div className="mt-3 rounded-lg border border-[#b0004a]/20 bg-[#ffd9de]/30 p-3 text-xs space-y-1">
          {stream.status === 'requesting' && (
            <p className="font-semibold text-[#b0004a]">Requesting a remote browser…</p>
          )}
          {stream.status === 'provisioning' && (
            <p className="font-semibold text-[#b0004a]">Provisioning your remote browser on the worker (~15s)…</p>
          )}
          {stream.status === 'ready' && (
            <>
              <p className="font-semibold text-[#b0004a]">Remote browser is ready.</p>
              <p className="text-slate-600">Click to open it (the browser may block auto-open), then log into Facebook. This window updates automatically once cookies are captured.</p>
              {stream.tunnelUrl && (
                <div className="mt-1 space-y-1">
                  <a
                    href={stream.tunnelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-3 py-1.5 rounded bg-[#b0004a] text-white font-semibold no-underline"
                  >
                    Open remote browser ↗
                  </a>
                  <p className="text-[11px] text-slate-500 break-all select-all">{stream.tunnelUrl}</p>
                </div>
              )}
            </>
          )}
          {stream.status === 'captured' && (
            <p className="font-semibold text-emerald-700">✓ Cookies captured — account is active.</p>
          )}
          {(stream.status === 'failed' || stream.status === 'expired') && (
            <>
              <p className="font-semibold text-red-700">{stream.error ?? 'Connect failed.'}</p>
              <button onClick={onRetryConnect} className="text-[#b0004a] underline">
                Try again
              </button>
            </>
          )}
        </div>
      )}

      {/* Recover flow status (SSE) */}
      {stream?.kind === 'recover' && (stream.stages.length > 0 || stream.diagnostics.length > 0 || stream.status === 'streaming') && (
        <div className="mt-3 p-2 bg-slate-50 rounded text-xs space-y-0.5 font-mono">
          {stream.status === 'streaming' && stream.stages.length === 0 && (
            <div className="text-slate-500 italic">Starting…</div>
          )}
          {stream.stages.map((s, i) => (
            <div
              key={`s-${i}`}
              className={
                s.stage === 'failed' ? 'text-red-700' :
                s.stage === 'done' ? 'text-green-700' :
                'text-slate-700'
              }
            >
              [{i + 1}] {STAGE_LABEL[s.stage] ?? s.stage}
              {s.detail ? ` — ${s.detail}` : ''}
            </div>
          ))}
          {stream.diagnostics.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-slate-500 select-none">
                show {stream.diagnostics.length} diagnostic line{stream.diagnostics.length === 1 ? '' : 's'}
              </summary>
              <div className="mt-1 space-y-0.5">
                {stream.diagnostics.map((d, i) => (
                  <div
                    key={`d-${i}`}
                    className={d.kind === 'stderr' || d.kind === 'http' ? 'text-red-600' : 'text-slate-500'}
                  >
                    [{d.kind}] {d.line.trim()}
                  </div>
                ))}
              </div>
            </details>
          )}
          {stream.status === 'failed' && stream.error && (
            <div className="text-red-700 font-bold mt-1">⚠ {stream.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
