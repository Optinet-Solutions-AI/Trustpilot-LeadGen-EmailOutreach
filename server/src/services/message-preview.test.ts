import { describe, test, expect } from 'vitest';
import { followUpSubject, pickStepTemplate, type StepTemplate } from './message-preview.js';

/**
 * Previewing a queued email is only useful if it renders what the sender would
 * actually produce. These pin the two places the preview could silently drift
 * from the real send path: the follow-up subject prefix, and which step's
 * template a given row is about to use.
 */

describe('followUpSubject', () => {
  test('prefixes Re: so the reply threads in the recipient MUA', () => {
    expect(followUpSubject('Quick thought on Acme')).toBe('Re: Quick thought on Acme');
  });

  test('does not double-prefix when the operator already wrote Re:', () => {
    expect(followUpSubject('Re: Quick thought')).toBe('Re: Quick thought');
  });

  test('treats the existing prefix case-insensitively', () => {
    expect(followUpSubject('RE: Quick thought')).toBe('RE: Quick thought');
    expect(followUpSubject('re: quick thought')).toBe('re: quick thought');
  });

  test('a subject merely starting with the letters "re" is still prefixed', () => {
    // "Renewal" is not a reply. Requiring the colon and space is what separates
    // them, and getting this wrong would silently drop threading.
    expect(followUpSubject('Renewal reminder')).toBe('Re: Renewal reminder');
  });

  test('an empty subject is left alone rather than becoming a bare "Re:"', () => {
    expect(followUpSubject('')).toBe('');
    expect(followUpSubject('   ')).toBe('   ');
  });
});

describe('pickStepTemplate', () => {
  const steps: StepTemplate[] = [
    { step_number: 2, template_subject: 'Following up', template_body: '<p>Second</p>' },
    { step_number: 3, template_subject: 'One more', template_body: '<p>Third</p>' },
  ];
  const campaign = { template_subject: 'First touch', template_body: '<p>Hello</p>' };

  test('a row on step 1 will send the campaign template next... as step 2', () => {
    // current_step is what has ALREADY gone out, so the next send is step+1.
    const t = pickStepTemplate(campaign, steps, 1);
    expect(t).toMatchObject({ stepNumber: 2, subject: 'Following up', isFollowUp: true });
  });

  test('a row that has sent nothing yet gets the campaign template as step 1', () => {
    const t = pickStepTemplate(campaign, steps, 0);
    expect(t).toMatchObject({ stepNumber: 1, subject: 'First touch', isFollowUp: false });
  });

  test('a row on step 2 moves to step 3', () => {
    expect(pickStepTemplate(campaign, steps, 2)).toMatchObject({ stepNumber: 3, subject: 'One more' });
  });

  test('a row past the last step has nothing left to send', () => {
    expect(pickStepTemplate(campaign, steps, 3)).toBeNull();
  });

  test('a campaign with no follow-up steps ends after the first touch', () => {
    expect(pickStepTemplate(campaign, [], 1)).toBeNull();
    expect(pickStepTemplate(campaign, [], 0)).toMatchObject({ stepNumber: 1, isFollowUp: false });
  });

  test('steps out of order are still resolved by number, not position', () => {
    const jumbled: StepTemplate[] = [
      { step_number: 3, template_subject: 'Third', template_body: 'c' },
      { step_number: 2, template_subject: 'Second', template_body: 'b' },
    ];
    expect(pickStepTemplate(campaign, jumbled, 1)).toMatchObject({ stepNumber: 2, subject: 'Second' });
  });
});
