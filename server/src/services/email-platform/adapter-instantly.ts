/**
 * Instantly.ai v2 API adapter.
 * Docs: https://developer.instantly.ai/
 *
 * Handles: campaign CRUD, lead management, analytics, and lead status sync.
 * Rate limit: 75 req/min per workspace — enforced by a simple token bucket.
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

const BASE_URL = 'https://api.instantly.ai/api/v2';
const MAX_LEADS_PER_BATCH = 1000;
const MAX_RETRIES = 3;

interface InstantlyConfig {
  apiKey: string;
  sendingAccounts?: string[];
}

// ── Simple token-bucket rate limiter (75 req/min) ───────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(private maxTokens = 70, private refillMs = 60_000) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    // Wait for next refill
    const waitMs = this.refillMs - (Date.now() - this.lastRefill) + 100;
    await new Promise((r) => setTimeout(r, waitMs));
    this.refill();
    this.tokens--;
  }

  private refill() {
    const now = Date.now();
    if (now - this.lastRefill >= this.refillMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }
}

// ── Adapter ─────────────────────────────────────────────────────────

export class InstantlyAdapter implements EmailPlatformAdapter {
  readonly name = 'Instantly';
  private apiKey: string;
  private sendingAccounts: string[];
  private bucket = new TokenBucket();

  constructor(cfg: InstantlyConfig) {
    if (!cfg.apiKey) throw new Error('INSTANTLY_API_KEY is required when EMAIL_PLATFORM=instantly');
    this.apiKey = cfg.apiKey;
    this.sendingAccounts = cfg.sendingAccounts ?? [];
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await this.bucket.acquire();

      const url = `${BASE_URL}${path}`;
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      };

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429) {
          const retryAfter = +(res.headers.get('retry-after') ?? '10');
          console.warn(`[Instantly] Rate limited, retrying in ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Instantly API ${method} ${path} → ${res.status}: ${text}`);
        }

        // Some endpoints return 204 No Content
        if (res.status === 204) return {} as T;

        return (await res.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt) * 1000;
          console.warn(`[Instantly] Request failed (attempt ${attempt}), retrying in ${backoff}ms: ${lastError.message}`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    throw lastError ?? new Error('Instantly request failed after retries');
  }

  // ── Campaign lifecycle ──────────────────────────────────────────

  async createCampaign(params: PlatformCampaignParams): Promise<PlatformCampaignResult> {
    // Build Instantly campaign payload
    const payload: Record<string, unknown> = {
      name: params.name,
      // Sequences: array of steps. Each step can have multiple variants.
      sequences: params.sequences.map((seq, i) => ({
        steps: [{
          type: 'email',
          variants: [{
            subject: seq.subject,
            body: seq.body,
          }],
          ...(i > 0 && seq.delayDays ? { wait_days: seq.delayDays } : {}),
        }],
      })),
    };

    // Attach sending accounts if provided
    if (this.sendingAccounts.length > 0) {
      payload.email_list = this.sendingAccounts;
    }

    // Campaign settings
    if (params.dailyLimit) payload.daily_limit = params.dailyLimit;
    if (params.stopOnReply !== undefined) payload.stop_on_reply = params.stopOnReply;
    if (params.trackOpens !== undefined) payload.track_opens = params.trackOpens;

    // campaign_schedule is required by Instantly v2 API — always include it
    const sched = params.schedule;
    payload.campaign_schedule = {
      schedules: [{
        name: 'Default',
        timing: {
          from: sched?.startHour ?? '09:00',
          to:   sched?.endHour   ?? '17:00',
        },
        days: {
          sunday:    (sched?.days ?? [1,2,3,4,5]).includes(0),
          monday:    (sched?.days ?? [1,2,3,4,5]).includes(1),
          tuesday:   (sched?.days ?? [1,2,3,4,5]).includes(2),
          wednesday: (sched?.days ?? [1,2,3,4,5]).includes(3),
          thursday:  (sched?.days ?? [1,2,3,4,5]).includes(4),
          friday:    (sched?.days ?? [1,2,3,4,5]).includes(5),
          saturday:  (sched?.days ?? [1,2,3,4,5]).includes(6),
        },
        timezone: sched?.timezone ?? 'America/New_York',
      }],
    };

    const result = await this.request<{ id: string; status: string }>('POST', '/campaigns', payload);
    console.log(`[Instantly] Created campaign "${params.name}" → ${result.id}`);
    return { platformCampaignId: result.id, status: result.status || 'draft' };
  }

  async activateCampaign(platformCampaignId: string): Promise<void> {
    await this.request('POST', `/campaigns/${platformCampaignId}/activate`);
    console.log(`[Instantly] Activated campaign ${platformCampaignId}`);
  }

  async pauseCampaign(platformCampaignId: string): Promise<void> {
    await this.request('POST', `/campaigns/${platformCampaignId}/pause`);
    console.log(`[Instantly] Paused campaign ${platformCampaignId}`);
  }

  async deleteCampaign(platformCampaignId: string): Promise<void> {
    await this.request('DELETE', `/campaigns/${platformCampaignId}`);
    console.log(`[Instantly] Deleted campaign ${platformCampaignId}`);
  }

  // ── Lead management ─────────────────────────────────────────────

  async addLeads(platformCampaignId: string, leads: PlatformLead[]): Promise<PlatformLeadResult> {
    let totalAdded = 0;
    let totalSkipped = 0;
    const allErrors: Array<{ email: string; reason: string }> = [];

    // Batch leads in chunks of MAX_LEADS_PER_BATCH
    for (let i = 0; i < leads.length; i += MAX_LEADS_PER_BATCH) {
      const batch = leads.slice(i, i + MAX_LEADS_PER_BATCH);

      const payload = {
        campaign_id: platformCampaignId,
        leads: batch.map((l) => ({
          email: l.email,
          first_name: l.firstName || '',
          last_name: l.lastName || '',
          company_name: l.companyName || '',
          // Custom variables for template personalization
          ...(l.variables || {}),
        })),
      };

      try {
        const result = await this.request<{
          uploaded: number;
          skipped: number;
          errors?: Array<{ email: string; error: string }>;
        }>('POST', '/leads', payload);

        totalAdded += result.uploaded ?? batch.length;
        totalSkipped += result.skipped ?? 0;
        if (result.errors) {
          allErrors.push(...result.errors.map((e) => ({ email: e.email, reason: e.error })));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Instantly] Batch lead add failed: ${message}`);
        allErrors.push(...batch.map((l) => ({ email: l.email, reason: message })));
      }

      // Small delay between batches to be nice to the API
      if (i + MAX_LEADS_PER_BATCH < leads.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    console.log(`[Instantly] Added ${totalAdded} leads, skipped ${totalSkipped}, errors ${allErrors.length}`);
    return { added: totalAdded, skipped: totalSkipped, errors: allErrors };
  }

  // ── Analytics ───────────────────────────────────────────────────

  async getCampaignAnalytics(platformCampaignId: string): Promise<PlatformAnalytics> {
    const result = await this.request<{
      sent?: number;
      opened?: number;
      replied?: number;
      bounced?: number;
      unsubscribed?: number;
    }>('GET', `/campaigns/${platformCampaignId}/analytics`);

    return {
      sent: result.sent ?? 0,
      opened: result.opened ?? 0,
      replied: result.replied ?? 0,
      bounced: result.bounced ?? 0,
      unsubscribed: result.unsubscribed ?? 0,
    };
  }

  async getLeadStatuses(platformCampaignId: string, cursor?: string): Promise<PlatformLeadStatusPage> {
    const params = new URLSearchParams({ campaign_id: platformCampaignId, limit: '100' });
    if (cursor) params.set('starting_after', cursor);

    const result = await this.request<{
      items?: Array<{
        email: string;
        lead_status?: string;
        open_count?: number;
        reply_count?: number;
        updated_at?: string;
        reply_snippet?: string;
      }>;
      has_more?: boolean;
      next_cursor?: string;
    }>('GET', `/leads?${params.toString()}`);

    const leads = (result.items ?? []).map((item) => ({
      email: item.email,
      status: mapInstantlyStatus(item.lead_status),
      openCount: item.open_count ?? 0,
      replyCount: item.reply_count ?? 0,
      lastActivityAt: item.updated_at,
      replySnippet: item.reply_snippet,
    }));

    return {
      leads,
      nextCursor: result.has_more ? result.next_cursor : undefined,
    };
  }

  // ── Health ──────────────────────────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('GET', '/accounts');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function mapInstantlyStatus(status?: string): 'active' | 'completed' | 'replied' | 'bounced' | 'unsubscribed' | 'paused' | 'sent' | 'opened' {
  switch (status?.toLowerCase()) {
    case 'replied': return 'replied';
    case 'bounced': return 'bounced';
    case 'unsubscribed': return 'unsubscribed';
    case 'paused': return 'paused';
    case 'opened': return 'opened';
    case 'sent':
    case 'completed': return 'sent';
    case 'active':
    case 'in_progress':
    default: return 'active';
  }
}
