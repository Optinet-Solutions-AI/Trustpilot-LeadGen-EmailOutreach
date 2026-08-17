'use client';

import { useEffect } from 'react';
import type { LeadAccountOption } from '../hooks/useLeadAccounts';

interface Props {
  accounts: LeadAccountOption[];
  country: string | null;
  onSelect: (accountId: string) => void;
  onClose: () => void;
}

/**
 * Shown when a lead's country has more than one active FB account pinned to
 * it — lets the VA pick which account drives the "Open as James (hosted)"
 * session instead of it being picked silently. Only appears for the >1
 * case; 0 accounts shows an inline message instead, and exactly 1 account
 * is used straight away with no extra click.
 *
 * Visual language mirrors OnboardAccountModal.tsx (primary-gradient header,
 * crimson accent, surface-container neutrals) but is a single screen since
 * there's nothing to configure here, just a choice to make.
 */
export default function AccountPickerModal({ accounts, country, onSelect, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4">
      <div className="bg-surface-container-lowest rounded-t-2xl sm:rounded-2xl ambient-shadow w-full max-w-md overflow-hidden border-t sm:border border-slate-100 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="primary-gradient px-6 py-5 text-on-primary">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[22px]">switch_account</span>
              <h2 className="text-lg font-extrabold" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Choose an Account
              </h2>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white transition-colors p-1">
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
          <p className="text-sm text-white/80 mt-1.5">
            {accounts.length} active accounts are pinned to {country ?? "this lead's"}
            {' '}— pick which one drives this session.
          </p>
        </div>

        {/* Account list — least-used first, as returned by the API */}
        <div className="px-6 py-5 space-y-2">
          {accounts.map((acc) => {
            const dailyLabel = acc.daily_cap != null
              ? `${acc.used_today}/${acc.daily_cap} today`
              : `${acc.used_today} today`;
            return (
              <button
                key={acc.id}
                onClick={() => onSelect(acc.id)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:border-[#b0004a]/40 hover:bg-[#ffd9de]/20 transition-colors text-left"
              >
                <div className="min-w-0">
                  <p className="text-sm font-bold text-on-surface truncate">{acc.display_name}</p>
                  {acc.handle && <p className="text-xs text-secondary truncate">{acc.handle}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-bold text-[#b0004a]">{dailyLabel}</p>
                  {acc.hourly_cap != null && (
                    <p className="text-[10px] text-secondary">{acc.hourly_cap}/hr cap</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="px-6 pb-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
