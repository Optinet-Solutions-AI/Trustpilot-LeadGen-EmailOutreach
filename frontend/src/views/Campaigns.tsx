'use client';

import { useEffect, useState } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCampaignProgress } from '../hooks/useCampaignProgress';
import CampaignBuilder from '../components/CampaignBuilder';
import { Send, ImageIcon, TestTube, RefreshCw, Loader2, CheckCircle } from 'lucide-react';

export default function Campaigns() {
  const { campaigns, loading, fetchCampaigns, createCampaign, sendCampaign, checkReplies, getRateLimit } = useCampaigns();
  const { progress, status: sendStatus, sent, failed, total, subscribe, reset } = useCampaignProgress();

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [checkingReplies, setCheckingReplies] = useState(false);
  const [repliesMsg, setRepliesMsg] = useState('');
  const [rateLimit, setRateLimit] = useState<{ hourlyRemaining: number; dailyRemaining: number; canSend: boolean } | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // Fetch rate limit status on mount
  useEffect(() => {
    getRateLimit().then(setRateLimit).catch(() => {});
  }, [getRateLimit]);

  // Refresh campaign list and reset progress when send completes
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
    notify('success', `Campaign "${campaign.name}" created with ${campaign.total_sent ?? 0} leads.`);
    fetchCampaigns();
  };

  const handleSend = async (id: string) => {
    if (!confirm(`Send this campaign${testMode ? ' in TEST MODE' : ''}? Emails will be sent with 30-90s delays.`)) return;

    try {
      reset();
      setActiveCampaignId(id);
      subscribe(id);
      const result = await sendCampaign(id, { testMode });
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

  const sendingCampaignId = activeCampaignId;
  const isSending = sendStatus === 'sending' || sendStatus === 'connecting';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Campaigns</h1>

        <div className="flex items-center gap-3">
          {/* Rate limit indicator */}
          {rateLimit && (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-1.5">
              Rate: {rateLimit.hourlyRemaining}/hr · {rateLimit.dailyRemaining}/day remaining
            </div>
          )}

          {/* Check replies button */}
          <button onClick={handleCheckReplies} disabled={checkingReplies}
            className="inline-flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={13} className={checkingReplies ? 'animate-spin' : ''} />
            Check Replies
          </button>
        </div>
      </div>

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

      <CampaignBuilder onSubmit={handleCreate} />

      {/* Campaign List */}
      {campaigns.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">All Campaigns</h2>

            {/* Test Mode toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-yellow-500" />
              <span className="flex items-center gap-1.5 text-sm text-gray-600">
                <TestTube size={14} className={testMode ? 'text-yellow-500' : 'text-gray-400'} />
                Test Mode
              </span>
            </label>
          </div>

          {testMode && (
            <div className="mb-3 text-xs bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-2 rounded-md">
              <strong>Test Mode ON</strong> — All sends will be redirected to TEST_EMAIL_ADDRESS. Subjects will be prefixed with [TEST].
            </div>
          )}

          {/* Active campaign progress */}
          {sendingCampaignId && isSending && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-100 rounded-lg">
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

          {sendingCampaignId && sendStatus === 'completed' && (
            <div className="mb-4 p-3 bg-green-50 border border-green-100 rounded-lg flex items-center gap-2 text-green-700 text-sm">
              <CheckCircle size={15} />
              Campaign sent: {sent} emails delivered{failed > 0 ? `, ${failed} failed` : ''}.
            </div>
          )}

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2">Name</th>
                <th className="text-left py-2">Status</th>
                <th className="text-right py-2">Sent</th>
                <th className="text-right py-2">Replied</th>
                <th className="text-right py-2">Bounced</th>
                <th className="text-right py-2">Date</th>
                <th className="w-28 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="py-2 font-medium">
                    <span className="flex items-center gap-1.5">
                      {c.name}
                      {c.include_screenshot && (
                        <span title="Includes screenshot"><ImageIcon size={13} className="text-blue-400" /></span>
                      )}
                    </span>
                  </td>
                  <td className="py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      c.status === 'sending' ? 'bg-blue-100 text-blue-700' :
                      c.status === 'sent' ? 'bg-green-100 text-green-700' :
                      c.status === 'completed' ? 'bg-purple-100 text-purple-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {c.status === 'sending' && <Loader2 size={10} className="animate-spin mr-1" />}
                      {c.status}
                    </span>
                  </td>
                  <td className="text-right py-2">{c.total_sent}</td>
                  <td className="text-right py-2 text-green-600">{c.total_replied}</td>
                  <td className="text-right py-2 text-red-600">{c.total_bounced}</td>
                  <td className="text-right py-2 text-gray-500">
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2 text-right">
                    {c.status === 'draft' && (
                      <button onClick={() => handleSend(c.id)} disabled={isSending && sendingCampaignId === c.id}
                        className="inline-flex items-center gap-1 bg-green-600 text-white px-2 py-1 rounded text-xs hover:bg-green-700 disabled:opacity-50">
                        {testMode ? <TestTube size={10} /> : <Send size={10} />}
                        {testMode ? 'Test Send' : 'Send'}
                      </button>
                    )}
                    {c.status === 'sending' && c.id === sendingCampaignId && (
                      <span className="text-xs text-blue-500 flex items-center gap-1">
                        <Loader2 size={10} className="animate-spin" /> Sending…
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {loading && <p className="text-sm text-gray-400 text-center py-2">Loading...</p>}
        </div>
      )}
    </div>
  );
}
