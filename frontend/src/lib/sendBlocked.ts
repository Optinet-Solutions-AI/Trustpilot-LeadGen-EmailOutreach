/**
 * The campaign send gate refuses to dispatch to addresses we can't stand
 * behind: proven invalid, or never verified. Before 2026-09-02 that refusal
 * arrived as a bare error string, which told the operator a launch had failed
 * but not WHICH recipients caused it or what to do about them — so the only
 * move was to delete the campaign and rebuild it.
 *
 * The route now returns the offending rows. This module carries them from the
 * axios rejection to the UI intact.
 */

export interface BlockedRecipient {
  campaignLeadId: string;
  leadId: string;
  email: string | null;
  companyName: string | null;
  verificationStatus: string | null;
  /** 'invalid' = verifier proved the mailbox dead. 'unverified' = never checked. */
  reason: 'invalid' | 'unverified';
}

export interface BlockedSummary {
  invalid: number;
  unverified: number;
  total: number;
}

/**
 * Pulls the structured block payload off a failed send, if that's why it
 * failed. Returns null for every other error so ordinary failures keep their
 * ordinary toast.
 */
export function blockedRecipientsFrom(
  err: unknown,
): { recipients: BlockedRecipient[]; summary: BlockedSummary; message: string } | null {
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data as
    | { error?: string; blockedLeads?: BlockedRecipient[]; blockedSummary?: BlockedSummary }
    | undefined;
  if (!data?.blockedLeads?.length) return null;
  const recipients = data.blockedLeads;
  const summary = data.blockedSummary ?? {
    invalid: recipients.filter((r) => r.reason === 'invalid').length,
    unverified: recipients.filter((r) => r.reason === 'unverified').length,
    total: recipients.length,
  };
  return {
    recipients,
    summary,
    message: data.error ?? 'Send blocked by unsendable recipients.',
  };
}
