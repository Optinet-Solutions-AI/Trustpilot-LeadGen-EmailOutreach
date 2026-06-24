import { describe, it, expect } from 'vitest';
import { classifyInboundBounce, classifyBounceFromSnippet } from './bounce-tracker';

// A realistic Google "Address not found" NDR as it arrives in a sender's
// IMAP inbox: from mailer-daemon, multipart/report content type, the
// human-readable failure paragraph plus the SMTP refusal text.
const POPSHELF_NDR = {
  fromAddr: 'mailer-daemon@googlemail.com',
  subject: 'Delivery Status Notification (Failure)',
  headers: {
    'content-type': 'multipart/report; report-type=delivery-status; boundary="000000"',
  },
  body: [
    "Your message wasn't delivered to support@popshelf.co.uk because the address",
    "couldn't be found, or is unable to receive mail.",
    '',
    'The response was:',
    'The email account that you tried to reach does not exist.',
    '550 5.1.1 The email account that you tried to reach does not exist. NoSuchUser',
  ].join('\n'),
};

describe('classifyInboundBounce', () => {
  it('flags a Google "Address not found" NDR as a hard bounce and extracts the dead address', () => {
    const r = classifyInboundBounce(POPSHELF_NDR);
    expect(r.isBounce).toBe(true);
    expect(r.type).toBe('hard');
    expect(r.bouncedEmail).toBe('support@popshelf.co.uk');
  });

  it('flags a 452 mailbox-full report from mailer-daemon as a soft bounce', () => {
    const r = classifyInboundBounce({
      fromAddr: 'MAILER-DAEMON@mx.bluehost.com',
      subject: 'Mail delivery delayed',
      headers: {},
      body: "452 4.2.2 The recipient's mailbox is full, please try again later.",
    });
    expect(r.isBounce).toBe(true);
    expect(r.type).toBe('soft');
  });

  it('does NOT flag a genuine human reply', () => {
    const r = classifyInboundBounce({
      fromAddr: 'jane@popshelf.co.uk',
      subject: 'Re: Something caught our eye about Popshelf',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: "Thanks for reaching out — happy to hop on a call next week. Best, Jane",
    });
    expect(r.isBounce).toBe(false);
  });

  it('does NOT flag an out-of-office auto-reply (that belongs on the auto path, not bounce)', () => {
    const r = classifyInboundBounce({
      fromAddr: 'jane@popshelf.co.uk',
      subject: 'Automatic reply: Something caught our eye',
      headers: { 'auto-submitted': 'auto-replied' },
      body: 'I am currently out of the office until Monday and will reply on my return.',
    });
    expect(r.isBounce).toBe(false);
  });
});

describe('classifyBounceFromSnippet', () => {
  it('detects a hard bounce from a stored reply_snippet body alone (no headers/from)', () => {
    // The backfill only has campaign_leads.reply_snippet — the body text the
    // live tracker saved when it (wrongly) marked the row "replied". No From,
    // no Content-Type, no subject.
    const r = classifyBounceFromSnippet(POPSHELF_NDR.body);
    expect(r.isBounce).toBe(true);
    expect(r.type).toBe('hard');
    expect(r.bouncedEmail).toBe('support@popshelf.co.uk');
  });

  it('falls back to the supplied lead email when the snippet has no extractable address', () => {
    const r = classifyBounceFromSnippet(
      'Undeliverable: the recipient address was rejected. NoSuchUser.',
      'owner@deadshop.example',
    );
    expect(r.isBounce).toBe(true);
    expect(r.bouncedEmail).toBe('owner@deadshop.example');
  });

  it('does NOT flag a genuine human reply snippet', () => {
    const r = classifyBounceFromSnippet(
      "Hi — thanks, this looks interesting. Can you send pricing? We're at 550 King St.",
    );
    expect(r.isBounce).toBe(false);
  });

  it('does NOT flag a transient/soft failure snippet (backfill reclassifies permanent bounces only)', () => {
    const r = classifyBounceFromSnippet(
      "452 4.2.2 mailbox is full, the server will keep trying for 48 hours.",
    );
    expect(r.isBounce).toBe(false);
  });

  it('treats empty/null snippets as not-a-bounce', () => {
    expect(classifyBounceFromSnippet(null).isBounce).toBe(false);
    expect(classifyBounceFromSnippet('').isBounce).toBe(false);
    expect(classifyBounceFromSnippet('   ').isBounce).toBe(false);
  });
});
