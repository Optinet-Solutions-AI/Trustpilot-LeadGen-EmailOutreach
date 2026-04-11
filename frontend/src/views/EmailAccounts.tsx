'use client';

import { useState } from 'react';

type AccountStatus = 'healthy' | 'warning' | 'error';

type EmailAccount = {
  id: string;
  email: string;
  provider: string;
  status: AccountStatus;
  reputation: number;
  warmupDay: number | null;
  warmupStatus: string;
};

const MOCK_ACCOUNTS: EmailAccount[] = [
  {
    id: '1',
    email: 'jordi@optiratesolutions.com',
    provider: 'Gmail (Personal)',
    status: 'healthy',
    reputation: 92,
    warmupDay: null,
    warmupStatus: 'Active — Test Phase',
  },
];

const STATUS_CONFIG: Record<AccountStatus, { label: string; classes: string; dot: string }> = {
  healthy: { label: 'Healthy',  classes: 'bg-[#8ff9a8]/30 text-[#006630]', dot: 'bg-[#006630]' },
  warning: { label: 'Warning',  classes: 'bg-[#ffd9de] text-[#b0004a]',    dot: 'bg-[#b0004a]' },
  error:   { label: 'DNS Error', classes: 'bg-error-container text-error',   dot: 'bg-error' },
};

export default function EmailAccounts() {
  const [accounts] = useState<EmailAccount[]>(MOCK_ACCOUNTS);

  const globalStats = [
    { label: 'Avg Health Score',    value: `${Math.round(accounts.reduce((s, a) => s + a.reputation, 0) / Math.max(accounts.length, 1))}/100`, icon: 'favorite',           border: 'border-[#b0004a]' },
    { label: 'Active Accounts',     value: `${accounts.length}`,                                                                                 icon: 'alternate_email',     border: 'border-slate-200' },
    { label: 'Mode',                value: 'Personal Email',                                                                                      icon: 'mark_email_read',     border: 'border-tertiary' },
    { label: 'DNS Status',          value: 'Configured',                                                                                          icon: 'dns',                 border: 'border-[#b0004a]' },
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
        <button className="flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm ambient-shadow hover:scale-[1.02] transition-transform">
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
            <p
              className="text-3xl font-black text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Test Phase Notice */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 flex items-start gap-4">
        <span className="material-symbols-outlined text-amber-600 text-2xl flex-shrink-0">science</span>
        <div>
          <h3
            className="font-bold text-amber-800 mb-1"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Test Phase — Personal Email Mode
          </h3>
          <p className="text-sm text-amber-700 leading-relaxed">
            You&apos;re currently sending via your personal Gmail account (jordi@optiratesolutions.com).
            This is ideal for testing your campaign flows. When ready to scale, add lookalike domain accounts
            (e.g. <code className="bg-amber-100 px-1 rounded text-xs">outreach@optirate-solutions.com</code>) and
            enable the Instantly.ai platform for automated warm-up and rotation.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <span className="w-2 h-2 rounded-full bg-[#b0004a] inline-block" />
            <span className="text-xs font-bold text-amber-700">
              Instantly.ai platform is disabled — code is preserved for production activation
            </span>
          </div>
        </div>
      </div>

      {/* Account Cards */}
      <div className="grid grid-cols-3 gap-6">
        {accounts.map((account) => {
          const sc = STATUS_CONFIG[account.status];
          return (
            <div
              key={account.id}
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
                <span className={`px-2 py-1 text-[10px] font-black uppercase rounded ${sc.classes}`}>
                  {sc.label}
                </span>
              </div>

              <div className="space-y-4">
                {/* Reputation Bar */}
                <div>
                  <div className="flex justify-between text-xs font-bold mb-1">
                    <span className="text-slate-500">Sender Reputation</span>
                    <span className="text-[#b0004a]">{account.reputation}%</span>
                  </div>
                  <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="primary-gradient h-full rounded-full"
                      style={{ width: `${account.reputation}%` }}
                    />
                  </div>
                </div>

                {/* Warmup Status */}
                <div className="flex items-center justify-between py-3 border-t border-slate-50">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[14px] text-slate-400">bolt</span>
                    <span className="text-xs font-semibold text-slate-600 uppercase tracking-tight">Status</span>
                  </div>
                  <span className="text-xs font-bold text-[#b0004a]">{account.warmupStatus}</span>
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button className="flex-1 py-2 rounded-lg bg-surface-container-highest text-on-surface text-xs font-bold hover:bg-slate-200 transition-colors">
                    Details
                  </button>
                  <button className="flex-1 py-2 rounded-lg border border-[#b0004a]/20 text-[#b0004a] text-xs font-bold hover:bg-[#b0004a]/5 transition-colors">
                    Settings
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {/* Add Account Card */}
        <div className="bg-surface-container-low border-2 border-dashed border-slate-200 rounded-xl p-6 flex flex-col items-center justify-center text-center group cursor-pointer hover:border-[#b0004a]/40 transition-all">
          <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center mb-4 ambient-shadow group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-[#b0004a]">add</span>
          </div>
          <h3
            className="font-bold text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Connect New Account
          </h3>
          <p className="text-xs text-slate-400 mt-2 max-w-[180px] leading-relaxed">
            Add Gmail, Outlook or custom SMTP for warm-up and outreach rotation.
          </p>
        </div>
      </div>

      {/* Production Roadmap */}
      <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
        <h3
          className="text-xl font-extrabold text-on-surface mb-2"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        >
          Production Readiness Checklist
        </h3>
        <p className="text-sm text-secondary mb-6">Steps to scale from test phase to full production outreach.</p>
        <div className="space-y-4">
          {[
            { done: true,  step: 'Personal email configured (jordi@optiratesolutions.com)',   note: 'Active — sending via Gmail' },
            { done: false, step: 'Add lookalike domain (e.g. optirate-solutions.com)',         note: 'Dreamhost DNS + new domain purchase' },
            { done: false, step: 'Configure DKIM, DMARC, SPF for sending domain',              note: 'Required before Instantly activation' },
            { done: false, step: 'Connect sending account to Instantly.ai',                    note: 'Enable EMAIL_PLATFORM=instantly in Cloud Run' },
            { done: false, step: 'Start warm-up at 20 emails/day, scale over 4 weeks',         note: 'Instantly handles automatically' },
            { done: false, step: 'Run first live campaign with lookalike account',              note: 'Target: 500+ leads, 1-2 follow-up sequences' },
          ].map(({ done, step, note }) => (
            <div key={step} className="flex items-start gap-4">
              <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                done ? 'bg-[#8ff9a8]/30' : 'bg-surface-container-high'
              }`}>
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
