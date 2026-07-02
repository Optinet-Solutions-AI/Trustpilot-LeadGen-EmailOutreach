import { describe, it, expect } from 'vitest';
import { renderAndSpin } from './template-engine';

describe('renderAndSpin locale integration', () => {
  it('localises spelling for an AU lead', () => {
    const out = renderAndSpin('We optimize your online reputation.', { country: 'AU' });
    expect(out).toBe('We optimise your online reputation.');
  });

  it('resolves currency + signoff tokens by country', () => {
    expect(renderAndSpin('Prices in {{currency_code}} ({{currency_symbol}}). {{signoff}}', { country: 'NZ' }))
      .toBe('Prices in NZD (NZ$). Cheers');
    expect(renderAndSpin('Prices in {{currency_code}} ({{currency_symbol}}). {{signoff}}', { country: 'US' }))
      .toBe('Prices in USD ($). Best regards');
  });

  it('is a no-op (byte-identical) for a US lead — regression guard', () => {
    const tpl = 'We organize and optimize your color center for {{company_name}}.';
    const lead = { country: 'US', company_name: 'Acme' };
    expect(renderAndSpin(tpl, lead)).toBe('We organize and optimize your color center for Acme.');
  });

  it('localises after spintax resolves', () => {
    // Only one spintax option so the assertion is deterministic.
    const out = renderAndSpin('{We optimize|We optimize} your catalog.', { country: 'AU' });
    expect(out).toBe('We optimise your catalogue.');
  });
});
