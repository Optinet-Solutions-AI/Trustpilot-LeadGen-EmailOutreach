/**
 * Email platform adapter factory.
 * Returns the correct adapter based on EMAIL_PLATFORM env var.
 * Singleton — one adapter instance per server lifetime.
 */

import { config } from '../../config.js';
import type { EmailPlatformAdapter } from './types.js';

let _adapter: EmailPlatformAdapter | null = null;

export function getEmailPlatform(): EmailPlatformAdapter {
  if (_adapter) return _adapter;

  switch (config.emailPlatform) {
    case 'instantly': {
      // Dynamic import avoids loading Instantly deps when not needed
      const { InstantlyAdapter } = require('./adapter-instantly.js');
      _adapter = new InstantlyAdapter({
        apiKey: config.instantly.apiKey,
        sendingAccounts: config.instantly.sendingAccounts,
      });
      break;
    }
    case 'mock': {
      const { MockPlatformAdapter } = require('./adapter-mock.js');
      _adapter = new MockPlatformAdapter();
      break;
    }
    default:
      throw new Error(
        `Unknown EMAIL_PLATFORM: "${config.emailPlatform}". ` +
        `Valid values: none, mock, instantly`
      );
  }

  console.log(`[EmailPlatform] Using adapter: ${_adapter!.name}`);
  return _adapter!;
}

/** Returns true if a third-party email platform is configured */
export function isPlatformEnabled(): boolean {
  return config.emailPlatform !== 'none';
}
