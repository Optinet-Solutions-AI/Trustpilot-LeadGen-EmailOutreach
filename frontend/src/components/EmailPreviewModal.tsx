'use client';

/**
 * Full rendered-email preview — what the recipient actually receives.
 *
 * The wizard's inline panels show the raw template: {{tokens}} unresolved,
 * every {a|b|c} spintax group still visible, HTML stripped and truncated. That
 * makes it impossible to check the real message without burning a test flight,
 * which is slow and only ever shows ONE lead's version.
 *
 * Rendering happens SERVER-side (POST /api/campaigns/preview) through the same
 * renderAndSpin the scheduler uses. A client-side re-implementation would drift
 * from the sender and start lying about what goes out.
 *
 * Foreign-language campaigns get a Translate toggle so an English-speaking
 * operator can sanity-check Italian or German copy. Translation is display-only
 * and never touches the saved template.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { EmailPreview } from '../types/campaign';
import { fetchEmailPreview } from '../lib/emailPreview';
import { translateText } from '../lib/translate';

export interface PreviewStep {
  /** Tab label, e.g. "Initial email" or "Follow-up #1". */
  label: string;
  subject: string;
  body: string;
}

export interface PreviewRecipient {
  id: string;
  /** Optional display name; the server also returns the resolved company. */
  label?: string;
}

interface Props {
  steps: PreviewStep[];
  includeScreenshot: boolean;
  /** Real leads to render against. Empty = server falls back to sample data. */
  recipients?: PreviewRecipient[];
  campaignId?: string;
  senderAccountId?: string;
  /** Campaign language, when known — drives the translate hint. */
  language?: string;
  onClose: () => void;
}

