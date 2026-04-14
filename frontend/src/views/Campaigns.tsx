'use client';

import { useEffect, useState } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCampaignProgress } from '../hooks/useCampaignProgress';
import CampaignCard from '../components/CampaignCard';
import CampaignDetail from '../components/CampaignDetail';
import CampaignWizard from '../components/campaign-wizard/CampaignWizard';
import TestFlightModal from '../components/TestFlightModal';
import { Loader2 } from 'lucide-react';
import type { Campaign } from '../types/campaign';

export default function Campaigns() {
  const {
    campaigns, loading, fetchCampaigns, createCampaign, sendCampaign,
    cancelCampaign, deleteCampaign, getCampaignLeads, checkReplies,
    getRateLimit, duplicateCampaign, previewRecipients, testFlightSend,
    syncStats, getPlatformStatus, getCampaignSteps, getWarmupStatus,
  } = useCampaigns();
  const { status: sendStatus, sent, failed, total, subscribe, reset } = useCampaignProgress();

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [detailCampaign, setDetailCampaign] = useState<Campaign | null>(null);

  const [testFlightCampaignId, setTestFlightCampaignId] = useState<string | null>(null);
  const testFlightCampaign = campaigns.find((c) => c.id === testFlightCampaignId);
  const [testFlightLeadEmails, setTestFlightLeadEmails] = useState<string[]>([]);

  const [launchChoiceId, setLaunchChoiceId] = useState<string | null>(null);
  const launchChoiceCampaign = campaigns.find((c) => c.id === launchChoiceId);

  const [checkingReplies, setCheckingReplies] = useState(false);
  const [repliesMsg, setRepliesMsg] = useState('');
  const [rateLimit, setRateLimit] = useState<{ hourlyRemaining: number; dailyRemaining: number; dailyCap: number; canSend: boolean } | null>(null);
  const [warmupStatus, setWarmupStatus] = useState<{ day: number; currentCap: number; phase: string } | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [platformInfo, setPlatformInfo] = useState<{ enabled: boolean; platform: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);
  useEffect(() => { getPlatformStatus().then(setPlatformInfo).catch(() => {}); }, [getPlatformStatus]);

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
    getWarmupStatus().then(setWarmupStatus).catch(() => {});
  }, [getRateLimit, getWarmupStatus]);

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

  const handleCreate = async (data: { name: string; templateSubject: string; templateBody: string; includeScreenshot: boolean; leadIds: string[]; manualEmails?: string[]; followUpSteps?: Array<{ delayDays: number; subject: string; body: string }> }) => {
    const campaign = await createCampaign(data);
    const stepsMsg = data.followUpSteps?.length ? ` + ${data.followUpSteps.length} follow-up(s)` : '';
    notify('success', `Campaign "${campaign.name}" created with ${data.leadIds.length} lead${data.leadIds.length !== 1 ? 's' : ''}${stepsMsg}.`);
    fetchCampaigns();
  };

  const handleTestFlightSend = async (campaignId: string, testEmail: string) => {
    return testFlightSend(campaignId, testEmail);
  };

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

  const handleSyncStats = async () => {
    setSyncing(true);
    try {
      const platformCampaigns = campaigns.filter((c) => c.platform_campaign_id && (c.status === 'sending' || c.status === 'active'));
      for (const c of platformCampaigns) {
        await syncStats(c.id);
      }
      if (platformCampaigns.length === 0) {
        notify('warning', 'No active platform campaigns to sync.');
      } else {
        notify('success', `Synced stats for ${platformCampaigns.length} campaign(s).`);
      }
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const isSending = sendStatus === 'sending' || sendStatus === 'connecting';

  // Full-page wizard — replaces the entire content area
  if (showWizard) {
    return (
      <div className="flex flex-col" style={{ height: 'calc(100vh - 4rem)' }}>
        <CampaignWizard
          onClose={() => setShowWizard(false)}
          onCreate={handleCreate}
        />
      </div>
    );
  }

  // Full-page campaign detail — replaces the campaign list
  if (detailCampaign) {
    return (
      <div className="overflow-y-auto" style={{ minHeight: 'calc(100vh - 4rem)' }}>
        <CampaignDetail
          campaign={detailCampaign}
          onClose={() => setDetailCampaign(null)}
          fetchLeads={getCampaignLeads}
          fetchSteps={getCampaignSteps}
          onDuplicate={handleDuplicate}
        />
      </div>
    );
  }

  return (
    <div className="px-10 py-10 space-y-8">

      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Campaign <span className="text-[#b0004a]">Wizard</span>
          </h2>
          <p className="text-secondary font-medium mt-1">
            Build, test, and launch personalized outreach campaigns.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {rateLimit && (
            <div className="text-xs font-semibold text-secondary bg-surface-container rounded-lg px-3 py-2 flex items-center gap-2">
              {warmupStatus && (
                <span className="text-[#b0004a] font-bold">Day {warmupStatus.day} ·</span>
              )}
              {rateLimit.hourlyRemaining}/hr · {rateLimit.dailyRemaining}/{rateLimit.dailyCap} left
            </div>
          )}
          {platformInfo?.enabled && (
            <button
              onClick={handleSyncStats}
              disabled={syncing}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-secondary text-sm font-bold hover:bg-surface-container disabled:opacity-50 transition-colors"
            >
              <span className={`material-symbols-outlined text-[16px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
              Sync Stats
            </button>
          )}
          <button
            onClick={handleCheckReplies}
            disabled={checkingReplies}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-secondary text-sm font-bold hover:bg-surface-container disabled:opacity-50 transition-colors"
          >
            <span className={`material-symbols-outlined text-[16px] ${checkingReplies ? 'animate-spin' : ''}`}>refresh</span>
            Check Replies
          </button>
          <button
            onClick={() => setShowWizard(true)}
            className="flex items-center gap-2 px-5 py-2.5 primary-gradient text-on-primary rounded-lg font-bold text-sm ambient-shadow hover:scale-[1.02] transition-transform"
          >
            <span className="material-symbols-outlined text-[18px]">add_circle</span>
            New Campaign
          </button>
        </div>
      </div>

      {/* Notifications */}
      {notification && (
        <div className={`px-4 py-3 rounded-xl text-sm font-medium border ${
          notification.type === 'success' ? 'bg-[#8ff9a8]/20 text-[#006630] border-[#006630]/20' :
          notification.type === 'error'   ? 'bg-[#ffd9de] text-[#b0004a] border-[#b0004a]/20' :
                                            'bg-amber-50 text-amber-800 border-amber-200'
        }`}>
          {notification.message}
        </div>
      )}
      {repliesMsg && (
        <div className="px-4 py-3 rounded-xl text-sm font-medium bg-blue-50 text-blue-800 border border-blue-200">
          {repliesMsg}
        </div>
      )}

      {/* Active send progress banner */}
      {activeCampaignId && isSending && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-5 border-l-4 border-[#b0004a]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-bold text-on-surface">
              <Loader2 size={15} className="animate-spin text-[#b0004a]" />
              Sending campaign...
            </div>
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center gap-1.5 border border-[#b0004a]/30 text-[#b0004a] bg-white px-3 py-1 rounded-lg text-xs font-bold hover:bg-[#b0004a]/5 disabled:opacity-50 transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">stop_circle</span>
              {cancelling ? 'Stopping...' : 'Cancel Send'}
            </button>
          </div>
          {total > 0 && (
            <div>
              <div className="flex justify-between text-xs text-secondary mb-1.5">
                <span>{sent + failed} / {total} processed</span>
                <span className="font-bold">{sent} sent{failed > 0 ? `, ${failed} failed` : ''}</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-1.5">
                <div
                  className="primary-gradient h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.round(((sent + failed) / total) * 100)}%` }}
                />
              </div>
            </div>
          )}
          <p className="text-xs text-secondary mt-2">
            Emails sent with 30-90s delays. You can leave this page — sending continues in background.
          </p>
        </div>
      )}

      {activeCampaignId && sendStatus === 'completed' && (
        <div className="p-4 bg-[#8ff9a8]/20 border border-[#006630]/20 rounded-xl flex items-center gap-2 text-[#006630] text-sm font-bold">
          <span className="material-symbols-outlined text-[18px]">check_circle</span>
          Campaign sent: {sent} emails delivered{failed > 0 ? `, ${failed} failed` : ''}.
        </div>
      )}

      {activeCampaignId && sendStatus === 'cancelled' && !isSending && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2 text-amber-800 text-sm font-bold">
          <span className="material-symbols-outlined text-[18px]">warning</span>
          Cancelled — {sent} emails were sent before stopping.
        </div>
      )}

      {/* Campaign list */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3
            className="text-lg font-extrabold text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            All Campaigns
          </h3>
          {loading && <Loader2 size={14} className="animate-spin text-secondary" />}
        </div>

        {campaigns.length === 0 && !loading ? (
          <div className="bg-surface-container-lowest rounded-xl ambient-shadow py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-[#ffd9de] flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-[#b0004a] text-[28px]">magic_button</span>
            </div>
            <p
              className="text-on-surface font-bold mb-1"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              No campaigns yet
            </p>
            <p className="text-secondary text-sm mb-4">Create your first campaign to start outreach.</p>
            <button
              onClick={() => setShowWizard(true)}
              className="inline-flex items-center gap-2 text-sm font-bold primary-gradient text-on-primary px-5 py-2.5 rounded-lg ambient-shadow hover:scale-[1.02] transition-transform"
            >
              <span className="material-symbols-outlined text-[16px]">add_circle</span>
              Create your first campaign
            </button>
          </div>
        ) : (
          <div className="grid gap-4">
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
                onLaunch={(id) => setLaunchChoiceId(id)}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onViewDetail={setDetailCampaign}
                deletingId={deletingId}
              />
            ))}
          </div>
        )}
      </div>

      {/* Launch choice — optional test flight or go live now */}
      {launchChoiceId && launchChoiceCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-surface-container-lowest rounded-2xl ambient-shadow w-full max-w-sm overflow-hidden border border-slate-100">
            <div className="primary-gradient px-6 py-5 text-on-primary">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[22px]">rocket_launch</span>
                  <h2 className="text-lg font-extrabold" style={{ fontFamily: 'Manrope, sans-serif' }}>Launch Campaign</h2>
                </div>
                <button onClick={() => setLaunchChoiceId(null)} className="text-white/60 hover:text-white transition-colors p-1">
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
              <p className="text-sm text-white/80 mt-1.5">
                How would you like to launch <span className="font-bold">{launchChoiceCampaign.name}</span>?
              </p>
            </div>
            <div className="px-6 py-6 space-y-3">
              <button
                onClick={() => {
                  setTestFlightCampaignId(launchChoiceId);
                  setLaunchChoiceId(null);
                  if (launchChoiceId) {
                    getCampaignLeads(launchChoiceId)
                      .then((leads) => setTestFlightLeadEmails(leads.map((l: { email_used: string | null }) => l.email_used || '').filter(Boolean)))
                      .catch(() => {});
                  }
                }}
                className="w-full flex items-center gap-3 px-5 py-4 rounded-xl border-2 border-[#b0004a]/20 bg-[#ffd9de]/10 hover:bg-[#ffd9de]/20 text-left transition-colors group"
              >
                <div className="w-9 h-9 rounded-full primary-gradient flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-on-primary text-[18px]">science</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-[#b0004a]">Send Test Email First</p>
                  <p className="text-xs text-secondary mt-0.5">Preview with real lead data before going live</p>
                </div>
                <span className="material-symbols-outlined text-secondary text-[18px] ml-auto">arrow_forward</span>
              </button>
              <button
                onClick={() => {
                  if (!confirm(`Send campaign to ${launchChoiceCampaign.lead_count ?? 0} recipient(s) now without a test email?`)) return;
                  handleLiveSend(launchChoiceId);
                  setLaunchChoiceId(null);
                }}
                className="w-full flex items-center gap-3 px-5 py-4 rounded-xl border border-slate-200 bg-surface-container hover:bg-surface-container-high text-left transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-[#006630] flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-white text-[18px]">send</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-on-surface">Go Live Now</p>
                  <p className="text-xs text-secondary mt-0.5">Send to {launchChoiceCampaign.lead_count ?? 0} recipient(s) immediately</p>
                </div>
                <span className="material-symbols-outlined text-secondary text-[18px] ml-auto">arrow_forward</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Flight — optional pre-send check */}
      {testFlightCampaignId && testFlightCampaign && (
        <TestFlightModal
          campaignName={testFlightCampaign.name}
          recipientCount={testFlightCampaign.lead_count ?? 0}
          leadEmails={testFlightLeadEmails}
          onTestFlightSend={(email) => handleTestFlightSend(testFlightCampaignId, email)}
          onProceedLive={() => handleLiveSend(testFlightCampaignId)}
          onClose={() => setTestFlightCampaignId(null)}
        />
      )}
    </div>
  );
}
