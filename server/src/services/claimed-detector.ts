// Trustpilot "Profile claimed" detector. Runs inside Playwright via
// page.evaluate() — mirrors the JS block in tools/scraper/scrape_profile.py
// so a fresh scrape and a recheck job produce the same verdicts.
//
// Tri-state output:
//   true  — owner has claimed the profile
//   false — profile is not claimed
//   null  — couldn't determine; preserved by upsert callers so previous
//           true/false values aren't clobbered on a transient detection miss.
import type { Page } from 'playwright';

// Priority 1: __NEXT_DATA__ — Trustpilot ships the canonical
// businessUnit.isClaimed boolean in the page's Next.js data blob.
// This is authoritative, locale-independent, and survives UI variants
// (empty profile, has reviews, banned, "Claimed profile" vs "Profile claimed",
// etc.). Text matching is kept as a fallback in case Trustpilot ever
// restructures the blob.
const CLAIMED_DETECT_JS = `() => {
  let claimed = null;

  // Priority 1: __NEXT_DATA__ JSON
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (el && el.textContent) {
      const data = JSON.parse(el.textContent);
      const bu = data && data.props && data.props.pageProps && data.props.pageProps.businessUnit;
      if (bu && typeof bu.isClaimed === 'boolean') {
        claimed = bu.isClaimed;
      }
    }
  } catch (_e) { /* fall through to text-based fallbacks */ }

  // Priority 2: stable data attributes (legacy — kept in case Trustpilot
  // reintroduces them; currently absent from the rendered DOM).
  if (claimed === null) {
    const dataAttr = document.querySelector(
      '[data-business-unit-claimed], [data-testid*="claimed" i], [data-claimed]'
    );
    if (dataAttr) {
      const v = dataAttr.getAttribute('data-business-unit-claimed') ||
                dataAttr.getAttribute('data-claimed');
      claimed = v ? v.toLowerCase() !== 'false' : true;
    }
  }

  // Priority 3: localized "Claimed profile" / "Profile claimed" badge near
  // the company header (matches both word orders since Trustpilot uses
  // adjective+noun in EN).
  if (claimed === null) {
    const h1 = document.querySelector('h1');
    const header = h1 ? h1.closest('header, section, div') : null;
    const scopeText = (header || document.body).innerText || '';
    const RX = /\\b(claimed profile|profile claimed|profil beansprucht|beansprucht profil|geclaimd profiel|profil revendiqué|perfil reclamado|profilo verificato)\\b/i;
    if (RX.test(scopeText)) claimed = true;
  }

  // Priority 4: "Claim this profile" CTA OR "Unclaimed profile" status label.
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
