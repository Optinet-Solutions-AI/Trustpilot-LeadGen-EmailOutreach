/** Routing decisions for social-platform scrape jobs, extracted as pure
 *  functions so scrape-runner stays thin and these stay unit-testable. */
const SOCIAL_PLATFORMS = new Set(['facebook', 'instagram']);

export function shouldRefuseSocialOnLinux(platform: string, osPlatform: NodeJS.Platform | string): boolean {
  return SOCIAL_PLATFORMS.has(platform) && osPlatform === 'linux';
}

export function socialProfileEnv(platform: string, socialAccountId?: string | null): Record<string, string> {
  if (!socialAccountId) return {};
  if (platform === 'facebook') return { FB_PROFILE_DIR: `C:\\fb-profiles\\${socialAccountId}` };
  if (platform === 'instagram') return { IG_PROFILE_DIR: `C:\\ig-profiles\\${socialAccountId}` };
  return {};
}
