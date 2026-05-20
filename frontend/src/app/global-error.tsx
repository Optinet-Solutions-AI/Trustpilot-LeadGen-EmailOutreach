'use client';

import { useEffect } from 'react';

/**
 * Global error boundary — Next.js App Router calls this when an uncaught
 * error happens at the root. We use it specifically to recover from
 * `ChunkLoadError`, which fires when Vercel rotates the static chunks
 * (new deploy) while a user has the page open: the browser tries to
 * lazy-load a chunk hash that no longer exists at that URL and the app
 * crashes into a white screen. Forcing a full reload pulls the new
 * manifest + new chunk hashes and the app comes back clean.
 *
 * Must own <html>/<body> because Next.js unmounts the entire app tree
 * before rendering this. Keep the markup minimal so it never depends
 * on chunks that might also be missing.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Match both the Webpack-thrown `ChunkLoadError` and the message it
    // produces in production builds. Either condition triggers a hard
    // reload — bypasses the bfcache so the new HTML pulls the new chunks.
    const msg = error?.message ?? '';
    const name = error?.name ?? '';
    if (name === 'ChunkLoadError' || msg.includes('Loading chunk') || msg.includes('ChunkLoadError')) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          background: '#f8fafc',
          color: '#1f2937',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
          padding: '32px',
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: '#b0004a' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.5, marginBottom: 16 }}>
            The page hit an unexpected error. Reloading usually fixes it — this
            often happens right after a new deploy is rolled out.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 18px',
              border: 0,
              borderRadius: 8,
              background: '#b0004a',
              color: 'white',
              fontWeight: 700,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reload page
          </button>
          {error?.digest && (
            <p style={{ marginTop: 16, fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
              ref: {error.digest}
            </p>
          )}
          {/* Reset isn't safe for ChunkLoadError (the same chunk is still
              missing); we expose it for non-chunk errors so the user has a
              soft-recovery option that doesn't blow away in-page state. */}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 12,
              padding: '6px 12px',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              background: 'transparent',
              color: '#475569',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Try without reload
          </button>
        </div>
      </body>
    </html>
  );
}
