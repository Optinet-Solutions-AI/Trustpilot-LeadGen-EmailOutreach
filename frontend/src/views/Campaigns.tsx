'use client';

import { useEffect, useState } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCampaignProgress } from '../hooks/useCampaignProgress';
import CampaignCard from '../components/CampaignCard';
import CampaignDetail from '../components/CampaignDetail';
import CampaignWizard from '../components/campaign-wizard/CampaignWizard';
import TestFlightModal from '../components/TestFlightModal';
import {
  RefreshCw, Loader2, Plus, StopCircle, AlertTriangle, CheckCircle,
} from 'lucide-react';
import type { Campaign } from '../types/campaign';

export default function Campaigns() {
  const {
    campaigns, loading, fetchCampaigns, createCampaign, sendCampaign,
    cancelCampaign, deleteCampaign, getCampaignLeads, checkReplies,
    getRateLimit, duplicateCampaign, previewRecipients, testFlightSend,
  } = useCampaigns();
  const { status: sendStatus, sent, failed, total, subscribe, reset } = useCampaignProgress();

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [detailCampaign, setDetailCampaign] = useState<Campaign | null>(null);

  // Test Flight gate — mandatory before live send
  const [testFlightCampaignId, setTestFlightCampaignId] = useState<string | null>(null);
  const testFlightCampaign = campaigns.find((c) => c.id === testFlightCampaignId);

  const [checkingReplies, setCheckingReplies] = useState(false);
  const [repliesMsg, setRepliesMsg] = useState('');
  const [rateLimit, setRateLimit] = useState<{ hourlyRemaining: number; dailyRemaining: number; canSend: boolean } | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // Auto-reconnect SSE if a campaign is already sending
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

  const handleCreate = async (data: { name: string; templateSubject: string; templateBody: string; includeScreenshot: boolean; leadIds: string[] }) => {
    const campaign = await createCampaign(data);
    notify('success', `Campaign "${campaign.name}" created with ${data.leadIds.length} lead${data.leadIds.length !== 1 ? 's' : ''}.`);
    fetchCampaigns();
  };

  // Test Flight: send 1 authentic test email synchronously (backend validates & sends)
  const handleTestFlightSend = async (campaignId: string, testEmail: string) => {
    return testFlightSend(campaignId, testEmail);
  };

  // Live send — called only after the Test Flight gate is passed
  const handleLiveSend = async (campaignId: string) => {
    try {
      reset();
      setActiveCampaignId(campaignId);
      subscribe(campaignId);
      const result = await sendCampaign(campaignId, { testMode: false });
      notify('success', result.message);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Send failed');
      setActiveCampaignId(null);
    }
  };

  const handleCancel = async () => {
    if (!activeCampaignId) return;
    if (!confirm('Stop the campaign? Emails already sent will not be recalled.')) return;
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

  const handleDuplicate = async (campaignId: string) => {
    try {
      const newCampaign = await duplicateCampaign(campaignId);
      notify('success', `Campaign "${newCampaign.name}" created.`);
      fetchCampaigns();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Duplicate failed');
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

  const notifColors = {
    success: 'bg-green-50 text-green-800 border-green-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <div className="flex items-center gap-2">
          {rateLimit && (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5">
              {rateLimit.hourlyRemaining}/hr · {rateLimit.dailyRemaining}/day left
            </div>
          )}
          <button onClick={handleCheckReplies} disabled={checkingReplies}
            className="inline-flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors">
            <RefreshCw size={13} className={checkingReplies ? 'animate-spin' : ''} />
            Check Replies
          </button>
          <button
            onClick={() => setShowWizard(true)}
            className="inline-flex items-center gap-1.5 bg-gray-900 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors">
            <Plus size={14} /> New Campaign
          </button>
        </div>
      </div>

      {/* Notifications */}
      {notification && (
        <div className={`px-4 py-3 rounded-lg text-sm font-medium border ${notifColors[notification.type]}`}>
          {notification.message}
        </div>
      )}
      {repliesMsg && (
        <div className="px-4 py-3 rounded-lg text-sm bg-blue-50 text-blue-800 border border-blue-200">
          {repliesMsg}
        </div>
      )}

      {/* Active send progress banner */}
      {activeCampaignId && isSending && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
              <Loader2 size={15} className="animate-spin" /> Sending campaign...
            </div>
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 border border-red-300 text-red-600 bg-white px-3 py-1 rounded-lg text-xs font-medium hover:bg-red-50 disabled:opacity-50 transition-colors">
              <StopCircle size={13} />
              {cancelling ? 'Stopping...' : 'Cancel Send'}
            </button>
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
            Emails sent with 30-90s delays. You can leave this page — sending continues in background.
          </p>
        </div>
      )}

      {activeCampaignId && sendStatus === 'completed' && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-xl flex items-center gap-2 text-green-700 text-sm">
          <CheckCircle size={15} />
          Campaign sent: {sent} emails delivered{failed > 0 ? `, ${failed} failed` : ''}.
        </div>
      )}

      {activeCampaignId && sendStatus === 'cancelled' && !isSending && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-xl flex items-center gap-2 text-yellow-700 text-sm">
          <AlertTriangle size={15} />
          Cancelled — {sent} emails were sent before stopping.
        </div>
      )}

      {/* Campaign list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-800">All Campaigns</h2>
          {loading && <Loader2 size={14} className="animate-spin text-gray-400" />}
        </div>

        {campaigns.length === 0 && !loading ? (
          <div className="bg-white rounded-xl border border-gray-200 py-16 text-center">
            <p className="text-gray-400 text-sm mb-3">No campaigns yet.</p>
            <button onClick={() => setShowWizard(true)}
              className="inline-flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors">
              <Plus size={14} /> Create your first campaign
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            {campaigns.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                isSending={isSending}
                sendProgress={
                  activeCampaignId === c.id && total > 0
                    ? { sent, failed, total }
                    : null
                }
                onLaunch={(id) => setTestFlightCampaignId(id)}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onViewDetail={setDetailCampaign}
                deletingId={deletingId}
              />
            ))}
          </div>
        )}
      </div>

      {/* Wizard modal */}
      {showWizard && (
        <CampaignWizard
          onClose={() => setShowWizard(false)}
          onCreate={handleCreate}
        />
      )}

      {/* Campaign detail modal */}
      {detailCampaign && (
        <CampaignDetail
          campaign={detailCampaign}
          onClose={() => setDetailCampaign(null)}
          fetchLeads={getCampaignLeads}
          onDuplicate={handleDuplicate}
        />
      )}

      {/* Mandatory Test Flight gate — must pass before live send is unlocked */}
      {testFlightCampaignId && testFlightCampaign && (
        <TestFlightModal
          campaignName={testFlightCampaign.name}
          recipientCount={testFlightCampaign.lead_count ?? 0}
          onTestFlightSend={(email) => handleTestFlightSend(testFlightCampaignId, email)}
          onProceedLive={() => handleLiveSend(testFlightCampaignId)}
          onClose={() => setTestFlightCampaignId(null)}
        />
      )}
    </div>
  );
}
