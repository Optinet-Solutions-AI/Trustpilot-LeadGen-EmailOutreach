'use client';

import { useEffect, useState } from 'react';
import api from '../../api/client';

// Top-level route so Next.js exports it as oauth-callback.html (flat file).
// Subdirectory routes like oauth/callback.html are not served correctly
// by Vercel's @vercel/static-build clean-URL routing.
export default function OAuthCallbackPage() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Connecting your Gmail account…');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    const error  = params.get('error');

    function postAndClose(payload: Record<string, unknown>) {
      try { window.opener?.postMessage({ type: 'gmail-oauth', ...payload }, '*'); } catch {}
      setTimeout(() => window.close(), 2000);
    }

    if (error) {
      setStatus('error');
      setMessage(`Google denied access: ${error}`);
      postAndClose({ ok: false, message: `Google denied access: ${error}` });
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setMessage('Invalid callback — missing parameters.');
      postAndClose({ ok: false, message: 'Invalid callback — missing parameters.' });
      return;
    }

    const stored = localStorage.getItem(`oauth_state_${state}`);
    if (!stored) {
      setStatus('error');
      setMessage('Session expired — please close and try again.');
      postAndClose({ ok: false, message: 'OAuth session expired — please try again.' });
      return;
    }

    const { clientId, clientSecret } = JSON.parse(stored) as { clientId: string; clientSecret: string };
    localStorage.removeItem(`oauth_state_${state}`);

    const redirectUri = window.location.origin + '/oauth-callback';

    api.post('/email-accounts/oauth/exchange', { code, clientId, clientSecret, redirectUri })
      .then((res) => {
        const { refreshToken, email } = res.data.data as { refreshToken: string; email: string };
        setStatus('success');
        setMessage(`Connected as ${email} ✓`);
        postAndClose({ ok: true, refreshToken, email, message: `Connected as ${email}` });
      })
      .catch((err: unknown) => {
        const msg = (err instanceof Error ? err.message : String(err)) || 'Token exchange failed';
        setStatus('error');
        setMessage(msg);
        postAndClose({ ok: false, message: msg });
      });
  }, []);

  return (
    <div style={{
      fontFamily: 'sans-serif', display: 'flex', alignItems: 'center',
      justifyContent: 'center', height: '100vh', margin: 0, background: '#f8f9fa',
    }}>
      <div style={{
        textAlign: 'center', padding: 40, background: 'white',
        borderRadius: 16, boxShadow: '0 4px 24px rgba(0,0,0,.08)', maxWidth: 400, width: '100%',
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>
          {status === 'loading' ? '⏳' : status === 'success' ? '✅' : '❌'}
        </div>
        <p style={{
          fontSize: 15, fontWeight: 600, margin: '0 0 8px',
          color: status === 'success' ? '#006630' : status === 'error' ? '#b0004a' : '#333',
        }}>
          {message}
        </p>
        <p style={{ fontSize: 12, color: '#888', margin: 0 }}>This window will close automatically.</p>
      </div>
    </div>
  );
}