export default function EmailPreviewModal({
  steps, includeScreenshot, recipients = [], campaignId, senderAccountId, language,
  onClose,
}: Props) {
  const [stepIdx, setStepIdx]           = useState(0);
  const [recipientIdx, setRecipientIdx] = useState(0);
  const [preview, setPreview]           = useState<EmailPreview | null>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');

  // Translation is display-only state, cleared whenever the underlying email
  // changes so a stale translation can never be shown against a new variant.
  const [translated, setTranslated]         = useState<{ subject: string; html: string } | null>(null);
  const [translating, setTranslating]       = useState(false);
  const [translateError, setTranslateError] = useState('');
  const [showTranslated, setShowTranslated] = useState(false);

  // Guards against a slow response from a superseded request overwriting a
  // newer one (fast clicking between steps or recipients).
  const requestSeq = useRef(0);

  const step      = steps[stepIdx];
  const recipient = recipients[recipientIdx];

  const load = useCallback(async () => {
    if (!step) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    setTranslated(null);
    setShowTranslated(false);
    setTranslateError('');
    try {
      const data = await fetchEmailPreview({
        subject: step.subject,
        body: step.body,
        leadId: recipient?.id,
        campaignId: recipient ? undefined : campaignId,
        includeScreenshot,
        senderAccountId,
      });
      if (seq !== requestSeq.current) return;
      setPreview(data);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Could not render the preview.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [step, recipient, campaignId, includeScreenshot, senderAccountId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleTranslate = async () => {
    if (!preview) return;
    // Already fetched once — just flip back to it rather than paying for
    // another Gemini round-trip.
    if (translated) { setShowTranslated((v) => !v); return; }
    setTranslating(true);
    setTranslateError('');
    try {
      const [subjectRes, bodyRes] = await Promise.all([
        translateText(preview.subject, 'English'),
        translateText(preview.html, 'English'),
      ]);
      setTranslated({ subject: subjectRes.text.replace(/<br>/g, ' '), html: bodyRes.text });
      setShowTranslated(true);
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : 'Translation failed.');
    } finally {
      setTranslating(false);
    }
  };

  const shownSubject = showTranslated && translated ? translated.subject : preview?.subject ?? '';
  const shownHtml    = showTranslated && translated ? translated.html    : preview?.html    ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4">
      <div className="bg-surface-container-lowest rounded-t-2xl sm:rounded-2xl ambient-shadow w-full max-w-3xl border-t sm:border border-slate-100 max-h-[92vh] flex flex-col overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Email Preview
            </h2>
            <p className="text-xs text-secondary mt-0.5">
              Rendered by the same engine that sends. This is the real message.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container transition-colors"
            aria-label="Close preview"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* ── Controls ── */}
        <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2 flex-shrink-0">
          {/* Sequence step tabs — only when there IS a sequence */}
          {steps.length > 1 && (
            <div className="flex items-center gap-1 bg-surface-container rounded-lg p-0.5 overflow-x-auto">
              {steps.map((s, i) => (
                <button
                  key={s.label}
                  onClick={() => setStepIdx(i)}
                  className={`px-3 py-1 rounded-md text-xs font-bold whitespace-nowrap transition-all ${
                    i === stepIdx ? 'bg-white text-on-surface ambient-shadow' : 'text-secondary hover:text-on-surface'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* Recipient cycler */}
          {recipients.length > 0 && (
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setRecipientIdx((i) => (i - 1 + recipients.length) % recipients.length)}
                disabled={recipients.length < 2}
                className="p-1.5 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container disabled:opacity-30 transition-colors"
                aria-label="Previous recipient"
              >
                <span className="material-symbols-outlined text-[16px]">chevron_left</span>
              </button>
              <span className="text-[11px] font-bold text-secondary tabular-nums">
                Lead {recipientIdx + 1} / {recipients.length}
              </span>
              <button
                onClick={() => setRecipientIdx((i) => (i + 1) % recipients.length)}
                disabled={recipients.length < 2}
                className="p-1.5 text-secondary hover:text-on-surface rounded-lg hover:bg-surface-container disabled:opacity-30 transition-colors"
                aria-label="Next recipient"
              >
                <span className="material-symbols-outlined text-[16px]">chevron_right</span>
              </button>
            </div>
          )}

          <div className={`flex items-center gap-2 ${recipients.length > 0 ? '' : 'ml-auto'}`}>
            {/* Re-roll: spintax picks randomly per render, so this shows a
                genuinely different variant, which is what recipients get. */}
            <button
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-secondary hover:text-on-surface hover:bg-surface-container disabled:opacity-40 transition-colors"
              title="Spintax picks a random variant per send — see another one"
            >
              <span className="material-symbols-outlined text-[15px]">casino</span>
              Re-roll variant
            </button>

            <button
              onClick={handleTranslate}
              disabled={translating || loading || !preview}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
                showTranslated
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-secondary hover:text-on-surface hover:bg-surface-container'
              }`}
            >
              {translating
                ? <Loader2 size={13} className="animate-spin" />
                : <span className="material-symbols-outlined text-[15px]">translate</span>}
              {showTranslated ? 'Show original' : 'Translate to English'}
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-secondary text-sm font-semibold">
              <Loader2 size={16} className="animate-spin" /> Rendering the email…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 p-4 bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl text-sm text-[#b0004a]">
              <span className="material-symbols-outlined text-[18px]">error</span>
              <span className="font-semibold">{error}</span>
            </div>
          )}

          {!loading && !error && preview && (
            <>
              {/* Sample-data notice — the preview is honest about not having
                  a real lead, so token fallbacks aren't mistaken for bugs. */}
              {preview.isSample && (
                <div className="flex items-start gap-2 p-3 mb-3 bg-surface-container border border-slate-200 rounded-xl text-xs text-secondary">
                  <span className="material-symbols-outlined text-[16px]">info</span>
                  <span>
                    No lead selected, so this uses stand-in data (Acme Corp, 2.5 stars).
                    Pick recipients to see the real thing.
                  </span>
                </div>
              )}

              {preview.warnings.map((w) => (
                <div key={w} className="flex items-start gap-2 p-3 mb-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-800">
                  <span className="material-symbols-outlined text-[16px]">warning</span>
                  <span className="font-semibold">{w}</span>
                </div>
              ))}

              {showTranslated && (
                <div className="flex items-start gap-2 p-3 mb-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
                  <span className="material-symbols-outlined text-[16px]">translate</span>
                  <span>
                    Machine translation shown for checking only. The email still sends
                    in its original language{language ? ` (${language})` : ''}.
                  </span>
                </div>
              )}

              {translateError && (
                <div className="flex items-start gap-2 p-3 mb-3 bg-[#ffd9de] border border-[#b0004a]/20 rounded-xl text-xs text-[#b0004a] font-semibold">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  {translateError}
                </div>
              )}

              {/* Email-client chrome so the copy is judged in context */}
              <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                <div className="px-4 py-3 border-b border-slate-100 space-y-1.5">
                  <p className="text-base font-extrabold text-on-surface leading-snug" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    {shownSubject || <span className="text-slate-300 font-normal">No subject</span>}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-secondary flex-wrap">
                    <div className="w-6 h-6 rounded-full primary-gradient flex items-center justify-center flex-shrink-0 text-on-primary text-[10px] font-extrabold">
                      {(preview.fromName || 'O').charAt(0)}
                    </div>
                    <span className="font-bold text-on-surface">{preview.fromName}</span>
                    <span className="truncate">&lt;{preview.fromEmail}&gt;</span>
                  </div>
                  <p className="text-xs text-secondary">
                    to{' '}
                    {preview.to
                      ? <span className="font-semibold text-on-surface">{preview.to}</span>
                      : <span className="italic text-amber-700">this lead has no email address</span>}
                    {preview.companyName ? <span className="text-slate-400"> · {preview.companyName}</span> : null}
                  </p>
                </div>

                {/* The rendered message. Server output from our own template
                    engine, not third-party HTML. */}
                <div
                  className="px-4 py-4 text-sm text-on-surface leading-relaxed [&_p]:mb-3 [&_a]:text-blue-600 [&_a]:underline [&_img]:rounded-lg [&_img]:max-w-full"
                  dangerouslySetInnerHTML={{ __html: shownHtml || '<p class="text-slate-400">Nothing to preview yet.</p>' }}
                />
              </div>

              <p className="text-[11px] text-secondary mt-3 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[14px]">info</span>
                Spintax picks a fresh variant per send, so each recipient gets slightly different wording.
              </p>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl text-sm font-bold border border-slate-200 text-secondary hover:bg-surface-container transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
