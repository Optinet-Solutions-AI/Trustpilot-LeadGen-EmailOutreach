'use client';

import { useEffect, useState } from 'react';
import api from '../api/client';

interface PeerAccount {
  id: string;
  email: string;
  from_name: string;
  provider: string;
  auth_type: string;
  status: string;
  warmupEnabled: boolean;
  isColdSender: boolean;
}

interface WarmupStatus {
  accounts: {
    email: string;
    fromName: string;
    status: string;
    authType: string;
    isColdSender: boolean;
    warmupEnabled: boolean;
    warmupDailyTarget: number;
    sentToday: number;
    totalSent: number;
    totalCompleted: number;
    lastSentAt: string | null;
    inPool: boolean;
  }[];
  poolSize: number;
  healthy: boolean;
  warning: string | null;
  pipeline?: {
    pending_open: number;
    pending_reply: number;
    pending_read: number;
    complete: number;
    failed: number;
    totalLast24h: number;
    lastActivityAt: string | null;
  };
}

interface PeerForm {
  email: string;
  appPassword: string;
  fromName: string;
}

const EMPTY_PEER_FORM: PeerForm = { email: '', appPassword: '', fromName: '' };

const SUPPORTED_PROVIDERS = [
  { domain: 'gmail.com',     label: 'Gmail',   help: 'Generate an App Password at myaccount.google.com/apppasswords' },
  { domain: 'yahoo.com',     label: 'Yahoo',   help: 'Generate an App Password in Yahoo Account Security settings' },
  { domain: 'outlook.com',   label: 'Outlook', help: 'Use your Outlook password (or app password if 2FA is on)' },
  { domain: 'icloud.com',    label: 'iCloud',  help: 'Generate an App-Specific Password at appleid.apple.com' },
];

