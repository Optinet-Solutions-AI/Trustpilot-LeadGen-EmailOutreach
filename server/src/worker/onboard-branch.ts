/**
 * The `connect_mode='onboard'` branch of the social-connect worker, extracted
 * as a thin, dependency-injected sequence so it is unit-testable without a
 * real Supabase connection, AdsPower Local API, or spawned processes.
 *
 * Order matters: a profile must exist (and be recorded) before we can stream
 * it, and the row must not flip to 'ready' until the stream actually has a
 * tunnel URL. Activation (status='active', connect_status='captured') is done
 * by the API route (POST /:id/onboard-complete) once the VA finishes the FB
 * login in the streamed browser — NOT here.
 */
export interface OnboardDeps {
  createProfile: (country: string, proxyJson: string) => Promise<string>;
  recordProfileId: (accountId: string, profileId: string) => Promise<void>;
  spawnStream: (accountId: string, profileId: string) => Promise<string>;
  setReady: (accountId: string, tunnelUrl: string) => Promise<void>;
}

export async function buildOnboardSteps(
  job: { accountId: string; country: string; proxyJson: string },
  deps: OnboardDeps,
): Promise<void> {
  const profileId = await deps.createProfile(job.country, job.proxyJson);
  await deps.recordProfileId(job.accountId, profileId);
  const tunnelUrl = await deps.spawnStream(job.accountId, profileId);
  await deps.setReady(job.accountId, tunnelUrl);
}
