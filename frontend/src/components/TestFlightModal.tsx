'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

type Phase = 'preflight' | 'sending' | 'success' | 'error';

interface TestResult {
  sentTo: string;
  leadUsed: string;
  originalEmail: string;
  sentFrom?: string;
  platform?: string;
  note?: string;
}

interface Props {
  campaignName: string;
  recipientCount: number;
  /** Emails of campaign leads — used to warn if test email matches a lead */
  leadEmails?: string[];
  onTestFlightSend: (testEmail: string) => Promise<TestResult>;
  onProceedLive: () => void;
  onClose: () => void;
}

export default function TestFlightModal({
  campaignName, recipientCount, leadEmails = [], onTestFlightSend, onProceedLive, onClose,
}: Props) {
  const [phase, setPhase] = useState<Phase>('preflight');
  const [testEmail, setTestEmail] = useState(() => localStorage.getItem('testFlightEmail') || '');
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase === 'preflight') inputRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'success') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, onClose]);

  const isLeadEmail = testEmail.trim() && leadEmails.map((e) => e.toLowerCase()).includes(testEmail.trim().toLowerCase());

  const handleSendTest = async () => {
    if (!testEmail.trim() || !testEmail.includes('@')) return;
    setPhase('sending');
    setErrorMsg('');
    try {
      localStorage.setItem('testFlightEmail', testEmail.trim());
      const res = await onTestFlightSend(testEmail.trim());
      setResult(res);
      setPhase('success');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Send failed — check your email settings and try again.');
      setPhase('error');
    }
  };

  const handleProceed = () => { onProceedLive(); onClose(); };
  const handleRetry = () => { setPhase('preflight'); setErrorMsg(''); setResult(null); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface-container-lowest rounded-2xl ambient-shadow w-full max-w-md overflow-hidden border border-slate-100">

        {/* Header */}
        <div className="primary-gradient px-6 py-5 text-on-primary">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[22px]">rocket_launch</span>
              <h2 className="text-lg font-extrabold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Test Flight
              </h2>
            </div>
            {phase !== 'success' && (
              <button onClick={onClose} className="text-white/60 hover:text-white transition-colors p-1">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            )}
          </div>
          <p className="text-sm text-white/80 mt-1.5">
            Send and review a test email before blasting to live prospects.
          </p>
        </div>

        {/* Campaign info bar */}
        <div className="flex items-center gap-3 px-6 py-3 bg-surface-container border-b border-slate-100 text-sm">
          <span className="material-symbols-outlined text-[16px] text-secondary shrink-0">business</span>
          <span className="text-on-surface font-bold truncate">{campaignName}</span>
          <span className="ml-auto text-xs font-bold text-secondary shrink-0">{recipientCount} leads</span>
        </div>

        {/* Phase: Pre-flight */}
        {phase === 'preflight' && (
          <div className="px-6 py-6 space-y-5">
            {/* Step indicator */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full primary-gradient text-on-primary text-xs font-bold flex items-center justify-center">1</div>
                <span className="text-sm font-bold text-[#b0004a]">Send Test Email</span>
              </div>
              <div className="flex-1 h-px bg-slate-100 mx-2" />
              <div className="flex items-center gap-1.5 opacity-40">
                <div className="w-6 h-6 rounded-full bg-surface-container-high text-secondary text-xs font-bold flex items-center justify-center">2</div>
                <span className="text-sm font-semibold text-secondary">Proceed Live</span>
              </div>
            </div>

            <p className="text-sm text-secondary">
              A single email will be sent to your test address using{' '}
              <span className="font-bold text-on-surface">real lead data</span> from your campaign,
              so you see exactly what your prospects will receive.
            </p>

            <div>
              <label className="block text-sm font-bold text-on-surface mb-1.5">
                Your test email address
              </label>
              <input
                ref={inputRef}
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendTest()}
                placeholder="you@yourcompany.com"
                className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
              />
              <p className="text-xs text-secondary mt-1.5">
                Enter <span className="font-bold text-on-surface">your own email</span> — a personal or admin address you control. The subject will be prefixed with <span className="font-bold text-amber-600">Test mode-</span>.
              </p>
              {isLeadEmail && (
                <div className="mt-2 flex items-start gap-2 p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-800">
                  <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">warning</span>
                  <span>
                    <span className="font-bold">This email is a lead in your campaign.</span> Using it as a test address means the prospect will receive your test email. Use your own admin email instead.
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={handleSendTest}
              disabled={!testEmail.trim() || !testEmail.includes('@')}
              className="w-full flex items-center justify-center gap-2 primary-gradient text-on-primary px-5 py-3 rounded-xl text-sm font-bold ambient-shadow hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100 transition-transform"
            >
              <span className="material-symbols-outlined text-[18px]">send</span>
              Send Test Email
            </button>

            <p className="text-xs text-secondary text-center">
              After reviewing your test email, return here to send to{' '}
              <span className="font-bold text-on-surface">{recipientCount} live prospect{recipientCount !== 1 ? 's' : ''}</span>.
            </p>
          </div>
        )}

        {/* Phase: Sending */}
        {phase === 'sending' && (
          <div className="px-6 py-12 flex flex-col items-center gap-4 text-center">
            <Loader2 size={36} className="animate-spin text-[#b0004a]" />
            <div>
              <p className="text-sm font-bold text-on-surface">Sending test email...</p>
              <p className="text-xs text-secondary mt-1">Delivering to {testEmail}</p>
            </div>
          </div>
        )}

        {/* Phase: Success */}
        {phase === 'success' && result && (
          <div className="px-6 py-6 space-y-5">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-[#006630] text-white flex items-center justify-center">
                  <span className="material-symbols-outlined text-[14px]">check</span>
                </div>
                <span className="text-sm font-bold text-[#006630]">Test Sent</span>
              </div>
              <div className="flex-1 h-px bg-[#006630]/30 mx-2" />
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full primary-gradient text-on-primary text-xs font-bold flex items-center justify-center">2</div>
                <span className="text-sm font-bold text-[#b0004a]">Proceed Live</span>
              </div>
            </div>

            <div className="bg-[#8ff9a8]/20 border border-[#006630]/20 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-[#006630]">
                <span className="material-symbols-outlined text-[18px]">check_circle</span>
                <p className="text-sm font-bold">
                  {result.platform ? `Queued via ${result.platform}` : 'Test email delivered successfully'}
                </p>
              </div>
              <div className="text-xs text-[#006630] space-y-1 pl-7">
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[12px]">alternate_email</span>
                  <span>Sent to: <span className="font-bold">{result.sentTo}</span></span>
                </div>
                {result.sentFrom && (
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[12px]">mail</span>
                    <span>Sent from: <span className="font-bold">{result.sentFrom}</span></span>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[12px]">business</span>
                  <span>Used data from: <span className="font-bold">{result.leadUsed}</span></span>
                </div>
              </div>
            </div>

            <p className="text-sm text-secondary">
              {result.note
                ? result.note + ' Verify the subject, body, tokens, and screenshot look correct before proceeding.'
                : 'Check your inbox now. Verify subject, body, personalisation tokens, and screenshot all look correct.'}
            </p>

            <button
              onClick={handleProceed}
              className="w-full flex items-center justify-center gap-2 bg-[#006630] text-white px-5 py-3.5 rounded-xl text-sm font-bold hover:bg-[#004d24] transition-colors ambient-shadow"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              Test looks good — Send to {recipientCount} live prospects
            </button>

            <button
              onClick={onClose}
              className="w-full flex items-center justify-center gap-2 border border-slate-200 text-secondary px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-surface-container transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">cancel</span>
              Something&apos;s wrong — Cancel & Edit
            </button>
          </div>
        )}

        {/* Phase: Error */}
        {phase === 'error' && (
          <div className="px-6 py-6 space-y-5">
            <div className="bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-[20px] text-[#b0004a] shrink-0 mt-0.5">error</span>
                <div>
                  <p className="text-sm font-bold text-[#b0004a]">Test email failed</p>
                  <p className="text-xs text-[#b0004a]/80 mt-1">{errorMsg}</p>
                </div>
              </div>
            </div>

            <p className="text-sm text-secondary">
              Fix the issue above and try the test again.
            </p>

            <button
              onClick={handleRetry}
              className="w-full flex items-center justify-center gap-2 primary-gradient text-on-primary px-5 py-3 rounded-xl text-sm font-bold ambient-shadow hover:scale-[1.01] transition-transform"
            >
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              Retry Test Email
            </button>

            <button
              onClick={onClose}
              className="w-full text-sm text-secondary hover:text-on-surface transition-colors py-1 font-semibold"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
