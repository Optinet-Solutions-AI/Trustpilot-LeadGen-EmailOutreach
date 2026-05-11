'use client';

import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title rendered in the sheet header. */
  title?: string;
  children: React.ReactNode;
  /** Max height as a CSS length; defaults to 80vh. */
  maxHeight?: string;
}

/**
 * Bottom sheet for mobile. Centered/positioned dropdowns on desktop should
 * NOT use this — they should keep their existing absolute layout and
 * conditionally render this on `< sm` instead. Caller is responsible for
 * the conditional.
 */
export default function MobileBottomSheet({ open, onClose, title, children, maxHeight = '80vh' }: Props) {
  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-[60]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-0 bottom-0 z-[61] bg-white rounded-t-2xl shadow-2xl flex flex-col"
        style={{ maxHeight }}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
            <p className="text-sm font-extrabold text-on-surface">{title}</p>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-slate-500 hover:text-[#b0004a] -mr-2 p-2"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1">{children}</div>
      </div>
    </>
  );
}