export default function WarmupPeers() {
  const [peers, setPeers] = useState<PeerAccount[]>([]);
  const [status, setStatus] = useState<WarmupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [peerForm, setPeerForm] = useState<PeerForm>(EMPTY_PEER_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.get('/email-accounts?role=peer')
      .then((res) => setPeers(res.data.data.accounts as PeerAccount[]))
      .catch(() => setPeers([]))
      .finally(() => setLoading(false));
    api.get('/warmup/status')
      .then((res) => setStatus(res.data.data))
      .catch(() => setStatus(null));
  };

  useEffect(() => { load(); }, []);

  const handleAddPeer = async () => {
    setSaveError('');
    if (!peerForm.email.trim() || !peerForm.appPassword.trim()) {
      setSaveError('Email and app password are required.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/email-accounts/peer', {
        email: peerForm.email.trim(),
        appPassword: peerForm.appPassword.trim(),
        fromName: peerForm.fromName.trim() || undefined,
      });
      setShowAddModal(false);
      setPeerForm(EMPTY_PEER_FORM);
      load();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        || (e as Error)?.message || 'Could not add warmup peer';
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this warmup peer? It will leave the warmup pool immediately.')) return;
    setDeleteId(id);
    try {
      await api.delete(`/email-accounts/${id}`);
      load();
    } catch (e) {
      alert((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Delete failed');
    } finally {
      setDeleteId(null);
    }
  };

  const peerStats = (email: string) => status?.accounts.find(a => a.email === email);
  const peerCount = peers.length;
  const activeCount = peers.filter(p => p.warmupEnabled && p.status === 'active').length;

  return (
    <div className="p-3 sm:p-8 space-y-4 sm:space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Warmup Peers
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-relaxed">
            Free Gmail / Yahoo / Outlook accounts that <strong>receive and reply to</strong> warmup emails from your cold senders.
            Peers never send cold mail — they exist only to give your senders a real conversation history that ISPs can see.
          </p>
        </div>
        <button
          onClick={() => { setShowAddModal(true); setPeerForm(EMPTY_PEER_FORM); setSaveError(''); }}
          className="w-full sm:w-auto primary-gradient text-white px-4 py-2.5 rounded-lg font-bold text-sm flex items-center justify-center gap-2 hover:scale-[1.02] transition-transform ambient-shadow flex-shrink-0"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          Add Warmup Peer
        </button>
      </div>

      {/* Pool health */}
      {status && (
        <div className={`rounded-xl p-5 flex items-start gap-4 ${status.healthy ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
          <span className={`material-symbols-outlined text-2xl flex-shrink-0 ${status.healthy ? 'text-green-600' : 'text-amber-600'}`}>
            {status.healthy ? 'check_circle' : 'warning'}
          </span>
          <div>
            <h3 className={`font-bold mb-0.5 ${status.healthy ? 'text-green-800' : 'text-amber-800'}`} style={{ fontFamily: 'Manrope, sans-serif' }}>
              Pool — {status.poolSize} account{status.poolSize !== 1 ? 's' : ''} active ({peerCount} peer{peerCount !== 1 ? 's' : ''})
            </h3>
            <p className={`text-sm ${status.healthy ? 'text-green-700' : 'text-amber-700'}`}>
              {status.warning ?? `Warmup runs every 10 minutes. Each pair: A sends → B opens → B replies → A reads. Reputation builds over 2–3 weeks.`}
            </p>
          </div>
        </div>
      )}

      {/* Pipeline snapshot — last 24h */}
      {status?.pipeline && (
        <div className="bg-surface-container-lowest rounded-xl p-5 ambient-shadow border border-slate-50">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Pipeline (last 24h)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {status.pipeline.totalLast24h} warmup email{status.pipeline.totalLast24h !== 1 ? 's' : ''} · last activity {status.pipeline.lastActivityAt ? new Date(status.pipeline.lastActivityAt).toLocaleTimeString() : '—'}
              </p>
            </div>
            <button
              onClick={load}
              className="text-xs font-bold text-slate-400 hover:text-[#b0004a] transition-colors flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">refresh</span>
              Refresh
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              { key: 'pending_open',  label: 'Sent → opening', icon: 'mark_email_unread', color: 'bg-blue-50 text-blue-700' },
              { key: 'pending_reply', label: 'Opened → replying', icon: 'drafts',          color: 'bg-indigo-50 text-indigo-700' },
              { key: 'pending_read',  label: 'Replied → reading', icon: 'reply',           color: 'bg-violet-50 text-violet-700' },
              { key: 'complete',      label: 'Complete cycles', icon: 'task_alt',          color: 'bg-green-50 text-green-700' },
              { key: 'failed',        label: 'Failed',          icon: 'error',             color: 'bg-red-50 text-red-700' },
            ].map(({ key, label, icon, color }) => {
              const count = (status.pipeline as unknown as Record<string, number>)[key] ?? 0;
              return (
                <div key={key} className={`rounded-lg p-3 ${color}`}>
                  <span className="material-symbols-outlined text-[18px]">{icon}</span>
                  <p className="text-2xl font-black mt-1">{count}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider mt-0.5 leading-tight">{label}</p>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-slate-400 mt-3 leading-relaxed">
            <strong>Reading this:</strong> emails move left-to-right. Healthy pool = numbers in &quot;sent→opening&quot; and &quot;complete cycles&quot; growing roughly equally over time. Mostly stuck in one column = something between stages is broken (usually IMAP auth on a peer).
          </p>
        </div>
      )}

      {/* Peers grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
        {loading ? (
          <div className="col-span-full flex items-center justify-center py-12 text-sm text-slate-400">Loading peers…</div>
        ) : peers.length === 0 ? (
          <div className="col-span-full bg-surface-container-low border border-dashed border-slate-200 rounded-xl p-10 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-white flex items-center justify-center ambient-shadow">
              <span className="material-symbols-outlined text-[#b0004a]">groups</span>
            </div>
            <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>No warmup peers yet</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
              Add 4–6 free Gmail/Yahoo/Outlook accounts. They&apos;ll exchange warmup emails with your cold senders to build ISP reputation.
            </p>
          </div>
        ) : peers.map((peer) => {
          const stats = peerStats(peer.email);
          return (
            <div key={peer.id} className="bg-surface-container-lowest rounded-xl p-5 ambient-shadow border border-slate-50 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-[#ffd9de] flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-[#b0004a] text-[18px]">groups</span>
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-bold text-sm truncate">{peer.email}</h3>
                    <p className="text-[11px] text-slate-400 font-medium">{peer.provider}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(peer.id)}
                  disabled={deleteId === peer.id}
                  className="text-slate-400 hover:text-[#b0004a] hover:bg-red-50 rounded p-1 transition-colors disabled:opacity-40"
                  title="Remove peer"
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                </button>
              </div>

              <div className="flex items-center gap-2 text-[11px]">
                <span className={`px-2 py-0.5 font-black uppercase rounded ${
                  peer.status === 'active' ? 'bg-[#8ff9a8]/30 text-[#006630]' : 'bg-slate-100 text-slate-500'
                }`}>{peer.status}</span>
                {peer.warmupEnabled && (
                  <span className="px-2 py-0.5 font-bold uppercase rounded bg-[#b0004a]/10 text-[#b0004a]">In Pool</span>
                )}
              </div>

              <div className="grid grid-cols-3 gap-1 text-center pt-1">
                <div className="bg-slate-50 rounded px-1 py-2">
                  <p className="text-[10px] text-slate-400 font-medium">Sent today</p>
                  <p className="text-sm font-black text-on-surface">{stats?.sentToday ?? 0}<span className="text-slate-400 text-[11px]">/{stats?.warmupDailyTarget ?? 5}</span></p>
                </div>
                <div className="bg-slate-50 rounded px-1 py-2">
                  <p className="text-[10px] text-slate-400 font-medium">Total</p>
                  <p className="text-sm font-black text-on-surface">{stats?.totalSent ?? 0}</p>
                </div>
                <div className="bg-slate-50 rounded px-1 py-2">
                  <p className="text-[10px] text-slate-400 font-medium">Cycles</p>
                  <p className="text-sm font-black text-[#006630]">{stats?.totalCompleted ?? 0}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-xs text-slate-400 leading-relaxed pt-4 border-t border-slate-100 max-w-3xl">
        <strong className="text-slate-600">How warmup works:</strong> {' '}
        Every 10 minutes the system picks pairs of accounts in the pool. Account A sends a short message to B. B reads it, marks it important, and replies 5–30 min later. A reads the reply.
        ISPs see realistic conversational signal (high open rate, replies, important flags) building reputation for the cold senders. Cold senders ramp from 10/day on Day 1 to {' '}
        <strong className="text-slate-600">~50/day on Day 21</strong>. With 5 senders that&apos;s ~250 cold emails/day at full warm-up.
      </div>

      {/* Add Peer Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowAddModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-black" style={{ fontFamily: 'Manrope, sans-serif' }}>Add Warmup Peer</h2>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Email Address</label>
                <input
                  type="email"
                  value={peerForm.email}
                  onChange={(e) => setPeerForm({ ...peerForm, email: e.target.value })}
                  placeholder="warmup-peer-1@gmail.com"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase mb-1">App Password</label>
                <input
                  type="password"
                  value={peerForm.appPassword}
                  onChange={(e) => setPeerForm({ ...peerForm, appPassword: e.target.value })}
                  placeholder="16-character app password"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Not your normal password. Generate one in your provider&apos;s account security settings.
                </p>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Display Name (optional)</label>
                <input
                  type="text"
                  value={peerForm.fromName}
                  onChange={(e) => setPeerForm({ ...peerForm, fromName: e.target.value })}
                  placeholder="Sarah Mills"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>
            </div>

            <details className="mb-4 text-xs text-slate-500">
              <summary className="cursor-pointer font-bold text-slate-600">Supported providers + how to get an app password</summary>
              <ul className="mt-2 space-y-1 pl-4">
                {SUPPORTED_PROVIDERS.map(p => (
                  <li key={p.domain}><strong>{p.label} ({p.domain}):</strong> {p.help}</li>
                ))}
              </ul>
            </details>

            {saveError && (
              <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{saveError}</div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowAddModal(false)}
                disabled={saving}
                className="flex-1 py-2 text-sm font-bold border border-slate-200 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAddPeer}
                disabled={saving}
                className="flex-1 py-2 text-sm font-bold primary-gradient text-white rounded-lg disabled:opacity-50"
              >
                {saving ? 'Connecting…' : 'Add Peer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active count footer */}
      <p className="text-[11px] text-slate-400 text-center pt-2">
        {activeCount} of {peerCount} peer{peerCount !== 1 ? 's' : ''} actively warming up.
      </p>
    </div>
  );
}
