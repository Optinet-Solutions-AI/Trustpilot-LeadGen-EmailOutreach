'use client';

import { useEffect, useState } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCampaignProgress } from '../hooks/useCampaignProgress';
import CampaignBuilder from '../components/CampaignBuilder';
import {
  Send, ImageIcon, RefreshCw, Loader2, CheckCircle, Plus, X,
  FlaskConical, Zap, Trash2, StopCircle, AlertTriangle,
} from 'lucide-react';
import CampaignDetail from '../components/CampaignDetail';

export default function Campaigns() {
  const {
    campaigns, loading, fetchCampaigns, createCampaign, sendCampaign,
    cancelCampaign, deleteCampaign, getCampaignLeads, checkReplies, getRateLimit,
  } = useCampaigns();
  const { status: sendStatus, sent, failed, total, subscribe, reset } = useCampaignProgress();

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [detailCampaign, setDetailCampaign] = useState<typeof campaigns[0] | null>(null);

  // Send mode: 'test' = safe, redirect to test email | 'live' = real sends
  const [sendMode, setSendMode] = useState<'test' | 'live'>('test');
  const [testEmail, setTestEmail] = useState('');

  const [checkingReplies, setCheckingReplies] = useState(false);
  const [repliesMsg, setRepliesMsg] = useState('');
  const [rateLimit, setRateLimit] = useState<{ hourlyRemaining: number; dailyRemaining: number; canSend: boolean } | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // Auto-reconnect SSE if a campaign is already sending (e.g. after page refresh)
  useEffect(() => {
    if (campaigns.length === 0) return;
    const sendingCampaign = campaigns.find((c) => c.status === 'sending');
    if (sendingCampaign && !activeCampaignId && sendStatus === 'idle') {
      setActiveCampaignId(sendingCampaign.id);
      subscribe(sendingCampaign.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns]);

  useEffect(() => {
    getRateLimit().then(setRateLimit).catch(() => {});
  }, [getRateLimit]);

  useEffect(() => {
    if (sendStatus === 'completed' || sendStatus === 'failed' || sendStatus === 'cancelled') {
      fetchCampaigns();
      setActiveCampaignId(null);
      getRateLimit().then(setRateLimit).catch(() => {});
      setCancelling(false);
    }
  }, [sendStatus, fetchCampaigns, getRateLimit]);

  const notify = (type: 'success' | 'error' | 'warning', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 6000);
  };

  const handleCreate = async (data: { name: string; templateSubject: string; templateBody: string; includeScreenshot: boolean; filterCountry?: string; filterCategory?: string }) => {
    const campaign = await createCampaign(data);
    notify('success', `Campaign "${campaign.name}" created.`);
    setShowBuilder(false);
    fetchCampaigns();
  };

  const handleSend = async (id: string, limit?: number) => {
    const isSingleTest = limit === 1;
    const modeLabel = sendMode === 'test' ? 'TEST MODE' : 'LIVE MODE';
    const emailNote = sendMode === 'test'
      ? (testEmail ? ` → ${testEmail}` : ' → configured test addresses')
      : ' → REAL prospect inboxes';
    const confirmMsg = isSingleTest
      ? `Send 1 test email in TEST MODE?\nEmail will go to: ${testEmail || 'configured test address'}`
      : `Send this campaign in ${modeLabel}?\nEmails will go to:${emailNote}`;
    if (!confirm(confirmMsg)) return;

    try {
      reset();
      setActiveCampaignId(id);
      subscribe(id);
      const result = await sendCampaign(id, {
        testMode: isSingleTest || sendMode === 'test',
        testEmail: (isSingleTest || sendMode === 'test') && testEmail ? testEmail : undefined,
        limit,
      });
      notify('success', result.message);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Send failed');
      setActiveCampaignId(null);
    }
  };

  const handleCancel = async () => {
    if (!activeCampaignId) return;
    if (!confirm('Stop the campaign? Emails already sent will not be recalled. The campaign will return to Draft status.')) return;
    setCancelling(true);
    try {
      await cancelCampaign(activeCampaignId);
      notify('warning', 'Cancel requested — will stop before next email.');
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Cancel failed');
      setCancelling(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete campaign "${name}"? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await deleteCampaign(id);
      notify('success', `Campaign "${name}" deleted.`);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteAll = async () => {
    if (!confirm(`Delete ALL ${campaigns.length} campaigns? This cannot be undone.`)) return;
    for (const c of campaigns) {
      try { await deleteCampaign(c.id); } catch { /* continue */ }
    }
    notify('success', 'All campaigns deleted.');
    fetchCampaigns();
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

  const notifColors = {
    success: 'bg-green-50 text-green-800 border-green-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  };

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
          {campaigns.length > 0 && !isSending && (
            <button onClick={handleDeleteAll}
              className="inline-flex items-center gap-1.5 border border-red-200 text-red-600 px-3 py-1.5 rounded-md text-sm hover:bg-red-50">
              <Trash2 size={13} /> Delete All
            </button>
          )}
          <button
            onClick={() => setShowBuilder((v) => !v)}
            className="inline-flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-md text-sm hover:bg-gray-700">
            {showBuilder ? <><X size={13} /> Cancel</> : <><Plus size={13} /> New Campaign</>}
          </button>
        </div>
      </div>

      {/* ── Notifications ── */}
      {notification && (
        <div className={`px-4 py-3 rounded-md text-sm font-medium border ${notifColors[notification.type]}`}>
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
            : 'LIVE — emails will be sent to REAL lead inboxes. Personal emails (@gmail/@yahoo) are auto-filtered.'}
        </p>
      </div>

      {/* ── Campaign List ── */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold">All Campaigns</h2>
          {loading && <Loader2 size={14} className="animate-spin text-gray-400" />}
        </div>

        {/* Active send progress */}
        {activeCampaignId && (isSending || sendStatus === 'cancelled') && (
          <div className={`mx-5 my-3 p-4 rounded-lg border ${
            sendStatus === 'cancelled'
              ? 'bg-yellow-50 border-yellow-100'
              : 'bg-blue-50 border-blue-100'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <div className={`flex items-center gap-2 text-sm font-medium ${sendStatus === 'cancelled' ? 'text-yellow-700' : 'text-blue-700'}`}>
                {isSending
                  ? <><Loader2 size={15} className="animate-spin" /> Sending campaign…</>
                  : <><AlertTriangle size={15} /> Cancelling…</>
                }
              </div>
              {isSending && (
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="inline-flex items-center gap-1.5 border border-red-300 text-red-600 bg-white px-3 py-1 rounded text-xs font-medium hover:bg-red-50 disabled:opacity-50">
                  <StopCircle size={13} />
                  {cancelling ? 'Stopping…' : 'Cancel Send'}
                </button>
              )}
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
            {isSending && (
              <p className="text-xs text-blue-500 mt-2">
                Emails are sent with 30–90s delays between each one (~{Math.round(total * 60 / 60)} min total).
                You can leave this page — sending continues in the background.
              </p>
            )}
          </div>
        )}

        {activeCampaignId && sendStatus === 'completed' && (
          <div className="mx-5 my-3 p-3 bg-green-50 border border-green-100 rounded-lg flex items-center gap-2 text-green-700 text-sm">
            <CheckCircle size={15} />
            Campaign sent: {sent} emails delivered{failed > 0 ? `, ${failed} failed` : ''}.
          </div>
        )}

        {activeCampaignId && sendStatus === 'cancelled' && !isSending && (
          <div className="mx-5 my-3 p-3 bg-yellow-50 border border-yellow-100 rounded-lg flex items-center gap-2 text-yellow-700 text-sm">
            <StopCircle size={15} />
            Cancelled — {sent} emails were sent before stopping. Campaign returned to Draft.
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
                <th className="w-36 px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const hasLeads = (c.lead_count ?? 0) > 0;
                const canSend = c.status === 'draft' && hasLeads;
                const isThisSending = c.status === 'sending';
                return (
                <tr key={c.id} className="border-b hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium">
                    <button
                      onClick={() => setDetailCampaign(c)}
                      className="flex items-center gap-1.5 text-left hover:text-blue-600 transition-colors">
                      {c.name}
                      {c.include_screenshot && (
                        <span title="Includes screenshot"><ImageIcon size={12} className="text-blue-400" /></span>
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      isThisSending        ? 'bg-blue-100 text-blue-700' :
                      c.status === 'sent'      ? 'bg-green-100 text-green-700' :
                      c.status === 'completed' ? 'bg-purple-100 text-purple-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {isThisSending && <Loader2 size={10} className="animate-spin mr-1" />}
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
                    <div className="flex items-center justify-end gap-1">
                      {c.status === 'draft' && (
                        canSend ? (
                          <>
                            <button
                              onClick={() => handleSend(c.id, 1)}
                              disabled={isSending}
                              title="Send only 1 email to your test address to verify it works"
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-yellow-400 text-yellow-700 bg-yellow-50 hover:bg-yellow-100 disabled:opacity-40">
                              <FlaskConical size={9} /> 1 Test
                            </button>
                            <button
                              onClick={() => handleSend(c.id)}
                              disabled={isSending}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium disabled:opacity-40 ${
                                sendMode === 'test'
                                  ? 'bg-yellow-500 text-white hover:bg-yellow-600'
                                  : 'bg-red-600 text-white hover:bg-red-700'
                              }`}>
                              {sendMode === 'test' ? <FlaskConical size={10} /> : <Send size={10} />}
                              {sendMode === 'test' ? 'Test All' : 'Send Live'}
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-red-400 italic">No leads</span>
                        )
                      )}
                      {isThisSending && (
                        <span className="text-xs text-blue-500 flex items-center gap-1">
                          <Loader2 size={10} className="animate-spin" /> Sending…
                        </span>
                      )}
                      {(c.status === 'sent' || c.status === 'completed') && (
                        <span className="text-xs text-green-600 flex items-center gap-1">
                          <CheckCircle size={10} /> Done
                        </span>
                      )}
                      {/* Delete button — not available while this campaign is sending */}
                      {!isThisSending && (
                        <button
                          onClick={() => handleDelete(c.id, c.name)}
                          disabled={deletingId === c.id}
                          title="Delete campaign"
                          className="ml-1 p-1 text-gray-300 hover:text-red-500 rounded transition-colors disabled:opacity-40">
                          {deletingId === c.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {detailCampaign && (
        <CampaignDetail
          campaign={detailCampaign}
          onClose={() => setDetailCampaign(null)}
          fetchLeads={getCampaignLeads}
        />
      )}
    </div>
  );
}
