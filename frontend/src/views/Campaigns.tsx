'use client';

import { useEffect, useState } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCampaignProgress } from '../hooks/useCampaignProgress';
import CampaignBuilder from '../components/CampaignBuilder';
import {
  Send, ImageIcon, RefreshCw, Loader2, CheckCircle, Plus, X,
  FlaskConical, Zap, ChevronDown, ChevronUp,
} from 'lucide-react';

export default function Campaigns() {
  const { campaigns, loading, fetchCampaigns, createCampaign, sendCampaign, checkReplies, getRateLimit } = useCampaigns();
  const { status: sendStatus, sent, failed, total, subscribe, reset } = useCampaignProgress();

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);

  // Send mode: 'test' = safe, redirect to test email | 'live' = real sends
  const [sendMode, setSendMode] = useState<'test' | 'live'>('test');
  const [testEmail, setTestEmail] = useState('');

  const [checkingReplies, setCheckingReplies] = useState(false);
  const [repliesMsg, setRepliesMsg] = useState('');
  const [rateLimit, setRateLimit] = useState<{ hourlyRemaining: number; dailyRemaining: number; canSend: boolean } | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  useEffect(() => {
    getRateLimit().then(setRateLimit).catch(() => {});
  }, [getRateLimit]);

  useEffect(() => {
    if (sendStatus === 'completed' || sendStatus === 'failed') {
      fetchCampaigns();
      setActiveCampaignId(null);
      getRateLimit().then(setRateLimit).catch(() => {});
    }
  }, [sendStatus, fetchCampaigns, getRateLimit]);

  const notify = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const handleCreate = async (data: { name: string; templateSubject: string; templateBody: string; includeScreenshot: boolean; filterCountry?: string; filterCategory?: string }) => {
    const campaign = await createCampaign(data);
    notify('success', `Campaign "${campaign.name}" created.`);
    setShowBuilder(false);
    fetchCampaigns();
  };

  const handleSend = async (id: string) => {
    const modeLabel = sendMode === 'test' ? 'TEST MODE' : 'LIVE MODE';
    const emailNote = sendMode === 'test'
      ? (testEmail ? ` → ${testEmail}` : ' → configured test addresses')
      : ' → REAL prospect inboxes';
    if (!confirm(`Send this campaign in ${modeLabel}?\nEmails will go to:${emailNote}`)) return;

    try {
      reset();
      setActiveCampaignId(id);
      subscribe(id);
      const result = await sendCampaign(id, {
        testMode: sendMode === 'test',
        testEmail: sendMode === 'test' && testEmail ? testEmail : undefined,
      });
      notify('success', result.message);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Send failed');
      setActiveCampaignId(null);
    }
  };

  const handleCheckReplies = async () => {
    setCheckingReplies(true);
    setRepliesMsg('');
    try {
      const result = await checkReplies();
      setRepliesMsg(result.repliesFound > 0
        ? `Found ${result.repliesFound} new replies — lead statuses updated.`
        : 'No new replies found.');
      if (result.repliesFound > 0) fetchCampaigns();
    } catch (e) {
      setRepliesMsg(e instanceof Error ? e.message : 'Reply check failed');
    } finally {
      setCheckingReplies(false);
    }
  };

  const isSending = sendStatus === 'sending' || sendStatus === 'connecting';

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <div className="flex items-center gap-2">
          {rateLimit && (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-1.5">
              {rateLimit.hourlyRemaining}/hr · {rateLimit.dailyRemaining}/day left
            </div>
          )}
          <button onClick={handleCheckReplies} disabled={checkingReplies}
            className="inline-flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={13} className={checkingReplies ? 'animate-spin' : ''} />
            Check Replies
          </button>
          <button
            onClick={() => setShowBuilder((v) => !v)}
            className="inline-flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-md text-sm hover:bg-gray-700">
            {showBuilder ? <><X size={13} /> Cancel</> : <><Plus size={13} /> New Campaign</>}
          </button>
        </div>
      </div>

      {/* ── Notifications ── */}
      {notification && (
        <div className={`px-4 py-3 rounded-md text-sm font-medium ${
          notification.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'
        }`}>
          {notification.message}
        </div>
      )}
      {repliesMsg && (
        <div className="px-4 py-3 rounded-md text-sm bg-blue-50 text-blue-800 border border-blue-200">
          {repliesMsg}
        </div>
      )}

      {/* ── Campaign Builder (collapsible) ── */}
      {showBuilder && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <CampaignBuilder onSubmit={handleCreate} />
        </div>
      )}

      {/* ── Send Mode Panel ── */}
      <div className={`rounded-lg border p-4 ${sendMode === 'test' ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-gray-700">Send Mode</span>

          {/* Toggle pill */}
          <div className="flex rounded-lg border overflow-hidden text-sm font-medium">
            <button
              onClick={() => setSendMode('test')}
              className={`flex items-center gap-1.5 px-4 py-1.5 transition-colors ${
                sendMode === 'test'
                  ? 'bg-yellow-400 text-yellow-900'
                  : 'bg-white text-gray-500 hover:bg-gray-50'
              }`}>
              <FlaskConical size={13} />
              Test
            </button>
            <button
              onClick={() => setSendMode('live')}
              className={`flex items-center gap-1.5 px-4 py-1.5 transition-colors ${
                sendMode === 'live'
                  ? 'bg-red-500 text-white'
                  : 'bg-white text-gray-500 hover:bg-gray-50'
              }`}>
              <Zap size={13} />
              Live
            </button>
          </div>

          {/* Test email input */}
          {sendMode === 'test' && (
            <div className="flex items-center gap-2 flex-1 min-w-[260px]">
              <label className="text-xs font-medium text-yellow-700 whitespace-nowrap">Send test to:</label>
              <input
                type="text"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="your@email.com  (leave blank to use .env defaults)"
                className="flex-1 border border-yellow-300 rounded-md px-3 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-yellow-400"
              />
            </div>
          )}
        </div>

        <p className={`text-xs mt-2 ${sendMode === 'test' ? 'text-yellow-700' : 'text-red-700 font-semibold'}`}>
          {sendMode === 'test'
            ? `Safe — emails redirect to ${testEmail || 'TEST_EMAIL_ADDRESS in .env'} instead of real prospects.`
            : 'LIVE — emails will be sent to REAL lead inboxes. Only use when ready.'}
        </p>
      </div>

      {/* ── Campaign List ── */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold">All Campaigns</h2>
          {loading && <Loader2 size={14} className="animate-spin text-gray-400" />}
        </div>

        {/* Active send progress */}
        {activeCampaignId && isSending && (
          <div className="mx-5 my-3 p-4 bg-blue-50 border border-blue-100 rounded-lg">
            <div className="flex items-center gap-2 text-blue-700 mb-2">
              <Loader2 size={15} className="animate-spin" />
              <span className="text-sm font-medium">Sending campaign…</span>
            </div>
            {total > 0 && (
              <div>
                <div className="flex justify-between text-xs text-blue-600 mb-1">
                  <span>{sent + failed} / {total} processed</span>
                  <span>{sent} sent{failed > 0 ? `, ${failed} failed` : ''}</span>
                </div>
                <div className="w-full bg-blue-200 rounded-full h-1.5">
                  <div className="bg-blue-600 h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.round(((sent + failed) / total) * 100)}%` }} />
                </div>
              </div>
            )}
            <p className="text-xs text-blue-500 mt-2">
              Emails are sent with 30–90s delays. You can leave this page — sending continues in the background.
            </p>
          </div>
        )}

        {activeCampaignId && sendStatus === 'completed' && (
          <div className="mx-5 my-3 p-3 bg-green-50 border border-green-100 rounded-lg flex items-center gap-2 text-green-700 text-sm">
            <CheckCircle size={15} />
            Campaign sent: {sent} emails delivered{failed > 0 ? `, ${failed} failed` : ''}.
          </div>
        )}

        {campaigns.length === 0 && !loading ? (
          <div className="py-12 text-center">
            <p className="text-gray-400 text-sm">No campaigns yet.</p>
            <button onClick={() => setShowBuilder(true)}
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-3 py-1.5 rounded-md hover:bg-gray-50">
              <Plus size={13} /> Create your first campaign
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-5 py-2.5 font-medium text-gray-600">Name</th>
                <th className="text-left px-3 py-2.5 font-medium text-gray-600">Status</th>
                <th className="text-right px-3 py-2.5 font-medium text-gray-600">Leads</th>
                <th className="text-right px-3 py-2.5 font-medium text-gray-600">Sent</th>
                <th className="text-right px-3 py-2.5 font-medium text-gray-600">Replied</th>
                <th className="text-right px-3 py-2.5 font-medium text-gray-600">Bounced</th>
                <th className="text-right px-3 py-2.5 font-medium text-gray-600">Date</th>
                <th className="w-32 px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const hasLeads = (c.lead_count ?? 0) > 0;
                const canSend = c.status === 'draft' && hasLeads;
                return (
                <tr key={c.id} className="border-b hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium">
                    <span className="flex items-center gap-1.5">
                      {c.name}
                      {c.include_screenshot && (
                        <span title="Includes screenshot"><ImageIcon size={12} className="text-blue-400" /></span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      c.status === 'sending'   ? 'bg-blue-100 text-blue-700' :
                      c.status === 'sent'      ? 'bg-green-100 text-green-700' :
                      c.status === 'completed' ? 'bg-purple-100 text-purple-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {c.status === 'sending' && <Loader2 size={10} className="animate-spin mr-1" />}
                      {c.status}
                    </span>
                  </td>
                  <td className="text-right px-3 py-3">
                    <span className={`text-xs font-medium ${hasLeads ? 'text-gray-700' : 'text-red-500'}`}>
                      {c.lead_count ?? 0}
                      {!hasLeads && c.status === 'draft' && (
                        <span className="ml-1 text-red-400" title="No leads — campaign cannot be sent">⚠</span>
                      )}
                    </span>
                  </td>
                  <td className="text-right px-3 py-3">{c.total_sent}</td>
                  <td className="text-right px-3 py-3 text-green-600">{c.total_replied}</td>
                  <td className="text-right px-3 py-3 text-red-600">{c.total_bounced}</td>
                  <td className="text-right px-3 py-3 text-gray-500">
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {c.status === 'draft' && (
                      canSend ? (
                        <button onClick={() => handleSend(c.id)} disabled={isSending && activeCampaignId === c.id}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium disabled:opacity-50 ${
                            sendMode === 'test'
                              ? 'bg-yellow-500 text-white hover:bg-yellow-600'
                              : 'bg-red-600 text-white hover:bg-red-700'
                          }`}>
                          {sendMode === 'test' ? <FlaskConical size={10} /> : <Send size={10} />}
                          {sendMode === 'test' ? 'Test Send' : 'Send Live'}
                        </button>
                      ) : (
                        <span className="text-xs text-red-400 italic">No leads</span>
                      )
                    )}
                    {c.status === 'sending' && c.id === activeCampaignId && (
                      <span className="text-xs text-blue-500 flex items-center justify-end gap-1">
                        <Loader2 size={10} className="animate-spin" /> Sending…
                      </span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
