'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useOnboardAccount } from '../hooks/useOnboardAccount';
import CountryPicker from './CountryPicker';
import Button from '../ui/Button';

interface Props {
  onClose: () => void;
}

/**
 * 3-screen wizard so a non-technical VA can onboard a country-pinned FB
 * account without ever seeing (or typing) credentials into this app:
 *
 *   1. Pick country -> start(country, label) creates the social_accounts row.
 *   2. Log in       -> once the worker's streamed browser is ready, the VA
 *                      logs into Facebook there (a new tab, same pattern as
 *                      the existing Connect/Browse flows — no iframe is used
 *                      anywhere else in this app, likely because the
 *                      cloudflared/noVNC tunnel disallows framing).
 *   3. Done         -> complete() activates the account, then the modal
 *                      closes and the caller refreshes the accounts list.
 *
 * Visual language matches TestFlightModal.tsx: primary-gradient header,
 * numbered step indicator, crimson (#b0004a) accent, surface-container
 * neutrals, material-symbols-outlined icons, friendly (non-raw) error panels.
 */
export default function OnboardAccountModal({ onClose }: Props) {
  const { loading, error, status, tunnelUrl, start, complete } = useOnboardAccount();
  const [country, setCountry] = useState('');
  const [label, setLabel] = useState('');
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Open the streamed browser in a new tab exactly once when it's ready —
  // same guard pattern as SocialAccounts.tsx's browse/connect flows.
  const [tabOpened, setTabOpened] = useState(false);
  useEffect(() => {
    if (status === 'ready' && tunnelUrl && !tabOpened) {
      setTabOpened(true);
      window.open(tunnelUrl, '_blank', 'noopener,noreferrer');
    }
  }, [status, tunnelUrl, tabOpened]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // CountryPicker's Combobox also handles Escape (to close its own
      // dropdown) and calls e.preventDefault() on it — if a child already
      // handled the key, don't also close the whole wizard.
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const screen: 'pick-country' | 'log-in' =
    status === 'idle' || status === 'starting' ? 'pick-country' : 'log-in';

  // Step indicator: step 1 covers pick-country + provisioning, step 2
  // covers ready/completed/error — mirrors TestFlightModal's 2-step bar.
  const stepTwoActive = screen === 'log-in';

  const onCreate = () => {
    if (!country.trim()) return;
    void start(country.trim(), label.trim() || undefined);
  };

  // "Done" step: activate the account, then close the modal — the caller
  // (SocialAccounts.tsx) refreshes the accounts list on close.
  const onDone = async () => {
    setCompleting(true);
    setCompleteError(null);
    try {
      await complete();
      onClose();
    } catch (err) {
      setCompleteError((err as Error).message);
      setCompleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4">
      <div className="bg-surface-container-lowest rounded-t-2xl sm:rounded-2xl ambient-shadow w-full max-w-lg overflow-hidden border-t sm:border border-slate-100 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="primary-gradient px-6 py-5 text-on-primary">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[22px]">smart_display</span>
              <h2 className="text-lg font-extrabold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Add FB Account
              </h2>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white transition-colors p-1">
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
          <p className="text-sm text-white/80 mt-1.5">
            Pin a Facebook account to a country and log in through a secure streamed browser —
            no credentials are ever typed into this app.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-6 pt-5">
          <div className="flex items-center gap-1.5">
            <div className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${
              stepTwoActive ? 'bg-surface-container-high text-secondary' : 'primary-gradient text-on-primary'
            }`}>
              1
            </div>
            <span className={`text-sm font-bold ${stepTwoActive ? 'text-secondary' : 'text-[#b0004a]'}`}>
              Set Up Account
            </span>
          </div>
          <div className="flex-1 h-px bg-slate-100 mx-2" />
          <div className={`flex items-center gap-1.5 ${stepTwoActive ? '' : 'opacity-40'}`}>
            <div className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${
              stepTwoActive ? 'primary-gradient text-on-primary' : 'bg-surface-container-high text-secondary'
            }`}>
              2
            </div>
            <span className={`text-sm font-bold ${stepTwoActive ? 'text-[#b0004a]' : 'text-secondary'}`}>
              Log In &amp; Finish
            </span>
          </div>
        </div>

        {/* Screen 1: Pick country */}
        {screen === 'pick-country' && (
          <div className="px-6 py-6 space-y-4">
            <p className="text-sm text-secondary">
              Pick the country this Facebook account will be pinned to. A streamed browser will
              open for you to log in — no credentials are entered here.
            </p>

            <label className="block">
              <span className="block text-sm font-bold text-on-surface mb-1.5">
                Account name <span className="text-secondary font-normal">(optional)</span>
              </span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={loading}
                placeholder="e.g. FB · UK · 01"
                className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none disabled:opacity-50"
              />
            </label>

            <label className="block">
              <span className="block text-sm font-bold text-on-surface mb-1.5">Country</span>
              <CountryPicker id="onboard-country" value={country} onChange={setCountry} disabled={loading} />
            </label>

            {error && (
              <div className="flex items-start gap-3 bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl p-4">
                <span className="material-symbols-outlined text-[20px] text-[#b0004a] shrink-0 mt-0.5">error</span>
                <div>
                  <p className="text-sm font-bold text-[#b0004a]">Couldn&apos;t start onboarding</p>
                  <p className="text-xs text-[#b0004a]/80 mt-1">{error}</p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button onClick={onCreate} disabled={!country.trim() || loading} loading={loading}>
                Create
              </Button>
            </div>
          </div>
        )}

        {/* Screen 2: Log in */}
        {screen === 'log-in' && (
          <div className="px-6 py-6 space-y-4">
            {status === 'provisioning' && (
              <div className="py-10 flex flex-col items-center gap-4 text-center">
                <Loader2 size={36} className="animate-spin text-[#b0004a]" />
                <div>
                  <p className="text-sm font-bold text-on-surface">Setting up your secure browser…</p>
                  <p className="text-xs text-secondary mt-1">This usually takes about 15 seconds.</p>
                </div>
              </div>
            )}

            {status === 'ready' && tunnelUrl && (
              <div className="rounded-xl border border-[#b0004a]/20 bg-[#ffd9de]/30 p-4 space-y-3">
                <div className="flex items-center gap-2 text-[#b0004a]">
                  <span className="material-symbols-outlined text-[18px]">login</span>
                  <p className="text-sm font-bold">Your secure browser is ready</p>
                </div>
                <p className="text-sm text-secondary">
                  Log into Facebook, then click Done below. A new tab should have opened
                  automatically — if it didn&apos;t (or you need it for a captcha), use the
                  button below.
                </p>
                <a
                  href={tunnelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#b0004a] text-white text-sm font-bold no-underline hover:bg-[#8a003a] transition-colors"
                >
                  Open in new tab
                  <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                </a>
                <p className="text-[11px] text-secondary break-all select-all">{tunnelUrl}</p>
              </div>
            )}

            {status === 'completed' && (
              <div className="rounded-xl border border-[#006630]/20 bg-[#8ff9a8]/20 p-4">
                <div className="flex items-center gap-2 text-[#006630]">
                  <span className="material-symbols-outlined text-[18px]">check_circle</span>
                  <p className="text-sm font-bold">Account connected</p>
                </div>
                <p className="text-xs text-[#006630] mt-1 pl-6">
                  This account is now active and ready to use.
                </p>
              </div>
            )}

            {(status === 'failed' || status === 'expired') && (
              <div className="flex items-start gap-3 bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl p-4">
                <span className="material-symbols-outlined text-[20px] text-[#b0004a] shrink-0 mt-0.5">error</span>
                <div>
                  <p className="text-sm font-bold text-[#b0004a]">
                    {status === 'expired' ? 'Login window expired' : 'Onboarding failed'}
                  </p>
                  <p className="text-xs text-[#b0004a]/80 mt-1">
                    {error ?? 'Something went wrong setting up this account.'}
                  </p>
                </div>
              </div>
            )}

            {completeError && (
              <div className="flex items-start gap-3 bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl p-4">
                <span className="material-symbols-outlined text-[20px] text-[#b0004a] shrink-0 mt-0.5">error</span>
                <div>
                  <p className="text-sm font-bold text-[#b0004a]">Couldn&apos;t finish onboarding</p>
                  <p className="text-xs text-[#b0004a]/80 mt-1">{completeError}</p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>
                {status === 'completed' ? 'Close' : 'Cancel'}
              </Button>
              {status !== 'completed' && (
                <Button
                  onClick={() => void onDone()}
                  disabled={status !== 'ready' || completing}
                  loading={completing}
                >
                  Done
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
