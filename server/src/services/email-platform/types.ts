/**
 * Email Platform Adapter — shared interface for all third-party email platforms.
 * Every provider (Instantly, Smartlead, etc.) implements this interface.
 * The adapter pattern makes swapping providers a one-env-var change.
 */

// ── Campaign lifecycle ──────────────────────────────────────────────

export interface PlatformCampaignParams {
  name: string;
  /** Email steps — first is the initial send, rest are follow-ups */
  sequences: Array<{
    subject: string;
    body: string;
    delayDays?: number;
  }>;
  /** Sending account emails configured on the platform */
  sendingAccounts?: string[];
  dailyLimit?: number;
  stopOnReply?: boolean;
  trackOpens?: boolean;
  trackLinks?: boolean;
  schedule?: {
    timezone: string;
    days: number[];       // 0=Sun … 6=Sat
    startHour: string;    // "09:00"
    endHour: string;      // "17:00"
  };
}

export interface PlatformCampaignResult {
  platformCampaignId: string;
  status: string;
}

// ── Lead management ─────────────────────────────────────────────────

export interface PlatformLead {
  email: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  /** Custom template variables — e.g. { custom_subject, custom_body, website_url } */
  variables?: Record<string, string>;
  /** Internal mapping back to our DB */
  metadata?: { campaignLeadId: string; leadId: string };
}

export interface PlatformLeadResult {
  added: number;
  skipped: number;
  errors: Array<{ email: string; reason: string }>;
}

// ── Analytics ───────────────────────────────────────────────────────

export interface PlatformAnalytics {
  sent: number;
  opened: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
}

export interface PlatformLeadStatus {
  email: string;
  status: 'active' | 'completed' | 'replied' | 'bounced' | 'unsubscribed' | 'paused' | 'sent' | 'opened';
  openCount: number;
  replyCount: number;
  lastActivityAt?: string;
  replySnippet?: string;
}

export interface PlatformLeadStatusPage {
  leads: PlatformLeadStatus[];
  nextCursor?: string;
}

// ── Webhooks ────────────────────────────────────────────────────────

export interface PlatformWebhookEvent {
  eventType: 'email_sent' | 'email_opened' | 'email_replied' | 'email_bounced' | 'lead_unsubscribed';
  email: string;
  platformCampaignId: string;
  timestamp: string;
  replySnippet?: string;
  payload: Record<string, unknown>;
}

// ── The adapter interface ───────────────────────────────────────────

export interface EmailPlatformAdapter {
  /** Human-readable name (e.g. "Instantly", "Smartlead") */
  readonly name: string;

  // Campaign lifecycle
  createCampaign(params: PlatformCampaignParams): Promise<PlatformCampaignResult>;
  activateCampaign(platformCampaignId: string): Promise<void>;
  pauseCampaign(platformCampaignId: string): Promise<void>;
  deleteCampaign(platformCampaignId: string): Promise<void>;

  // Lead management
  addLeads(platformCampaignId: string, leads: PlatformLead[]): Promise<PlatformLeadResult>;

  // Analytics / sync
  getCampaignAnalytics(platformCampaignId: string): Promise<PlatformAnalytics>;
  getLeadStatuses(platformCampaignId: string, cursor?: string): Promise<PlatformLeadStatusPage>;

  // Health
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
