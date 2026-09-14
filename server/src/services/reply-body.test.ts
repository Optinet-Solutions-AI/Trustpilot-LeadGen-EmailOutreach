import { describe, test, expect } from 'vitest';
import { assessReplyBody } from './reply-body.js';

/**
 * A reply's body is fetched in a second round-trip after the match. When that
 * fetch failed, the caller treated the result as an EMPTY body and recorded
 * the reply anyway — which did three bad things at once:
 *
 *  - the snippet was stored as null, so the Inbox had nothing to show
 *  - the bounce and auto-reply classifiers ran on an empty string, so a
 *    bounce or an out-of-office was recorded as a genuine human reply
 *  - `markReplied` only matches rows still at status='sent', so once flipped
 *    the row could never be revisited and the body was lost for good
 *
 * Measured 2026-09-14: all 7 replies since 1 September had reply_snippet
 * empty, including a Luxplus office-hours auto-responder stored as 'replied'.
 *
 * The distinction that matters is "we could not read it" versus "we read it
 * and it was empty". Only the second is safe to record.
 */

describe('assessReplyBody', () => {
  test('a successful fetch with content is usable', () => {
    expect(assessReplyBody(true, 'Thanks, please send the audit.')).toEqual({
      usable: true, body: 'Thanks, please send the audit.',
    });
  });

  test('a FAILED fetch is not usable, so the message is left for the next poll', () => {
    // The whole point. Recording now would consume the only chance to read it.
    expect(assessReplyBody(false, '')).toEqual({ usable: false, reason: 'fetch_failed' });
  });

  test('a failed fetch is not rescued by whatever text came with it', () => {
    // Partial text from a broken fetch is not something to classify against.
    expect(assessReplyBody(false, 'some partial junk')).toEqual({
      usable: false, reason: 'fetch_failed',
    });
  });

  test('a successful fetch of a genuinely empty body IS recorded', () => {
    // People do send blank replies. That is a real reply, just a quiet one,
    // and it must not be retried for ever.
    expect(assessReplyBody(true, '')).toEqual({ usable: true, body: '' });
  });

  test('whitespace-only counts as read-and-empty, not as a failure', () => {
    expect(assessReplyBody(true, '   \n\n  ')).toEqual({ usable: true, body: '   \n\n  ' });
  });

  test('a null body from a successful fetch is treated as empty, not failed', () => {
    expect(assessReplyBody(true, null)).toEqual({ usable: true, body: '' });
  });
});
