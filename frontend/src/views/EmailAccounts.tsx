'use client';

import { useEffect, useState } from 'react';
import api from '../api/client';

interface EmailAccount {
  email: string;
  provider: string;
  status: string;
  dailySent: number;
  dailyCap: number;
  hourlyCap: number;
  warmupDay: number | null;
  warmupStatus: string;
}

interface AccountsData {
  accounts: EmailAccount[];
  platform: string;
  testMode: boolean;
  manualLeadsOnly: boolean;
}

export default function EmailAccounts() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/campaigns/email-accounts')
      .then((res) => setData(res.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const accounts = data?.accounts ?? [];
  const avgHealth = accounts.length > 0
    ? Math.round(accounts.reduce((s, a) => s + Math.round(((a.dailyCap - a.dailySent) / Math.max(a.dailyCap, 1)) * 100), 0) / accounts.length)
    : 0;

  const globalStats = [
    { label: 'Active Accounts',  value: loading ? '…' : String(accounts.length),                                            icon: 'alternate_email',  border: 'border-slate-200'  },
    { label: 'Daily Remaining',  value: loading ? '…' : accounts.length > 0 ? `${Math.max(0, accounts[0].dailyCap - accounts[0].dailySent)}/${accounts[0].dailyCap}` : '—', icon: 'send',             border: 'border-[#b0004a]'  },
    { label: 'Mode',             value: loading ? '…' : data?.platform !== 'none' ? data?.platform ?? 'Platform' : 'Personal Email',                                         icon: 'mark_email_read',  border: 'border-tertiary'   },
    { label: 'Test Mode',        value: loading ? '…' : data?.testMode ? 'Active' : 'Disabled',                             icon: 'science',          border: 'border-amber-400' },
  ];

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Email <span className="text-[#b0004a]">Accounts</span>
          </h2>
          <p className="text-secondary font-medium mt-1">
            Monitor sender health and manage your outreach email accounts.
          </p>
        </div>
        <div className="relative group">
          <button
            disabled
            className="flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm ambient-shadow opacity-40 cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[18px]">add_circle</span>
            Add Account
          </button>
          <div className="absolute -top-9 right-0 bg-slate-800 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Enable Instantly.ai platform first
          </div>
        </div>
      </div>

      {/* Global Health Metrics */}
      <div className="grid grid-cols-4 gap-5">
        {globalStats.map(({ label, value, icon, border }) => (
          <div key={label} className={`bg-surface-container-lowest p-6 rounded-xl ambient-shadow border-l-4 ${border}`}>
            <div className="flex justify-between items-start mb-4">
              <p className="text-sm font-bold text-slate-500 uppercase tracking-wider">{label}</p>
              <span className="material-symbols-outlined text-[#b0004a] text-[20px]">{icon}</span>
            </div>
            <p className="text-3xl font-black text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Status notice */}
      {data?.testMode && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 flex items-start gap-4">
          <span className="material-symbols-outlined text-amber-600 text-2xl flex-shrink-0">science</span>
          <div>
            <h3 className="font-bold text-amber-800 mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Test Phase — Personal Email Mode
            </h3>
            <p className="text-sm text-amber-700 leading-relaxed">
              Currently sending via{' '}
              <span className="font-bold">{accounts[0]?.email || 'your Gmail account'}</span>.
              All outgoing emails are redirected to your test addresses.
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
          <div
            key={i}
            className="bg-surface-container-lowest rounded-xl p-6 ambient-shadow hover:shadow-xl transition-all border border-slate-50"
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#ffd9de] flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#b0004a] text-[18px]">alternate_email</span>
                </div>
                <div>
                  <h3 className="font-bold text-on-surface text-sm">{account.email}</h3>
                  <p className="text-xs text-slate-400 font-medium">{account.provider}</p>
                </div>
              </div>
              <span className="px-2 py-1 text-[10px] font-black uppercase rounded bg-[#8ff9a8]/30 text-[#006630]">
                Active
              </span>
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
                  <span className="text-xs font-semibold text-slate-600 uppercase tracking-tight">Status</span>
                </div>
                <span className="text-xs font-bold text-[#b0004a]">{account.warmupStatus}</span>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                <div className="relative group flex-1">
                  <button disabled className="w-full py-2 rounded-lg bg-surface-container-highest text-on-surface text-xs font-bold opacity-40 cursor-not-allowed">
                    Details
                  </button>
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                    Coming soon
                  </div>
                </div>
                <div className="relative group flex-1">
                  <button disabled className="w-full py-2 rounded-lg border border-[#b0004a]/20 text-[#b0004a] text-xs font-bold opacity-40 cursor-not-allowed">
                    Settings
                  </button>
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                    Coming soon
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Add Account placeholder */}
        <div className="relative group bg-surface-container-low border-2 border-dashed border-slate-200 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-not-allowed opacity-50">
          <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center mb-4 ambient-shadow">
            <span className="material-symbols-outlined text-[#b0004a]">add</span>
          </div>
          <h3 className="font-bold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Connect New Account
          </h3>
          <p className="text-xs text-slate-400 mt-2 max-w-[180px] leading-relaxed">
            Add Gmail, Outlook or custom SMTP for warm-up and outreach rotation.
          </p>
          <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Enable Instantly.ai platform first
          </div>
        </div>
      </div>

      {/* Production Roadmap — intentionally static */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
        <h3 className="text-xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Production Readiness Checklist
        </h3>
        <p className="text-sm text-secondary mb-6">Steps to scale from test phase to full production outreach.</p>
        <div className="space-y-4">
          {[
            { done: !!accounts[0]?.email, step: `Personal email configured (${accounts[0]?.email || 'not set'})`,   note: 'Active — sending via Gmail' },
            { done: false, step: 'Add lookalike domain (e.g. optirate-solutions.com)',                                note: 'Dreamhost DNS + new domain purchase' },
            { done: false, step: 'Configure DKIM, DMARC, SPF for sending domain',                                    note: 'Required before Instantly activation' },
            { done: false, step: 'Connect sending account to Instantly.ai',                                          note: 'Enable EMAIL_PLATFORM=instantly in Cloud Run' },
            { done: false, step: 'Start warm-up at 20 emails/day, scale over 4 weeks',                               note: 'Instantly handles automatically' },
            { done: false, step: 'Run first live campaign with lookalike account',                                    note: 'Target: 500+ leads, 1-2 follow-up sequences' },
          ].map(({ done, step, note }) => (
            <div key={step} className="flex items-start gap-4">
              <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${done ? 'bg-[#8ff9a8]/30' : 'bg-surface-container-high'}`}>
                {done
                  ? <span className="material-symbols-outlined text-[14px] text-[#006630]">check</span>
                  : <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
                }
              </div>
              <div>
                <p className={`text-sm font-bold ${done ? 'text-secondary line-through' : 'text-on-surface'}`}>{step}</p>
                <p className="text-xs text-secondary mt-0.5">{note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
