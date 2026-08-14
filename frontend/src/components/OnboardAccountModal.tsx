'use client';

import { useEffect, useState } from 'react';
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
 *   1. Pick country -> start(country) creates the social_accounts row.
 *   2. Log in       -> once the worker's streamed browser is ready, the VA
 *                      logs into Facebook there (a new tab, same pattern as
 *                      the existing Connect/Browse flows — no iframe is used
 *                      anywhere else in this app, likely because the
 *                      cloudflared/noVNC tunnel disallows framing).
 *   3. Done         -> complete() activates the account, then the modal
 *                      closes and the caller refreshes the accounts list.
 */
export default function OnboardAccountModal({ onClose }: Props) {
  const { loading, error, status, tunnelUrl, start, complete } = useOnboardAccount();
  const [country, setCountry] = useState('');
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

  const onCreate = () => {
    if (!country.trim()) return;
    void start(country.trim());
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-slate-200 shadow-lg w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Add FB Account</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Screen 1: Pick country */}
        {screen === 'pick-country' && (
          <div className="px-6 py-6 space-y-4">
            <p className="text-sm text-slate-600">
              Pick the country this Facebook account will be pinned to. A streamed browser will
              open for you to log in — no credentials are entered here.
            </p>
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Country</span>
              <CountryPicker id="onboard-country" value={country} onChange={setCountry} disabled={loading} />
            </label>
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                {error}
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
            {(status === 'provisioning') && (
              <p className="text-sm text-slate-600">Setting up your browser…</p>
            )}

            {status === 'ready' && tunnelUrl && (
              <>
                <p className="text-sm text-slate-600">
                  Log into Facebook, then click Done. A new tab should have opened automatically —
                  if it didn&apos;t (or you need it for a captcha), use the link below.
                </p>
                <a
                  href={tunnelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-3 py-1.5 rounded bg-[#b0004a] text-white text-sm font-semibold no-underline"
                >
                  Open in new tab ↗
                </a>
                <p className="text-[11px] text-slate-500 break-all select-all">{tunnelUrl}</p>
              </>
            )}

            {(status === 'failed' || status === 'expired') && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                {error ?? 'Onboarding failed.'}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() => void onDone()}
                disabled={status !== 'ready' || completing}
                loading={completing}
              >
                Done
              </Button>
            </div>
            {completeError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                {completeError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
