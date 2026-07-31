/** Routing decisions for social-platform scrape jobs, extracted as pure
 *  functions so scrape-runner stays thin and these stay unit-testable. */
const SOCIAL_PLATFORMS = new Set(['facebook', 'instagram']);

/** Does a Facebook job actually open a browser? Discovery via Apify plus
 *  stub enrichment is pure HTTP, so it carries none of the Linux
 *  fingerprint risk that motivated the refusal below. Both default to the
 *  browserless mode, matching the Python defaults in facebook.py. */
export function facebookJobUsesBrowser(env: Record<string, string | undefined>): boolean {
  const discovery = (env.FB_DISCOVERY || 'apify').trim().toLowerCase();
  const enrich = (env.FB_ENRICH || 'stub').trim().toLowerCase();
  return discovery !== 'apify' || enrich !== 'stub';
}

export function shouldRefuseSocialOnLinux(
  platform: string,
  osPlatform: NodeJS.Platform | string,
  opts: { usesBrowser?: boolean } = {},
): boolean {
  if (!SOCIAL_PLATFORMS.has(platform) || osPlatform !== 'linux') return false;
  // Defaults to true: a caller that does not know whether a browser is
  // involved gets the old, safe behaviour.
  return opts.usesBrowser ?? true;
}

export function socialProfileEnv(platform: string, socialAccountId?: string | null): Record<string, string> {
  if (!socialAccountId) return {};
  if (platform === 'facebook') return { FB_PROFILE_DIR: `C:\\fb-profiles\\${socialAccountId}` };
  if (platform === 'instagram') return { IG_PROFILE_DIR: `C:\\ig-profiles\\${socialAccountId}` };
  return {};
}
