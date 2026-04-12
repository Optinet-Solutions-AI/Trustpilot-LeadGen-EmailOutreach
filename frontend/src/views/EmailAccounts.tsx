'use client';

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';

interface EmailAccount {
  id: string;
  email: string;
  from_name: string;
  provider: string;
  auth_type: string;
  status: string;
  dailySent: number;
  dailyCap: number;
  hourlyCap: number;
  warmupDay: number | null;
  warmupStatus: string;
  source?: 'env' | 'db';
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: string;
  notes?: string;
}

interface AccountsData {
  accounts: EmailAccount[];
  platform: string;
  testMode: boolean;
  manualLeadsOnly: boolean;
}

type AuthType = 'gmail_oauth' | 'app_password' | 'smtp' | 'instantly';

interface FormState {
  email: string;
  fromName: string;
  authType: AuthType;
  // Gmail OAuth2
  gmailClientId: string;
  gmailClientSecret: string;
  gmailRefreshToken: string;
  // App password
  appPassword: string;
  // SMTP
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  smtpSecure: 'tls' | 'ssl' | 'none';
  // Meta
  notes: string;
}

const EMPTY_FORM: FormState = {
  email: '', fromName: '', authType: 'app_password',
  gmailClientId: '', gmailClientSecret: '', gmailRefreshToken: '',
  appPassword: '',
  smtpHost: '', smtpPort: '587', smtpUser: '', smtpPassword: '', smtpSecure: 'tls',
  notes: '',
};

const AUTH_TYPES: { type: AuthType; label: string; icon: string; desc: string }[] = [
  { type: 'app_password', label: 'Gmail App Password', icon: 'lock',           desc: 'Simplest Gmail setup — generate a 16-character App Password in your Google account' },
  { type: 'gmail_oauth',  label: 'Gmail OAuth2',       icon: 'key',            desc: 'Full OAuth2 — use Client ID + Secret from Google Cloud Console' },
  { type: 'smtp',         label: 'Custom SMTP',         icon: 'dns',            desc: 'Outlook, Yahoo, or any IMAP/SMTP provider' },
  { type: 'instantly',    label: 'Instantly.ai',        icon: 'electric_bolt',  desc: 'Account managed by Instantly — register here for visibility only' },
];

