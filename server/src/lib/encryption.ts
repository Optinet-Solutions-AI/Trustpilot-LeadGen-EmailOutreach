/**
 * AES-256-GCM helpers for at-rest secrets that the application reads back
 * itself — primarily social_accounts.encrypted_cookies. The Python scraper
 * side reads/writes the same format via tools/scraper/shared/encryption.py.
 *
 * Format: base64( nonce[12] || ciphertext || auth_tag[16] )
 * Key:    hex-decoded CRM_ACCOUNT_ENCRYPTION_KEY env var (32 bytes / 256-bit)
 *
 * Generate a key once with:  openssl rand -hex 32
 */
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.CRM_ACCOUNT_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'CRM_ACCOUNT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptCookie(plaintext: string): string {
  const key = getKey();
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]).toString('base64');
}

export function decryptCookie(payloadB64: string): string {
  const key = getKey();
  const buf = Buffer.from(payloadB64, 'base64');
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error('decryptCookie: payload too short (min 28 bytes)');
  }
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
