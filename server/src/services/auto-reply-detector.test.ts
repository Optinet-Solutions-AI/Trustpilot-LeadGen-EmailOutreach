import { describe, it, expect } from 'vitest';
import { classifyReply, detectOptOut } from './auto-reply-detector';

// The exact Home Teeth Whitening ticket auto-acknowledgement that the live
// classifier scored 0.3 (just under the 0.4 threshold) and mislabeled as a
// human "Replied". It carries multiple unmistakable helpdesk markers.
const HOME_TEETH_WHITENING = [
  '##- Please type your reply above this line -##',
  '',
  'Thanks for your email',
  '',
  'Important: For urgent requests such as order cancellations or address changes, please use the chat function here: https://www.hometeethwhitening.com/contact-us/. Email responses may take 24-48 hours and we cannot guarantee your request will be processed before your order ships.',
  '',
  'Your request (115344) has been received and is being reviewed by our support staff.',
  '',
  "We'll do all we can to get back to you within 24-48 hours however during busy periods this may be longer.",
  '',
  'To add additional comments, reply to this email.',
  '',
  'Regards',
  'Home Teeth Whitening',
].join('\n');

describe('classifyReply — ticket auto-acknowledgements', () => {
  it('flags the Home Teeth Whitening helpdesk ack as auto/ticket above threshold', () => {
    const v = classifyReply({ headers: {}, subject: 'Re: Something caught our eye', body: HOME_TEETH_WHITENING });
    expect(['auto', 'ticket']).toContain(v.kind);
    expect(v.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('treats the "reply above this line" delimiter as a ticket signal', () => {
    const v = classifyReply({
      headers: {},
      subject: 'Re: hello',
      body: '##- Please type your reply above this line -##\n\nWe received your message.',
    });
    expect(v.kind).toBe('ticket');
  });

  it('detects a parenthesized request/ticket number', () => {
    const v = classifyReply({
      headers: {},
      subject: 'Re: hello',
      body: 'Your request (115344) has been received and is being reviewed by our support staff.',
    });
    expect(v.kind).toBe('ticket');
  });

  it('detects a numeric-range response-time promise as an auto signal', () => {
    const v = classifyReply({
      headers: {},
      subject: 'Re: hello',
      body: 'Thanks for your email. We will get back to you within 24-48 hours.',
    });
    expect(['auto', 'ticket']).toContain(v.kind);
    expect(v.confidence).toBeGreaterThanOrEqual(0.4);
  });
});

describe('classifyReply — genuine human replies stay human', () => {
  it('keeps an interested prospect reply as human', () => {
    const v = classifyReply({
      headers: {},
      subject: 'Re: Something caught our eye',
      body: "Thanks for reaching out. We're interested — can you send pricing and a sample report? Happy to book a call next week. Best, Jane",
    });
    expect(v.kind).toBe('human');
  });

  it('keeps a plain info request as human', () => {
    const v = classifyReply({
      headers: {},
      subject: 'Re: hello',
      body: 'Please send more information about your reputation management service.',
    });
    expect(v.kind).toBe('human');
  });

  it('keeps an opt-out/do-not-contact reply as human (opt-out is handled separately, not as auto)', () => {
    const v = classifyReply({
      headers: {},
      subject: 'Re: Something caught our eye',
      body: 'We are fully aware of our online presence and handle review management internally. We are not interested. Please remove KBM Builders from your database and mark us as "do not contact".',
    });
    expect(v.kind).toBe('human');
  });
});

describe('detectOptOut', () => {
  it('flags the KBM "remove us / do not contact" reply', () => {
    const r = detectOptOut(
      'We are not interested. Please remove KBM Builders from your database and mark us as "do not contact".',
    );
    expect(r.isOptOut).toBe(true);
    expect(r.phrase).toBeTruthy();
  });

  it('flags unsubscribe / take me off the list / stop emailing', () => {
    expect(detectOptOut('Please unsubscribe me.').isOptOut).toBe(true);
    expect(detectOptOut('Take us off your mailing list.').isOptOut).toBe(true);
    expect(detectOptOut('Stop emailing me.').isOptOut).toBe(true);
    expect(detectOptOut('We no longer wish to be contacted.').isOptOut).toBe(true);
  });

  it('does NOT flag a genuinely interested reply', () => {
    expect(detectOptOut("Thanks — we're interested, can you send pricing and a sample report?").isOptOut).toBe(false);
  });

  it('does NOT flag an innocuous use of "remove" (not a list/database removal)', () => {
    expect(detectOptOut('Could you remove the screenshot from the email? It looks blurry.').isOptOut).toBe(false);
  });

  it('treats empty input as not opt-out', () => {
    expect(detectOptOut('').isOptOut).toBe(false);
    expect(detectOptOut(null as unknown as string).isOptOut).toBe(false);
  });
});