export default function EmailAccounts() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthConnected, setOauthConnected] = useState<string | null>(null); // email once connected
  const [saveError, setSaveError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  const load = () => {
    setLoading(true);
    api.get('/email-accounts')
      .then((res) => setData(res.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openModal = () => {
    setShowModal(true);
    setSaveError('');
    setTestResult(null);
    setOauthConnected(null);
    setForm(EMPTY_FORM);
  };

  // Listen for the OAuth popup postMessage
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'gmail-oauth') return;
      setOauthConnecting(false);
      popupRef.current = null;
      if (event.data.ok) {
        setForm((f) => ({
          ...f,
          gmailRefreshToken: event.data.refreshToken ?? '',
          email: event.data.email || f.email,
        }));
        setOauthConnected(event.data.email ?? 'connected');
        setTestResult({ ok: true, message: `Connected as ${event.data.email} ✓` });
      } else {
        setTestResult({ ok: false, message: event.data.message ?? 'OAuth failed' });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleGoogleSignIn = () => {
    if (!form.gmailClientId || !form.gmailClientSecret) {
      setSaveError('Enter Client ID and Client Secret first.');
      return;
    }
    setSaveError('');
    setTestResult(null);
    setOauthConnecting(true);

    // Generate a random state token for CSRF protection
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    // Store credentials in sessionStorage — the callback page will read them
    sessionStorage.setItem(`oauth_state_${state}`, JSON.stringify({
      clientId: form.gmailClientId,
      clientSecret: form.gmailClientSecret,
    }));

    // Build Google OAuth URL directly — no backend redirect needed
    const redirectUri = window.location.origin + '/oauth/callback';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: form.gmailClientId,
      redirect_uri: redirectUri,
      scope: 'https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    const popup = window.open(url, 'gmail-oauth', 'width=520,height=620,left=200,top=100');
    popupRef.current = popup;
    const check = setInterval(() => {
      if (popup?.closed) { clearInterval(check); setOauthConnecting(false); }
    }, 1000);
  };

  const accounts = data?.accounts ?? [];

  const globalStats = [
    { label: 'Configured Accounts', value: loading ? '…' : String(accounts.length),                                                                                              icon: 'alternate_email', border: 'border-slate-200' },
    { label: 'Daily Remaining',      value: loading ? '…' : accounts.length > 0 ? `${Math.max(0, accounts[0].dailyCap - accounts[0].dailySent)}/${accounts[0].dailyCap}` : '—', icon: 'send',            border: 'border-[#b0004a]' },
    { label: 'Mode',                 value: loading ? '…' : data?.platform !== 'none' ? data?.platform ?? 'Platform' : 'Personal Email',                                        icon: 'mark_email_read', border: 'border-tertiary'   },
    { label: 'Test Mode',            value: loading ? '…' : data?.testMode ? 'Active' : 'Disabled',                                                                             icon: 'science',         border: 'border-amber-400'  },
  ];

  const setField = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const handleTest = async () => {
    setSaveError('');
    setTestResult(null);
    setTesting(true);
    try {
      const res = await api.post('/email-accounts/test', {
        authType: form.authType,
        email: form.email,
        gmailClientId: form.gmailClientId,
        gmailClientSecret: form.gmailClientSecret,
        gmailRefreshToken: form.gmailRefreshToken,
        appPassword: form.appPassword,
        smtpHost: form.smtpHost,
        smtpPort: form.smtpPort,
        smtpUser: form.smtpUser,
        smtpPassword: form.smtpPassword,
        smtpSecure: form.smtpSecure,
      });
      setTestResult({ ok: true, message: res.data.data?.message ?? 'Connection verified' });
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Connection test failed';
      setTestResult({ ok: false, message: msg });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaveError('');
    if (!form.email || !form.fromName) { setSaveError('Email and display name are required.'); return; }

    const providerMap: Record<AuthType, string> = {
      gmail_oauth: 'Gmail (OAuth2)',
      app_password: 'Gmail (App Password)',
      smtp: 'Custom SMTP',
      instantly: 'Instantly.ai',
    };

    setSaving(true);
    try {
      await api.post('/email-accounts', {
        email: form.email,
        fromName: form.fromName,
        provider: providerMap[form.authType],
        authType: form.authType,
        gmailClientId: form.gmailClientId || undefined,
        gmailClientSecret: form.gmailClientSecret || undefined,
        gmailRefreshToken: form.gmailRefreshToken || undefined,
        appPassword: form.appPassword || undefined,
        smtpHost: form.smtpHost || undefined,
        smtpPort: form.smtpPort ? parseInt(form.smtpPort) : undefined,
        smtpUser: form.smtpUser || undefined,
        smtpPassword: form.smtpPassword || undefined,
        smtpSecure: form.smtpSecure,
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

  const authInfo = AUTH_TYPES.find((a) => a.type === form.authType)!;

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
          onClick={openModal}
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
                  account.status === 'active' ? 'bg-[#8ff9a8]/30 text-[#006630]' : 'bg-slate-100 text-slate-500'
                }`}>{account.status}</span>
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

              <div className="flex items-center justify-between py-3 border-t border-slate-50">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[14px] text-slate-400">bolt</span>
                  <span className="text-xs font-semibold text-slate-600 uppercase tracking-tight">Warmup</span>
                </div>
                <span className="text-xs font-bold text-[#b0004a]">{account.warmupStatus}</span>
              </div>

              {account.smtp_host && (
                <div className="flex items-center gap-2 py-1">
                  <span className="material-symbols-outlined text-[14px] text-slate-400">dns</span>
                  <span className="text-xs text-secondary">{account.smtp_host}:{account.smtp_port ?? 587}</span>
                </div>
              )}

              {account.source === 'db' && (
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
                  Registered — wiring to active sender coming soon.
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Add Account placeholder */}
        <button
          onClick={openModal}
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
            { done: !!accounts[0]?.email, step: `Personal email configured (${accounts[0]?.email || 'not set'})`,    note: 'Active — sending via Gmail' },
            { done: false, step: 'Add lookalike domain (e.g. optirate-solutions.com)',                                 note: 'Dreamhost DNS + new domain purchase' },
            { done: false, step: 'Configure DKIM, DMARC, SPF for sending domain',                                     note: 'Required before Instantly activation' },
            { done: false, step: 'Connect sending account to Instantly.ai',                                           note: 'Enable EMAIL_PLATFORM=instantly in Cloud Run' },
            { done: false, step: 'Start warm-up at 20 emails/day, scale over 4 weeks',                               note: 'Instantly handles automatically' },
            { done: false, step: 'Run first live campaign with lookalike account',                                    note: 'Target: 500+ leads, 1-2 follow-up sequences' },
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

      {/* ── Add Account Modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl ambient-shadow w-full max-w-2xl mx-4 overflow-hidden flex flex-col max-h-[90vh]">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                  Connect Sender Account
                </h3>
                <p className="text-xs text-secondary mt-0.5">Configure credentials — the app will use these to send outreach emails</p>
              </div>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

              {/* Connection type selector */}
              <div>
                <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-3">Connection Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {AUTH_TYPES.map(({ type, label, icon, desc }) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => { setField('authType', type); setTestResult(null); setSaveError(''); }}
                      className={`flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all ${
                        form.authType === type
                          ? 'border-[#b0004a] bg-[#ffd9de]/10 shadow-sm'
                          : 'border-slate-100 hover:border-slate-200 hover:bg-surface-container-low'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        form.authType === type ? 'bg-[#b0004a]' : 'bg-surface-container'
                      }`}>
                        <span className={`material-symbols-outlined text-[16px] ${form.authType === type ? 'text-white' : 'text-secondary'}`}>{icon}</span>
                      </div>
                      <div>
                        <p className={`text-sm font-bold ${form.authType === type ? 'text-[#b0004a]' : 'text-on-surface'}`}>{label}</p>
                        <p className="text-[10px] text-slate-400 leading-relaxed mt-0.5">{desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Common fields */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Email Address *</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setField('email', e.target.value)}
                    placeholder="you@example.com"
                    className="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-secondary uppercase tracking-wider mb-1.5">Display Name *</label>
                  <input
                    type="text"
                    value={form.fromName}
                    onChange={(e) => setField('fromName', e.target.value)}
                    placeholder="OptiRate"
                    className="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                  />
                </div>
              </div>

              {/* ── Gmail App Password ── */}
              {form.authType === 'app_password' && (
                <div className="border border-slate-100 rounded-xl p-4 bg-surface-container-low space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[16px] text-[#b0004a]">lock</span>
                    <p className="text-xs font-bold text-secondary uppercase tracking-wider">Gmail App Password</p>
                  </div>
                  <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 text-xs text-blue-700 leading-relaxed">
                    <span className="font-bold">How to get your App Password:</span> Google Account → Security → 2-Step Verification → App passwords → Generate. Paste the 16-character code below.
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-secondary mb-1">App Password (16 characters) *</label>
                    <input
                      type="password"
                      value={form.appPassword}
                      onChange={(e) => setField('appPassword', e.target.value)}
                      placeholder="xxxx xxxx xxxx xxxx"
                      className="w-full bg-white rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none font-mono tracking-widest"
                    />
                    <p className="text-[10px] text-slate-400 mt-1">Sends via smtp.gmail.com:587 with TLS — no OAuth setup required</p>
                  </div>
                </div>
              )}

              {/* ── Gmail OAuth2 ── */}
              {form.authType === 'gmail_oauth' && (
                <div className="border border-slate-100 rounded-xl p-4 bg-surface-container-low space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[16px] text-[#b0004a]">key</span>
                    <p className="text-xs font-bold text-secondary uppercase tracking-wider">Gmail OAuth2</p>
                  </div>
                  <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 text-xs text-blue-700 leading-relaxed">
                    <span className="font-bold">Setup:</span> Google Cloud Console → APIs &amp; Services → Credentials → OAuth 2.0 Client IDs → set redirect URI to{' '}
                    <span className="font-mono break-all">https://trustpilot-lead-gen-email-outreach.vercel.app/oauth/callback</span>.
                    Enable the Gmail API. Then enter your credentials below and click Sign in.
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-secondary mb-1">Client ID *</label>
                    <input
                      type="text"
                      value={form.gmailClientId}
                      onChange={(e) => { setField('gmailClientId', e.target.value); setOauthConnected(null); }}
                      placeholder="xxxxxxxxxxxx-xxxxxxxxxxxxxxxx.apps.googleusercontent.com"
                      className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-secondary mb-1">Client Secret *</label>
                    <input
                      type="password"
                      value={form.gmailClientSecret}
                      onChange={(e) => { setField('gmailClientSecret', e.target.value); setOauthConnected(null); }}
                      placeholder="GOCSPX-…"
                      className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none font-mono text-xs"
                    />
                  </div>

                  {/* Sign in with Google button */}
                  {oauthConnected ? (
                    <div className="flex items-center gap-3 px-4 py-3 bg-[#8ff9a8]/10 border border-[#006630]/20 rounded-xl">
                      <span className="material-symbols-outlined text-[#006630] text-[20px]">check_circle</span>
                      <div>
                        <p className="text-sm font-bold text-[#006630]">Connected as {oauthConnected}</p>
                        <p className="text-xs text-[#006630]/70">Refresh token stored — ready to save</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setOauthConnected(null); setField('gmailRefreshToken', ''); setTestResult(null); }}
                        className="ml-auto text-xs text-secondary underline"
                      >
                        Re-connect
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleGoogleSignIn}
                      disabled={oauthConnecting || !form.gmailClientId || !form.gmailClientSecret}
                      className="w-full flex items-center justify-center gap-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40 shadow-sm"
                    >
                      {oauthConnecting ? (
                        <>
                          <span className="material-symbols-outlined text-[18px] animate-spin text-[#b0004a]">progress_activity</span>
                          Waiting for Google…
                        </>
                      ) : (
                        <>
                          {/* Google G logo */}
                          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                            <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                          </svg>
                          Sign in with Google
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}

              {/* ── Custom SMTP ── */}
              {form.authType === 'smtp' && (
                <div className="border border-slate-100 rounded-xl p-4 bg-surface-container-low space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[16px] text-[#b0004a]">dns</span>
                    <p className="text-xs font-bold text-secondary uppercase tracking-wider">SMTP Configuration</p>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs font-bold text-secondary mb-1">Host *</label>
                      <input
                        type="text"
                        value={form.smtpHost}
                        onChange={(e) => setField('smtpHost', e.target.value)}
                        placeholder="smtp.example.com"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-secondary mb-1">Port</label>
                      <input
                        type="number"
                        value={form.smtpPort}
                        onChange={(e) => setField('smtpPort', e.target.value)}
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
                        onChange={(e) => setField('smtpUser', e.target.value)}
                        placeholder="you@example.com"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-secondary mb-1">Password *</label>
                      <input
                        type="password"
                        value={form.smtpPassword}
                        onChange={(e) => setField('smtpPassword', e.target.value)}
                        placeholder="••••••••"
                        className="w-full bg-white rounded-lg px-3 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-secondary mb-2">Encryption</label>
                    <div className="flex gap-2">
                      {(['tls', 'ssl', 'none'] as const).map((enc) => (
                        <button
                          key={enc}
                          type="button"
                          onClick={() => setField('smtpSecure', enc)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                            form.smtpSecure === enc
                              ? 'bg-[#b0004a] text-white border-transparent'
                              : 'border-slate-100 text-secondary hover:border-[#b0004a]/30'
                          }`}
                        >
                          {enc === 'tls' ? 'STARTTLS (587)' : enc === 'ssl' ? 'SSL/TLS (465)' : 'None (plain)'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Instantly.ai ── */}
              {form.authType === 'instantly' && (
                <div className="border border-slate-100 rounded-xl p-4 bg-surface-container-low">
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined text-[20px] text-[#b0004a] mt-0.5">electric_bolt</span>
                    <div className="text-xs text-secondary leading-relaxed">
                      <p className="font-bold text-on-surface mb-1">Instantly.ai Managed Account</p>
                      Add your sending email here so it appears in the Sender Accounts list. Actual sending credentials and warmup are configured directly in the <span className="font-bold">Instantly.ai dashboard</span> — this app registers the address for tracking and campaign routing when <span className="font-mono text-[#b0004a]">EMAIL_PLATFORM=instantly</span> is active.
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
                  onChange={(e) => setField('notes', e.target.value)}
                  placeholder="e.g. Lookalike domain — warmup started April 2026"
                  className="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>

              {/* Test result */}
              {testResult && (
                <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm font-medium ${
                  testResult.ok
                    ? 'bg-[#8ff9a8]/10 border-[#006630]/20 text-[#006630]'
                    : 'bg-[#ffd9de] border-[#b0004a]/20 text-[#b0004a]'
                }`}>
                  <span className="material-symbols-outlined text-[18px] mt-0.5">
                    {testResult.ok ? 'check_circle' : 'error'}
                  </span>
                  {testResult.message}
                </div>
              )}

              {saveError && (
                <div className="px-4 py-3 bg-[#ffd9de] text-[#b0004a] text-sm font-medium rounded-xl border border-[#b0004a]/20">
                  {saveError}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex gap-3 px-6 pb-6 pt-4 border-t border-slate-100 shrink-0">
              <button
                onClick={() => setShowModal(false)}
                className="py-2.5 px-5 rounded-xl border border-slate-200 text-secondary text-sm font-bold hover:bg-surface-container transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleTest}
                disabled={testing || !form.email}
                className="flex items-center gap-2 py-2.5 px-5 rounded-xl border border-[#b0004a]/30 text-[#b0004a] text-sm font-bold hover:bg-[#ffd9de]/20 transition-colors disabled:opacity-40"
              >
                {testing
                  ? <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                  : <span className="material-symbols-outlined text-[16px]">wifi_tethering</span>}
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2.5 primary-gradient text-on-primary rounded-xl text-sm font-bold ambient-shadow disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving && <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>}
                {saving ? 'Saving…' : `Save & Connect ${authInfo ? `(${authInfo.label})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
