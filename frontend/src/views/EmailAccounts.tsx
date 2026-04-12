'use client';

import { useEffect, useState } from 'react';
import api from '../api/client';

interface EmailAccount {
  id: string;
  email: string;
  from_name: string;
  provider: string;
  status: string;
  dailySent: number;
  dailyCap: number;
  hourlyCap: number;
  warmupDay: number | null;
  warmupStatus: string;
  source?: 'env' | 'db';
  smtp_host?: string;
  smtp_port?: number;
  notes?: string;
}

interface AccountsData {
  accounts: EmailAccount[];
  platform: string;
  testMode: boolean;
  manualLeadsOnly: boolean;
}

type Provider = 'gmail' | 'smtp' | 'instantly';

interface AddAccountForm {
  email: string;
  fromName: string;
  provider: Provider;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  notes: string;
}

const EMPTY_FORM: AddAccountForm = {
  email: '', fromName: '', provider: 'smtp',
  smtpHost: '', smtpPort: '587', smtpUser: '', smtpPassword: '', notes: '',
};

export default function EmailAccounts() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<AddAccountForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.get('/email-accounts')
      .then((res) => setData(res.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const accounts = data?.accounts ?? [];
  const avgHealth = accounts.length > 0
    ? Math.round(accounts.reduce((s, a) => s + Math.round(((a.dailyCap - a.dailySent) / Math.max(a.dailyCap, 1)) * 100), 0) / accounts.length)
    : 0;

  const globalStats = [
    { label: 'Configured Accounts', value: loading ? '…' : String(accounts.length),                icon: 'alternate_email', border: 'border-slate-200' },
    { label: 'Daily Remaining',      value: loading ? '…' : accounts.length > 0 ? `${Math.max(0, accounts[0].dailyCap - accounts[0].dailySent)}/${accounts[0].dailyCap}` : '—', icon: 'send', border: 'border-[#b0004a]' },
    { label: 'Mode',                 value: loading ? '…' : data?.platform !== 'none' ? data?.platform ?? 'Platform' : 'Personal Email', icon: 'mark_email_read', border: 'border-tertiary' },
    { label: 'Test Mode',            value: loading ? '…' : data?.testMode ? 'Active' : 'Disabled', icon: 'science', border: 'border-amber-400' },
  ];

  const handleSave = async () => {
    setSaveError('');
    if (!form.email || !form.fromName) { setSaveError('Email and display name are required.'); return; }
    if (form.provider === 'smtp' && (!form.smtpHost || !form.smtpUser)) {
      setSaveError('SMTP host and username are required for SMTP accounts.'); return;
    }
    setSaving(true);
    try {
      await api.post('/email-accounts', {
        email: form.email,
        fromName: form.fromName,
        provider: form.provider,
        smtpHost: form.smtpHost || undefined,
        smtpPort: form.smtpPort ? parseInt(form.smtpPort) : undefined,
        smtpUser: form.smtpUser || undefined,
        smtpPassword: form.smtpPassword || undefined,
        notes: form.notes || undefined,
      });
      setShowModal(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to save account. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this account?')) return;
    setDeleteId(id);
    try {
      await api.delete(`/email-accounts/${id}`);
      load();
    } catch { /* ignore */ } finally {
      setDeleteId(null);
    }
  };

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-4xl font-extrabold tracking-tight text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Email <span className="text-[#b0004a]">Accounts</span>
          </h2>
          <p className="text-secondary font-medium mt-1">Monitor sender health and manage your outreach email accounts.</p>
        </div>
        <button
          onClick={() => { setShowModal(true); setSaveError(''); setForm(EMPTY_FORM); }}
          className="flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm ambient-shadow hover:scale-[1.02] transition-transform"
        >
          <span className="material-symbols-outlined text-[18px]">add_circle</span>
          Add Account
        </button>
      </div>

      {/* Global Health Metrics */}
      <div className="grid grid-cols-4 gap-5">
        {globalStats.map(({ label, value, icon, border }) => (
          <div key={label} className={`bg-surface-container-lowest p-6 rounded-xl ambient-shadow border-l-4 ${border}`}>
            <div className="flex justify-between items-start mb-4">
              <p className="text-sm font-bold text-slate-500 uppercase tracking-wider">{label}</p>
              <span className="material-symbols-outlined text-[#b0004a] text-[20px]">{icon}</span>
            </div>
            <p className="text-3xl font-black text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Test mode notice */}
      {data?.testMode && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 flex items-start gap-4">
          <span className="material-symbols-outlined text-amber-600 text-2xl flex-shrink-0">science</span>
          <div>
            <h3 className="font-bold text-amber-800 mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Test Phase — Personal Email Mode
            </h3>
            <p className="text-sm text-amber-700 leading-relaxed">
              Currently sending via <span className="font-bold">{accounts[0]?.email || 'your Gmail account'}</span>.
              All outgoing emails are redirected to your test address.
              {data?.manualLeadsOnly && ' Only manually entered recipients are permitted.'}
              {' '}When ready to scale, add lookalike domain accounts and enable the Instantly.ai platform.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <span className="w-2 h-2 rounded-full bg-[#b0004a] inline-block" />
              <span className="text-xs font-bold text-amber-700">
                Instantly.ai platform is disabled — preserved for production activation
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Account Cards */}
      <div className="grid grid-cols-3 gap-6">
        {loading ? (
          <div className="col-span-3 flex items-center justify-center py-16 text-secondary text-sm">
            Loading account info…
          </div>
        ) : accounts.map((account, i) => (
          <div key={account.id ?? i} className="bg-surface-container-lowest rounded-xl p-6 ambient-shadow hover:shadow-xl transition-all border border-slate-50">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#ffd9de] flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#b0004a] text-[18px]">alternate_email</span>
                </div>
                <div>
                  <h3 className="font-bold text-on-surface text-sm">{account.email}</h3>
                  <p className="text-xs text-slate-400 font-medium">{account.from_name} · {account.provider}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 text-[10px] font-black uppercase rounded ${
                  account.status === 'active'
                    ? 'bg-[#8ff9a8]/30 text-[#006630]'
                    : 'bg-slate-100 text-slate-500'
                }`}>
                  {account.status}
                </span>
                {account.source === 'db' && (
                  <button
                    onClick={() => handleDelete(account.id)}
                    disabled={deleteId === account.id}
                    className="text-slate-300 hover:text-[#b0004a] transition-colors"
                    title="Remove account"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-4">
              {/* Daily quota bar */}
              <div>
                <div className="flex justify-between text-xs font-bold mb-1">
                  <span className="text-slate-500">Daily Quota</span>
                  <span className="text-[#b0004a]">{account.dailySent} / {account.dailyCap} sent</span>
                </div>
                <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="primary-gradient h-full rounded-full transition-all"
                    style={{ width: `${Math.min(100, Math.round((account.dailySent / Math.max(account.dailyCap, 1)) * 100))}%` }}
                  />
                </div>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between py-3 border-t border-slate-50">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[14px] text-slate-400">bolt</span>
                  <span className="text-xs font-semibold text-slate-600 uppercase tracking-tight">Warmup</span>
                </div>
                <span className="text-xs font-bold text-[#b0004a]">{account.warmupStatus}</span>
              </div>

              {/* SMTP details if present */}
              {account.smtp_host && (
                <div className="flex items-center gap-2 py-1">
                  <span className="material-symbols-outlined text-[14px] text-slate-400">dns</span>
                  <span className="text-xs text-secondary">{account.smtp_host}:{account.smtp_port ?? 587}</span>
                </div>
              )}

              {/* Source badge */}
              {account.source === 'db' && (
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
                  Registered — connect to sending logic to activate outreach.
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Add Account placeholder card */}
        <button
          onClick={() => { setShowModal(true); setSaveError(''); setForm(EMPTY_FORM); }}
          className="bg-surface-container-low border-2 border-dashed border-slate-200 rounded-xl p-6 flex flex-col items-center justify-center text-center hover:border-[#b0004a]/40 hover:bg-[#ffd9de]/10 transition-all group"
        >
          <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center mb-4 ambient-shadow group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-[#b0004a]">add</span>
          </div>
          <h3 className="font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>Connect New Account</h3>
          <p className="text-xs text-slate-400 mt-2 max-w-[180px] leading-relaxed">
            Add Gmail, SMTP, or Instantly-managed account for outreach rotation.
          </p>
        </button>
      </div>

      {/* Production Roadmap */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
        <h3 className="text-xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Production Readiness Checklist
        </h3>
        <p className="text-sm text-secondary mb-6">Steps to scale from test phase to full production outreach.</p>
        <div className="space-y-4">
          {[
            { done: !!accounts[0]?.email, step: `Personal email configured (${accounts[0]?.email || 'not set'})`, note: 'Active — sending via Gmail' },
            { done: false, step: 'Add lookalike domain (e.g. optirate-solutions.com)', note: 'Dreamhost DNS + new domain purchase' },
            { done: false, step: 'Configure DKIM, DMARC, SPF for sending domain', note: 'Required before Instantly activation' },
            { done: false, step: 'Connect sending account to Instantly.ai', note: 'Enable EMAIL_PLATFORM=instantly in Cloud Run' },
            { done: false, step: 'Start warm-up at 20 emails/day, scale over 4 weeks', note: 'Instantly handles automatically' },
            { done: false, step: 'Run first live campaign with lookalike account', note: 'Target: 500+ leads, 1-2 follow-up sequences' },
          ].map(({ done, step, note }) => (
            <div key={step} className="flex items-start gap-4">
              <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${done ? 'bg-[#8ff9a8]/30' : 'bg-surface-container-high'}`}>
                {done
                  ? <span className="material-symbols-outlined text-[14px] text-[#006630]">check</span>
                  : <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />}
              </div>
              <div>
                <p className={`text-sm font-bold ${done ? 'text-secondary line-through' : 'text-on-surface'}`}>{step}</p>
                <p className="text-xs text-secondary mt-0.5">{note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add Account Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl ambient-shadow w-full max-w-lg mx-4 overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
              <div>
                <h3 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                  Add Sender Account
                </h3>
                <p className="text-xs text-secondary mt-0.5">Register an email account for outreach rotation</p>
              </div>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Provider tabs */}
              <div>
                <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-2">Provider</label>
                <div className="flex gap-2">
                  {(['gmail', 'smtp', 'instantly'] as Provider[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, provider: p }))}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all border ${
                        form.provider === p
                          ? 'primary-gradient text-on-primary border-transparent ambient-shadow'
                          : 'bg-surface-container border-slate-100 text-secondary hover:border-[#b0004a]/30'
                      }`}
                    >
                      {p === 'gmail' ? 'Gmail' : p === 'smtp' ? 'Custom SMTP' : 'Instantly Managed'}
                    </button>
                  ))}
                </div>

                {/* Provider context */}
                <div className="mt-2 px-3 py-2.5 bg-surface-container rounded-lg text-xs text-secondary leading-relaxed">
                  {form.provider === 'gmail' && (
                    <>Gmail OAuth — the primary account is set via env vars. Register additional Gmail addresses here for tracking. OAuth credentials must be updated in Cloud Run env vars to activate them for sending.</>
                  )}
                  {form.provider === 'smtp' && (
                    <>Custom SMTP — enter host, port, and credentials. Suitable for Outlook, Yahoo, or any IMAP/SMTP provider.</>
                  )}
                  {form.provider === 'instantly' && (
                    <>Instantly Managed — accounts configured directly in Instantly.ai dashboard. Register the address here for visibility. Sending is handled by Instantly once EMAIL_PLATFORM=instantly is active.</>
                  )}
                </div>
              </div>

              {/* Email + Name */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Email Address *</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="you@example.com"
                    className="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Display Name *</label>
                  <input
                    type="text"
                    value={form.fromName}
                    onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))}
                    placeholder="OptiRate"
                    className="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  />
                </div>
              </div>

              {/* SMTP fields */}
              {form.provider === 'smtp' && (
                <div className="space-y-3 border border-slate-100 rounded-xl p-4 bg-surface-container-low">
                  <p className="text-xs font-bold text-secondary uppercase tracking-wider">SMTP Configuration</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-secondary mb-1">Host *</label>
                      <input
                        type="text"
                        value={form.smtpHost}
                        onChange={(e) => setForm((f) => ({ ...f, smtpHost: e.target.value }))}
                        placeholder="smtp.gmail.com"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-secondary mb-1">Port</label>
                      <input
                        type="number"
                        value={form.smtpPort}
                        onChange={(e) => setForm((f) => ({ ...f, smtpPort: e.target.value }))}
                        placeholder="587"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-secondary mb-1">Username *</label>
                      <input
                        type="text"
                        value={form.smtpUser}
                        onChange={(e) => setForm((f) => ({ ...f, smtpUser: e.target.value }))}
                        placeholder="you@example.com"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-secondary mb-1">Password</label>
                      <input
                        type="password"
                        value={form.smtpPassword}
                        onChange={(e) => setForm((f) => ({ ...f, smtpPassword: e.target.value }))}
                        placeholder="App password"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Notes (optional)</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. Lookalike domain — warmup started April 2026"
                  className="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>

              {saveError && (
                <div className="px-4 py-3 bg-[#ffd9de] text-[#b0004a] text-sm font-medium rounded-xl border border-[#b0004a]/20">
                  {saveError}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex gap-3 px-6 pb-6 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-secondary text-sm font-bold hover:bg-surface-container transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2.5 primary-gradient text-on-primary rounded-xl text-sm font-bold ambient-shadow disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving && <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>}
                {saving ? 'Saving…' : 'Add Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
