/**
 * Which message a queued row is about to send.
 *
 * The send queue lets an operator open a lead and read the email before it
 * goes out. That is only worth anything if it resolves the SAME template the
 * sender would, so both rules live here rather than being restated at the
 * preview site: `sequence-scheduler` imports `followUpSubject` too.
 *
 * One caveat the UI has to state rather than hide: templates carry spintax,
 * and spintax is resolved at send time. A preview shows one valid rendering,
 * not the exact words that will land.
 */

export interface StepTemplate {
  step_number: number;
  template_subject: string;
  template_body: string;
}

export interface CampaignTemplate {
  template_subject: string;
  template_body: string;
}

export interface ResolvedTemplate {
  stepNumber: number;
  subject: string;
  body: string;
  isFollowUp: boolean;
}

/**
 * Force a single "Re:" so the recipient's mail client threads the follow-up
 * into the original conversation — subject is one of the three threading
 * signals, alongside In-Reply-To and References.
 *
 * Requires the colon: "Renewal reminder" is not a reply and must still be
 * prefixed. An empty subject is left alone rather than becoming a bare "Re:".
 */
export function followUpSubject(rendered: string): string {
  if (rendered.trim() === '') return rendered;
  return /^re:\s/i.test(rendered) ? rendered : `Re: ${rendered}`;
}

/**
 * The template a row will use for its NEXT send.
 *
 * `currentStep` is what has already gone out, so the next send is step+1:
 * step 1 comes from the campaign itself, anything above it from campaign_steps.
 * Returns null when the sequence is finished.
 */
export function pickStepTemplate(
  campaign: CampaignTemplate,
  steps: StepTemplate[],
  currentStep: number,
): ResolvedTemplate | null {
  const next = (Number.isFinite(currentStep) ? currentStep : 0) + 1;

  if (next === 1) {
    return {
      stepNumber: 1,
      subject: campaign.template_subject,
      body: campaign.template_body,
      isFollowUp: false,
    };
  }

  const step = steps.find((s) => s.step_number === next);
  if (!step) return null;

  return {
    stepNumber: next,
    subject: step.template_subject,
    body: step.template_body,
    isFollowUp: true,
  };
}
