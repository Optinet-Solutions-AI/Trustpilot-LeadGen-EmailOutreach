'use client';

import { useState, useEffect, useRef } from 'react';
import {
  X, Rocket, Send, Loader2, CheckCircle, AlertTriangle,
  Mail, Building2, ArrowRight, XCircle,
} from 'lucide-react';

type Phase = 'preflight' | 'sending' | 'success' | 'error';

interface TestResult {
  sentTo: string;
  leadUsed: string;
  originalEmail: string;
  platform?: string;
  note?: string;
}

interface Props {
  campaignName: string;
  recipientCount: number;
  onTestFlightSend: (testEmail: string) => Promise<TestResult>;
  onProceedLive: () => void;
  onClose: () => void;
}

export default function TestFlightModal({
  campaignName,
  recipientCount,
  onTestFlightSend,
  onProceedLive,
  onClose,
}: Props) {
  const [phase, setPhase] = useState<Phase>('preflight');
  const [testEmail, setTestEmail] = useState(
    () => localStorage.getItem('testFlightEmail') || ''
  );
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the email input when the modal opens
  useEffect(() => {
    if (phase === 'preflight') inputRef.current?.focus();
  }, [phase]);

  // Block Escape while in success phase — force a deliberate choice
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'success') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, onClose]);

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

  const handleProceed = () => {
    onProceedLive();
    onClose();
  };

  const handleRetry = () => {
    setPhase('preflight');
    setErrorMsg('');
    setResult(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* ── Header ── */}
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-6 py-5 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Rocket size={20} />
              <h2 className="text-lg font-bold">Test Flight Required</h2>
            </div>
            {phase !== 'success' && (
              <button onClick={onClose} className="text-white/60 hover:text-white transition-colors">
                <X size={18} />
              </button>
            )}
          </div>
          <p className="text-sm text-indigo-100 mt-1.5">
            You must send and review a test email before blasting to live prospects.
          </p>
        </div>

        {/* ── Campaign info bar ── */}
        <div className="flex items-center gap-3 px-6 py-3 bg-gray-50 border-b text-sm">
          <Building2 size={14} className="text-gray-400 shrink-0" />
          <span className="text-gray-700 font-medium truncate">{campaignName}</span>
          <span className="ml-auto text-xs text-gray-400 shrink-0">{recipientCount} leads</span>
        </div>

        {/* ── Phase: Pre-flight (enter email) ── */}
        {phase === 'preflight' && (
          <div className="px-6 py-6 space-y-5">
            {/* Step indicator */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">1</div>
                <span className="text-sm font-semibold text-indigo-700">Send Test Email</span>
              </div>
              <div className="flex-1 h-px bg-gray-200 mx-2" />
              <div className="flex items-center gap-1.5 opacity-40">
                <div className="w-6 h-6 rounded-full bg-gray-200 text-gray-500 text-xs font-bold flex items-center justify-center">2</div>
                <span className="text-sm font-medium text-gray-400">Proceed Live</span>
              </div>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-4">
                A single email will be sent to your test address using{' '}
                <span className="font-semibold text-gray-800">real lead data</span> from your campaign,
                so you see exactly what your prospects will receive.
              </p>

              <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                Your test email address
              </label>
              <input
                ref={inputRef}
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendTest()}
                placeholder="you@yourcompany.com"
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
              <p className="text-xs text-gray-400 mt-1.5">
                The email will include a <span className="font-medium text-yellow-600">⚠ TEST MODE</span> banner
                showing the real recipient it was redirected from.
              </p>
            </div>

            <button
              onClick={handleSendTest}
              disabled={!testEmail.trim() || !testEmail.includes('@')}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white px-5 py-3 rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={15} />
              Send Test Email
            </button>

            {/* Locked production send — visually shows it's blocked */}
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 px-4 py-3">
              <div className="flex items-center gap-2 text-gray-400">
                <AlertTriangle size={14} />
                <p className="text-xs font-medium">
                  <span className="text-gray-500 font-semibold">Send to {recipientCount} live prospects</span>
                  {' '}— locked until test email is confirmed
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Phase: Sending ── */}
        {phase === 'sending' && (
          <div className="px-6 py-12 flex flex-col items-center gap-4 text-center">
            <Loader2 size={36} className="animate-spin text-indigo-600" />
            <div>
              <p className="text-sm font-semibold text-gray-800">Sending test email...</p>
              <p className="text-xs text-gray-500 mt-1">Delivering to {testEmail}</p>
            </div>
          </div>
        )}

        {/* ── Phase: Success — Test Sent, unlock Proceed ── */}
        {phase === 'success' && result && (
          <div className="px-6 py-6 space-y-5">
            {/* Step indicator — step 1 done */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold flex items-center justify-center">
                  <CheckCircle size={13} />
                </div>
                <span className="text-sm font-semibold text-green-700">Test Sent</span>
              </div>
              <div className="flex-1 h-px bg-green-300 mx-2" />
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">2</div>
                <span className="text-sm font-semibold text-indigo-700">Proceed Live</span>
              </div>
            </div>

            {/* Delivery confirmation card */}
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-green-700">
                <CheckCircle size={16} />
                <p className="text-sm font-semibold">
                  {result.platform ? `Queued via ${result.platform}` : 'Test email delivered successfully'}
                </p>
              </div>
              <div className="text-xs text-green-700 space-y-1 pl-6">
                <div className="flex items-center gap-1.5">
                  <Mail size={11} />
                  <span>Sent to: <span className="font-medium">{result.sentTo}</span></span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Building2 size={11} />
                  <span>Used data from: <span className="font-medium">{result.leadUsed}</span></span>
                </div>
              </div>
            </div>

            <p className="text-sm text-gray-600">
              {result.note
                ? result.note + ' Verify the subject, body, tokens, and screenshot look correct before proceeding.'
                : 'Check your inbox now. Verify the subject, body, personalisation tokens, and screenshot all look correct.'}
            </p>

            {/* Primary: Proceed to live */}
            <button
              onClick={handleProceed}
              className="w-full flex items-center justify-center gap-2 bg-green-600 text-white px-5 py-3.5 rounded-xl text-sm font-bold hover:bg-green-700 transition-colors shadow-sm"
            >
              <ArrowRight size={16} />
              Test looks good — Send to {recipientCount} live prospects
            </button>

            {/* Secondary: Cancel */}
            <button
              onClick={onClose}
              className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-600 px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              <XCircle size={14} />
              Something's wrong — Cancel & Edit
            </button>
          </div>
        )}

        {/* ── Phase: Error ── */}
        {phase === 'error' && (
          <div className="px-6 py-6 space-y-5">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-800">Test email failed</p>
                  <p className="text-xs text-red-600 mt-1">{errorMsg}</p>
                </div>
              </div>
            </div>

            <p className="text-sm text-gray-500">
              The live campaign is still locked. Fix the issue above and try the test again.
            </p>

            <button
              onClick={handleRetry}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white px-5 py-3 rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors"
            >
              Retry Test Email
            </button>

            <button onClick={onClose}
              className="w-full text-sm text-gray-500 hover:text-gray-700 transition-colors py-1">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
