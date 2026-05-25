'use client';

/**
 * CheckpointBanner — global banner shown when any social_accounts row
 * is stuck in status='checkpoint'.
 *
 * The scraper flips status to 'checkpoint' the moment it sees a
 * captcha (see tools/scraper/platforms/facebook.py:_flag_checkpoint).
 * The operator clears the captcha by clicking through to Social
 * Accounts and hitting "Recover" on the affected row.
 *
 * Polls /api/social-accounts every 30s. Polling is fine because the
 * surface area is tiny (one query, no joins, ~10 rows ever). When the
 * Notifications stack gets real SSE/websocket plumbing we'll switch
 * over.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';

interface CheckpointAccount {
  id: string;
  platform: 'facebook' | 'instagram';
  handle: string;
  checkpoint_reason: string | null;
}

export default function CheckpointBanner() {
  const [stuck, setStuck] = useState<CheckpointAccount[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await api.get('/social-accounts');
        if (cancelled) return;
        const rows = (res.data?.data ?? []) as Array<{
          id: string; platform: 'facebook' | 'instagram'; handle: string;
          status: string; checkpoint_reason: string | null;
        }>;
        setStuck(rows.filter((r) => r.status === 'checkpoint').map((r) => ({
          id: r.id, platform: r.platform, handle: r.handle, checkpoint_reason: r.checkpoint_reason,
        })));
      } catch {
        // Banner is best-effort — never throw to the UI.
      }
    };
    void poll();
    const t = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (stuck.length === 0) return null;

  const platforms = Array.from(new Set(stuck.map((s) => s.platform))).join(' + ');

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-3">
      <span className="material-symbols-outlined text-amber-700">warning</span>
      <div className="flex-1 text-sm text-amber-800">
        <strong>{stuck.length}</strong> {platforms} account{stuck.length === 1 ? '' : 's'} hit a captcha.{' '}
        Open Social Accounts and click <strong>Recover</strong> on the affected row to clear it.
      </div>
      <a
        href="/social-accounts"
        className="text-sm font-bold text-amber-900 underline hover:text-amber-700"
      >
        Open
      </a>
    </div>
  );
}
