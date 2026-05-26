/**
 * On-demand reply-body fetcher for Gmail-OAuth sender accounts.
 *
 * Mirrors imap-reply-fetcher.ts but uses the Gmail API instead of IMAP.
 * Used by /api/inbox/rendered-send when an older reply was flagged as
 * status='replied' but the body never landed in reply_snippet. Returns
 * null on any failure so the calling route can fall back to its
 * placeholder tile.
 */

import { createGmailClientFromCredentials } from './gmail-client.js';

export interface GmailCreds {
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string;
}

interface GmailHeader { name?: string | null; value?: string | null }
interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(payload: GmailPart | null | undefined): string {
  if (!payload) return '';
  let plain = '';
  let html = '';
  const walk = (part: GmailPart | null | undefined): void => {
    if (!part) return;
    const mime = part.mimeType ?? '';
    if (mime === 'text/plain' && part.body?.data) {
      plain = decodeBase64Url(part.body.data);
    } else if (mime === 'text/html' && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    }
    if (part.parts) for (const p of part.parts) walk(p);
  };
  walk(payload);
  if (plain.trim()) return plain;
  if (html.trim()) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

/**
 * Fetch the body of the first inbound message from `leadEmail` for this
 * Gmail-OAuth sender, scoped to messages received around `referenceDate`
 * (±21 days). Returns the body capped at 4000 chars, or null when
 * nothing can be found / parsed / read.
 */
export async function fetchReplyBodyFromGmail(
  creds: GmailCreds,
  leadEmail: string,
  referenceDate: string | null,
): Promise<string | null> {
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    console.warn('[GmailReplyFetcher] missing OAuth credentials');
    return null;
  }
  const target = leadEmail.toLowerCase();
  if (!target) return null;

  // ±21d window expressed as Gmail's after:/before: search operators
  // (epoch seconds). Mirrors the IMAP fetcher's window so behaviour is
  // consistent across senders.
  const anchorMs = referenceDate ? new Date(referenceDate).getTime() : Date.now();
  const afterSec = Math.floor((anchorMs - 21 * 24 * 60 * 60 * 1000) / 1000);
  const beforeSec = Math.floor((anchorMs + 21 * 24 * 60 * 60 * 1000) / 1000);
  const q = `from:${target} after:${afterSec} before:${beforeSec}`;

  try {
    const gmail = createGmailClientFromCredentials(creds.clientId, creds.clientSecret, creds.refreshToken);
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (ids.length === 0) {
      console.warn(`[GmailReplyFetcher] no Gmail matches for ${q}`);
      return null;
    }

    // Pick whichever message has internalDate closest to the anchor —
    // covers the rare case where the same address sent unrelated mail
    // inside the same window. Metadata-format fetch keeps this cheap;
    // we re-fetch the chosen one in full for the body.
    let bestId: string | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      try {
        const meta = await gmail.users.messages.get({ userId: 'me', id, format: 'minimal' });
        const t = Number(meta.data.internalDate ?? '0');
        if (!Number.isFinite(t) || t === 0) continue;
        const delta = Math.abs(t - anchorMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestId = id;
        }
      } catch (e) {
        console.warn(`[GmailReplyFetcher] metadata fetch failed for ${id}:`, e instanceof Error ? e.message : e);
      }
    }
    if (!bestId) bestId = ids[0];

    const full = await gmail.users.messages.get({ userId: 'me', id: bestId, format: 'full' });
    const body = extractBody(full.data.payload as GmailPart);
    if (!body.trim()) {
      console.warn(`[GmailReplyFetcher] empty body parsed from message ${bestId}`);
      return null;
    }
    return body.slice(0, 4000);
  } catch (err) {
    console.warn('[GmailReplyFetcher] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
