'use client';

import { useState } from 'react';
import { X, Send, Plus, ImageIcon, TestTube, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCampaignProgress } from '../hooks/useCampaignProgress';
import type { Lead } from '../types/lead';

const TOKENS = ['{{company_name}}', '{{website_url}}', '{{star_rating}}', '{{review_count}}', '{{category}}', '{{country}}'];

const DEFAULT_SUBJECT = 'Your Trustpilot rating needs attention, {{company_name}}';
const DEFAULT_BODY = `<p>Hi,</p>

<p>We recently noticed your brand's Trustpilot score isn't where it should be. Our team can help you improve your Trustpilot score by boosting positive visibility and enhancing your brand's credibility.</p>

<p><strong>{{company_name}}</strong><br>
Reviews: {{review_count}}<br>
Rating: {{star_rating}}</p>

<p>Would you be open to a quick chat to see how we can strengthen your online reputation?</p>

<p>Best regards,<br>OptiRate Solutions</p>`;

interface Props {
  leadIds: string[];
  leads?: Lead[];
  onClose: () => void;
  onDone?: () => void;
}

export default function QuickSendModal({ leadIds, leads = [], onClose, onDone }: Props) {
  const { createCampaign, sendCampaign } = useCampaigns();
  const { progress, status, sent, failed, total, subscribe, reset } = useCampaignProgress();

  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [campaignName] = useState(() => {
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return leads.length === 1
      ? `Quick Send — ${leads[0].company_name} — ${date}`
      : `Quick Send (${leadIds.length}) — ${date}`;
  });

  const [step, setStep] = useState<'compose' | 'sending' | 'done'>('compose');
  const [error, setError] = useState('');

  const insertToken = (token: string, field: 'subject' | 'body') => {
    if (field === 'subject') setSubject((p) => p + token);
    else setBody((p) => p + token);
  };

  const handleSend = async () => {
    if (!subject || !body) return;
    setError('');
    setStep('sending');

    try {
      // Step 1: Create campaign with selected leads
      const campaign = await createCampaign({
        name: campaignName,
        templateSubject: subject,
        templateBody: body,
        includeScreenshot,
        leadIds,
      });

      // Step 2: Subscribe to SSE progress before firing send
      subscribe(campaign.id);

      // Step 3: Trigger send (fire-and-forget on backend)
      await sendCampaign(campaign.id, { testMode });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
      setStep('compose');
    }
  };

  // Transition to 'done' when SSE completes
  if (step === 'sending' && (status === 'completed' || status === 'failed')) {
    setStep('done');
  }

  const handleClose = () => {
    reset();
    if (step === 'done' && onDone) onDone();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">Send Email</h2>
            <p className="text-sm text-gray-500">
              {leadIds.length === 1 && leads[0]
                ? `To: ${leads[0].company_name} (${leads[0].primary_email})`
                : `To: ${leadIds.length} selected leads`}
            </p>
          </div>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        {/* Compose step */}
        {step === 'compose' && (
          <div className="p-6 space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-md">
                {error}
              </div>
            )}

            {/* Subject */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
              <div className="flex gap-1 mb-1 flex-wrap">
                {TOKENS.map((t) => (
                  <button key={t} type="button" onClick={() => insertToken(t, 'subject')}
                    className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded">
                    <Plus size={10} className="inline" /> {t}
                  </button>
                ))}
              </div>
              <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm" />
            </div>

            {/* Body */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Body (HTML)</label>
              <div className="flex gap-1 mb-1 flex-wrap">
                {TOKENS.map((t) => (
                  <button key={t} type="button" onClick={() => insertToken(t, 'body')}
                    className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded">
                    <Plus size={10} className="inline" /> {t}
                  </button>
                ))}
              </div>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono text-xs" />
            </div>

            {/* Options */}
            <div className="flex flex-col gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={includeScreenshot} onChange={(e) => setIncludeScreenshot(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600" />
                <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <ImageIcon size={15} className="text-blue-500" />
                  Include Trustpilot Profile Screenshot
                </span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-yellow-500" />
                <span className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <TestTube size={15} className="text-yellow-500" />
                  Test Mode
                  <span className="text-xs text-gray-400 font-normal">(redirects to TEST_EMAIL_ADDRESS)</span>
                </span>
              </label>
            </div>

            {testMode && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs px-4 py-3 rounded-md">
                <strong>Test Mode ON</strong> — All emails will be sent to your TEST_EMAIL_ADDRESS instead of leads.
                Subjects will be prefixed with [TEST].
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handleSend} disabled={!subject || !body}
                className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                <Send size={15} />
                Send to {leadIds.length} lead{leadIds.length !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {/* Sending progress step */}
        {step === 'sending' && (
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-3 text-blue-600">
              <Loader2 size={20} className="animate-spin" />
              <span className="font-medium">Sending emails with rate limiting...</span>
            </div>

            {total > 0 && (
              <div>
                <div className="flex justify-between text-sm text-gray-600 mb-1">
                  <span>{sent + failed} / {total} processed</span>
                  <span>{sent} sent, {failed} failed</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${Math.round(((sent + failed) / total) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="max-h-48 overflow-y-auto space-y-1">
              {progress.filter(p => p.stage === 'sent').slice(-10).map((p, i) => (
                <div key={i} className={`flex items-center gap-2 text-xs ${p.success ? 'text-green-700' : 'text-red-600'}`}>
                  {p.success
                    ? <CheckCircle size={12} />
                    : <AlertCircle size={12} />
                  }
                  <span>{p.to}</span>
                  {!p.success && p.error && <span className="text-gray-400">— {p.error}</span>}
                </div>
              ))}
            </div>

            <p className="text-xs text-gray-400">
              Emails are sent with 30-90 second delays between each send to protect domain reputation.
              You can close this window — sending continues in the background.
            </p>

            <button onClick={handleClose} className="w-full py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50">
              Close (sending continues in background)
            </button>
          </div>
        )}

        {/* Done step */}
        {step === 'done' && (
          <div className="p-6 space-y-4 text-center">
            {status === 'completed' ? (
              <>
                <CheckCircle size={48} className="text-green-500 mx-auto" />
                <h3 className="text-lg font-semibold text-gray-800">Campaign sent!</h3>
                <p className="text-gray-600">{sent} email{sent !== 1 ? 's' : ''} sent successfully{failed > 0 ? `, ${failed} failed` : ''}.</p>
              </>
            ) : (
              <>
                <AlertCircle size={48} className="text-red-500 mx-auto" />
                <h3 className="text-lg font-semibold text-gray-800">Send failed</h3>
                <p className="text-gray-600">{sent} sent before error. Check server logs for details.</p>
              </>
            )}
            <button onClick={handleClose}
              className="w-full py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-md font-medium">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
