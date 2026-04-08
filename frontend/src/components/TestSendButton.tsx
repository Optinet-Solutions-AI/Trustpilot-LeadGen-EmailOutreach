import { useState } from 'react';
import { FlaskConical, Send, Check, Loader2 } from 'lucide-react';

interface Props {
  onSend: (testEmail: string) => Promise<void>;
  disabled?: boolean;
}

export default function TestSendButton({ onSend, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(() => localStorage.getItem('testSendEmail') || '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSend = async () => {
    setSending(true);
    setError('');
    try {
      if (email) localStorage.setItem('testSendEmail', email);
      await onSend(email);
      setSent(true);
      setTimeout(() => { setSent(false); setOpen(false); }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-100 text-green-700">
        <Check size={12} /> Test Sent!
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled || sending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-yellow-400 text-yellow-700 bg-yellow-50 hover:bg-yellow-100 transition-colors disabled:opacity-40"
      >
        <FlaskConical size={12} /> Send 1 Test
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-20 bg-white rounded-xl shadow-lg border border-gray-200 p-3 w-72">
          <p className="text-xs text-gray-500 mb-2">Send 1 test email to verify your template:</p>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com (or leave blank for .env default)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs mb-2 focus:ring-2 focus:ring-yellow-400 focus:border-yellow-400"
            autoFocus
          />
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-700">
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={sending}
              className="inline-flex items-center gap-1 bg-yellow-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-yellow-600 disabled:opacity-50"
            >
              {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
              Send Test
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
