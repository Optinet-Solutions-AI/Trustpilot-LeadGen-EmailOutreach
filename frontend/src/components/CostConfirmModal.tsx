'use client';

import { useEffect, useState } from 'react';
import api from '../api/client';
import Button from '../ui/Button';

/**
 * Show what a run will cost, and get a yes, before spending anything.
 *
 * Scraping could only ever report its spend AFTER the fact — the whole point
 * is discovering businesses nobody has counted. Enrichment and verification
 * are different: the work is a known list, so the price is knowable up front,
 * and an operator should not have to start a run to find out what it costs.
 *
 * TWO RULES THIS FOLLOWS
 *
 *   - A figure we do not hold is never invented. The estimator returns credits
 *     and a null dollar amount when no rate is configured, and this renders
 *     exactly that. A made-up number gets quoted back as fact.
 *   - A failed estimate does not block the run. The estimator is a courtesy,
 *     not a gate; if it errors, say the cost is unknown and let the operator
 *     decide. Refusing to work because pricing failed would be worse than the
 *     problem it solves.
 */

export interface CostEstimate {
  usd: number | null;
  units: number;
  unitLabel: string;
  vendor: string;
  isCeiling: boolean;
  summary: string;
  /** 'queue' when the server counted the work itself ("enrich all"). */
  scope?: 'queue' | 'selection';
}

interface Props {
  open: boolean;
  title: string;
  /** Estimate endpoint, relative to the API base — e.g. `/enrich/estimate?leads=25`. */
  estimatePath: string;
  /** Anything the estimate itself cannot know, e.g. that valid addresses are skipped. */
  note?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const money = (usd: number): string =>
  usd < 0.01 ? `$${usd.toFixed(4)}` : usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;

export default function CostConfirmModal({
  open,
  title,
  estimatePath,
  note,
  confirmLabel = 'Run',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setEstimate(null);
    api.get(estimatePath)
      .then((res) => {
        if (!cancelled) setEstimate(res.data.data as CostEstimate);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, estimatePath]);

  if (!open) return null;

  const free = estimate?.usd === 0;
  const priced = estimate && estimate.usd !== null && estimate.usd > 0;

  // The button carries the number, so the cost is visible at the moment of
  // committing rather than only in a paragraph above it.
  const runLabel = loading
    ? 'Pricing…'
    : priced
      ? `${confirmLabel} — ${estimate.isCeiling ? 'up to ' : ''}${money(estimate.usd as number)}`
      : free
        ? `${confirmLabel} (free)`
        : confirmLabel;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl ambient-shadow max-w-md w-full p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className={`rounded-full p-2 ${priced ? 'bg-[#fff0d9]' : 'bg-[#e4f2e4]'}`}>
            <span className={`material-symbols-outlined ${priced ? 'text-[#8a5300]' : 'text-[#1f6b33]'}`}>
              {priced ? 'payments' : 'check_circle'}
            </span>
          </div>
          <div className="min-w-0">
            <h3
              className="text-lg font-bold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {title}
            </h3>

            {loading && (
              <p className="text-sm text-secondary mt-1">Working out what this will cost…</p>
            )}

            {failed && (
              <p className="text-sm text-secondary mt-1">
                Couldn&apos;t price this run — the estimate is unavailable. You can still go ahead;
                the actual spend is recorded on the job either way.
              </p>
            )}

            {estimate && (
              <>
                <p className="text-sm text-secondary mt-1">{estimate.summary}</p>
                {estimate.isCeiling && priced && (
                  <p className="text-xs text-secondary mt-1">
                    That&apos;s a ceiling — most runs come in under it.
                  </p>
                )}
                {estimate.scope === 'queue' && (
                  <p className="text-xs text-secondary mt-1">
                    Counted across every lead that still has no website email.
                  </p>
                )}
              </>
            )}

            {note && <p className="text-xs text-secondary mt-1">{note}</p>}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy || loading} loading={busy}>
            {runLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
