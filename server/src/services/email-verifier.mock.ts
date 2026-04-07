/**
 * Mock email verifier — always returns valid.
 * Replace with real ZeroBounce integration when API key is available.
 */

export async function verifyEmails(emails: string[]): Promise<Array<{
  email: string;
  status: 'valid' | 'invalid' | 'catch-all' | 'unknown';
}>> {
  console.log(`[MOCK] Verifying ${emails.length} emails — all marked as valid`);
  return emails.map((email) => ({
    email,
    status: 'valid' as const,
  }));
}
