// Trustpilot "Profile claimed" detector. Runs inside Playwright via
// page.evaluate() — mirrors the JS block in tools/scraper/scrape_profile.py
// so a fresh scrape and a recheck job produce the same verdicts.
//
// Tri-state output:
//   true  — owner has claimed the profile (visible "Profile claimed" badge)
//   false — explicit "Claim this profile" CTA (proves it's unclaimed)
//   null  — couldn't determine; preserved by upsert callers so previous
//           true/false values aren't clobbered on a transient detection miss.
import type { Page } from 'playwright';

const CLAIMED_DETECT_JS = `() => {
  let claimed = null;

  // Priority 1: stable data attributes / test ids (survive class-name churn)
  const dataAttr = document.querySelector(
    '[data-business-unit-claimed], [data-testid*="claimed" i], [data-claimed]'
  );
  if (dataAttr) {
    const v = dataAttr.getAttribute('data-business-unit-claimed') ||
              dataAttr.getAttribute('data-claimed');
    claimed = v ? v.toLowerCase() !== 'false' : true;
  }

  // Priority 2: localized "Profile claimed" badge near the company header
  if (claimed === null) {
    const h1 = document.querySelector('h1');
    const header = h1 ? h1.closest('header, section, div') : null;
    const scopeText = (header || document.body).innerText || '';
    const RX = /\\b(profile claimed|profil beansprucht|geclaimd profiel|profil revendiqué|perfil reclamado|profilo verificato)\\b/i;
    if (RX.test(scopeText)) claimed = true;
  }

  // Priority 3: "Claim this profile" CTA OR "Unclaimed profile" status label.
  // Defunct profiles (where the company's site has closed) drop the CTA but
  // still display the localized status label, so we match both forms.
  if (claimed === null) {
    const ctaRx = /\\b(claim (your|this) profile|reclamar perfil|profil beanspruchen|claim profiel|revendiquer ce profil|unclaimed profile|profil non revendiqué|perfil no reclamado|profilo non rivendicato|niet-geclaimd profiel|nicht beanspruchtes profil)\\b/i;
    if (ctaRx.test(document.body.innerText || '')) claimed = false;
  }

  return claimed;
}`;

export async function detectProfileClaimed(page: Page): Promise<boolean | null> {
  try {
    const result = await page.evaluate(CLAIMED_DETECT_JS);
    if (result === true || result === false) return result;
    return null;
  } catch {
    return null;
  }
}
