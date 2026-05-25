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

interface ConnectStream {
  stages: { stage: string; detail: string | null }[];
  status: 'idle' | 'streaming' | 'done' | 'failed';
  error?: string;
}

const STATUS_VARIANT: Record<Status, 'success' | 'info' | 'error' | 'neutral'> = {
  active: 'success',
  checkpoint: 'info',
  banned: 'error',
  disabled: 'neutral',
};

const STAGE_LABEL: Record<string, string> = {
  browser_open: 'Browser launching',
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
  const [form, setForm] = useState({ platform: 'facebook' as Platform, handle: '', display_name: '' });
  const [streams, setStreams] = useState<Record<string, ConnectStream>>({});
  const eventSources = useRef<Record<string, EventSource>>({});

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
    };
  }, [load]);

  // ── create ──
  const onCreate = async () => {
    try {
      await api.post('/social-accounts', {
        platform: form.platform,
        handle: form.handle.trim(),
        display_name: form.display_name.trim() || undefined,
      });
      setForm({ platform: 'facebook', handle: '', display_name: '' });
      setShowCreate(false);
      void load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ── connect / recover (SSE over POST via fetch) ──
  const driveLoginFlow = useCallback(async (id: string, mode: 'connect' | 'recover') => {
    setStreams((prev) => ({ ...prev, [id]: { stages: [], status: 'streaming' } }));

    const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '') || '/api';
    const url = `${apiBase}/social-accounts/${id}/${mode}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.NEXT_PUBLIC_API_SECRET_KEY
          ? { 'x-api-key': process.env.NEXT_PUBLIC_API_SECRET_KEY }
          : {}),
      },
    });
    if (!resp.ok || !resp.body) {
      setStreams((prev) => ({
        ...prev,
        [id]: { stages: [], status: 'failed', error: `HTTP ${resp.status}` },
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
            const payload = JSON.parse(line.slice(6));
            if (lastEvent === 'stage') {
              setStreams((prev) => ({
                ...prev,
                [id]: {
                  ...prev[id],
                  stages: [...(prev[id]?.stages ?? []), payload],
                  status: payload.stage === 'done'
                    ? 'done'
                    : payload.stage === 'failed'
                    ? 'failed'
                    : 'streaming',
                  error: payload.stage === 'failed' ? payload.detail : undefined,
                },
              }));
            } else if (lastEvent === 'exit') {
              // Final flush — reload accounts so status pill updates.
              void load();
            }
          }
        }
      }
    }
  }, [load]);

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
        subtitle="Connected Facebook and Instagram sessions used by the scraper."
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
          <div className="flex gap-3 items-end">
            <label className="flex-1">
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
            <label className="flex-1">
              <span className="block text-xs font-medium text-slate-600 mb-1">Username / handle</span>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                placeholder={form.platform === 'facebook' ? 'jane.doe.123' : '@jane_doe'}
                value={form.handle}
                onChange={(e) => setForm({ ...form, handle: e.target.value })}
              />
            </label>
            <label className="flex-1">
              <span className="block text-xs font-medium text-slate-600 mb-1">Label (optional)</span>
              <input
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                placeholder="e.g. OptiRate-FB-01"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </label>
            <Button onClick={onCreate} disabled={!form.handle.trim()}>Save</Button>
          </div>
          <p className="text-xs text-slate-500">
            Saving creates the row. You&apos;ll then click <strong>Connect</strong> on the card to launch a real browser and log in.
          </p>
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
                  onConnect={() => driveLoginFlow(a.id, 'connect')}
                  onRecover={() => driveLoginFlow(a.id, 'recover')}
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
  stream: ConnectStream | undefined;
  editingCaps: boolean;
  capsDraft: { daily_cap: number; hourly_cap: number };
  onConnect: () => void;
  onRecover: () => void;
  onEditCaps: () => void;
  onChangeCaps: (v: { daily_cap: number; hourly_cap: number }) => void;
  onSaveCaps: () => void;
  onCancelCaps: () => void;
  onDelete: () => void;
}

function AccountCard({
  account: a, stream, editingCaps, capsDraft,
  onConnect, onRecover, onEditCaps, onChangeCaps, onSaveCaps, onCancelCaps, onDelete,
}: AccountCardProps) {
  const lastSeen = a.last_login_at
    ? new Date(a.last_login_at).toLocaleString()
    : 'never';

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
            <Button onClick={onConnect} disabled={stream?.status === 'streaming'}>
              Connect
            </Button>
          )}
          {a.status === 'checkpoint' && (
            <Button onClick={onRecover} disabled={stream?.status === 'streaming'}>
              Recover
            </Button>
          )}
          {a.has_cookies && a.status === 'active' && (
            <Button onClick={onConnect} disabled={stream?.status === 'streaming'}>
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

      {/* Stream progress */}
      {stream && stream.stages.length > 0 && (
        <div className="mt-3 p-2 bg-slate-50 rounded text-xs space-y-0.5 font-mono">
          {stream.stages.map((s, i) => (
            <div
              key={i}
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
        </div>
      )}
    </div>
  );
}
