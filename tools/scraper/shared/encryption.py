"""AES-256-GCM helpers for social_accounts.encrypted_cookies.

Format is byte-compatible with server/src/lib/encryption.ts so cookies
written by the Node server can be decrypted by Python scrapers and vice
versa:

    base64( nonce[12] || ciphertext || auth_tag[16] )

The 16-byte GCM auth tag is appended to the ciphertext implicitly by
``cryptography.hazmat.primitives.ciphers.aead.AESGCM``, so the Python
slicing only needs to peel off the leading 12-byte nonce.

Key source: hex-decoded ``CRM_ACCOUNT_ENCRYPTION_KEY`` env var (32 bytes
/ 256-bit). Generate once with::

    openssl rand -hex 32
"""
from __future__ import annotations

import base64
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_LEN = 12


def _get_key() -> bytes:
    hex_key = os.getenv('CRM_ACCOUNT_ENCRYPTION_KEY')
    if not hex_key or len(hex_key) != 64:
        raise EnvironmentError(
            'CRM_ACCOUNT_ENCRYPTION_KEY must be a 64-character hex string '
            '(32 bytes). Generate with: openssl rand -hex 32'
        )
    return bytes.fromhex(hex_key)


def encrypt_cookie(plaintext: str) -> str:
    """Encrypt a UTF-8 string and return the base64 payload."""
    key = _get_key()
    nonce = secrets.token_bytes(NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode('utf-8'), None)
    return base64.b64encode(nonce + ct).decode('ascii')


def decrypt_cookie(payload_b64: str) -> str:
    """Decrypt a base64 payload produced by encrypt_cookie or its TS twin."""
    key = _get_key()
    buf = base64.b64decode(payload_b64)
    if len(buf) < NONCE_LEN + 16:
        raise ValueError('decrypt_cookie: payload too short (min 28 bytes)')
    nonce, ct = buf[:NONCE_LEN], buf[NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ct, None).decode('utf-8')
