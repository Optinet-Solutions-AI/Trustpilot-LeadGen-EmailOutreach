/**
 * Mock email platform adapter — logs to console, returns fake data.
 * Use for local development and UI testing without hitting any API.
 */

import type {
  EmailPlatformAdapter,
  PlatformCampaignParams,
  PlatformCampaignResult,
  PlatformLead,
  PlatformLeadResult,
  PlatformAnalytics,
  PlatformLeadStatusPage,
} from './types.js';

// In-memory state for mock campaigns
const mockCampaigns = new Map<string, { params: PlatformCampaignParams; leads: PlatformLead[]; active: boolean }>();
let nextId = 1;

export class MockPlatformAdapter implements EmailPlatformAdapter {
  readonly name = 'Mock';

  async createCampaign(params: PlatformCampaignParams): Promise<PlatformCampaignResult> {
    const id = `mock-campaign-${nextId++}`;
    mockCampaigns.set(id, { params, leads: [], active: false });
    console.log(`[MockPlatform] Created campaign "${params.name}" → ${id}`);
    return { platformCampaignId: id, status: 'draft' };
  }

  async activateCampaign(platformCampaignId: string): Promise<void> {
    const c = mockCampaigns.get(platformCampaignId);
    if (c) c.active = true;
    console.log(`[MockPlatform] Activated campaign ${platformCampaignId}`);
  }

  async pauseCampaign(platformCampaignId: string): Promise<void> {
    const c = mockCampaigns.get(platformCampaignId);
    if (c) c.active = false;
    console.log(`[MockPlatform] Paused campaign ${platformCampaignId}`);
  }

  async deleteCampaign(platformCampaignId: string): Promise<void> {
    mockCampaigns.delete(platformCampaignId);
    console.log(`[MockPlatform] Deleted campaign ${platformCampaignId}`);
  }

  async addLeads(platformCampaignId: string, leads: PlatformLead[]): Promise<PlatformLeadResult> {
    const c = mockCampaigns.get(platformCampaignId);
    if (c) c.leads.push(...leads);
    console.log(`[MockPlatform] Added ${leads.length} leads to ${platformCampaignId}`);
    return { added: leads.length, skipped: 0, errors: [] };
  }

  async getCampaignAnalytics(platformCampaignId: string): Promise<PlatformAnalytics> {
    const c = mockCampaigns.get(platformCampaignId);
    const total = c?.leads.length ?? 0;
    // Simulate: all leads sent, 30% opened, 10% replied, 2% bounced
    return {
      sent: total,
      opened: Math.floor(total * 0.3),
      replied: Math.floor(total * 0.1),
      bounced: Math.floor(total * 0.02),
      unsubscribed: 0,
    };
  }

  async getLeadStatuses(platformCampaignId: string): Promise<PlatformLeadStatusPage> {
    const c = mockCampaigns.get(platformCampaignId);
    const leads = (c?.leads ?? []).map((l) => ({
      email: l.email,
      status: 'sent' as const,
      openCount: Math.random() > 0.7 ? 1 : 0,
      replyCount: Math.random() > 0.9 ? 1 : 0,
      lastActivityAt: new Date().toISOString(),
    }));
    return { leads };
  }

  async testConnection(): Promise<{ ok: boolean }> {
    console.log('[MockPlatform] Connection test: OK');
    return { ok: true };
  }
}
