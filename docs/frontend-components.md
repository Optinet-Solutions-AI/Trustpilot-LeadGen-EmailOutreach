# Frontend Components

## Pages (6)

| Page | Route | Purpose |
|------|-------|---------|
| `Dashboard.tsx` | `/` | Stats overview, upcoming follow-ups, campaign summary |
| `Scrape.tsx` | `/scrape` | Scrape form + live SSE progress + job history |
| `Leads.tsx` | `/leads` | Table/Kanban toggle + country/category/status filters |
| `LeadDetail.tsx` | `/leads/:id` | Full lead info + activity timeline + follow-ups |
| `Campaigns.tsx` | `/campaigns` | Campaign builder + list + stats |
| `Analytics.tsx` | `/analytics` | Charts (recharts): leads by status, country, campaign comparison |

---

## Components

### `ScrapeForm.tsx`
Inputs: Country (ISO 2-letter dropdown), Category (Trustpilot slug dropdown), Min/Max Rating, Enrich checkbox, Verify checkbox.  
On submit → calls `POST /api/scrape` → returns jobId → passes to `ScrapeProgress`.

### `ScrapeProgress.tsx`
Subscribes to `GET /api/scrape/:id/status` (SSE).  
Renders: stage label, animated progress bar, lead count badges.

### `LeadsTable.tsx`
Sortable columns: Company (+ website URL), Country, Category (pill badge), Email, Rating, Status, Created.  
Features: search, country filter, category filter, status filter, bulk select, bulk status update.

### `LeadPipeline.tsx`
Kanban board. 5 columns: New / Contacted / Replied / Converted / Lost.  
Drag-drop card → calls `PATCH /api/leads/:id` → auto-logs status_change activity.

### `CampaignBuilder.tsx`
Fields: Name, Subject, Body (HTML editor), Country filter, Category filter.  
Token buttons: `{{company_name}}`, `{{star_rating}}`, `{{review_count}}`, `{{website_url}}`.  
AI Generate button → calls Gemini API → fills body with professional template.  
Pre-filled with OptiRate template on mount.

### `ActivityTimeline.tsx`
Per-lead event log. Renders each `lead_notes` row as a timeline item with icon by type.  
Types: note (pencil), status_change (arrow), email_sent (envelope), verification (check), follow_up (bell).

### `NoteEditor.tsx`
Single textarea + submit. Calls `POST /api/leads/:id/notes` with `type: "note"`.

### `FollowUpScheduler.tsx`
Date picker + note. Calls `POST /api/leads/:id/follow-ups`.  
Lists existing follow-ups with complete button.

### `StatusBadge.tsx`
Color-coded pill for `outreach_status`:
- new → gray
- contacted → blue
- replied → yellow
- converted → green
- lost → red

### `StatsRow.tsx`
Row of 4 stat cards on Dashboard: Total Leads, Contacted, Replied, Converted.

### `Layout.tsx` + `Sidebar.tsx`
Fixed sidebar navigation. Links to all 6 pages. Active state highlighting.

---

## Hooks

| Hook | Calls | Returns |
|------|-------|---------|
| `useLeads(filters)` | `GET /api/leads` | `{ leads, total, loading, error, refetch }` |
| `useScrape()` | `POST /api/scrape`, SSE | `{ startScrape, progress, jobId }` |
| `useCampaigns()` | `GET/POST /api/campaigns` | `{ campaigns, create, send, loading }` |
| `useNotes(leadId)` | `GET/POST /api/leads/:id/notes` | `{ notes, addNote, loading }` |
| `useFollowUps(leadId)` | `GET/POST /api/leads/:id/follow-ups` | `{ followUps, add, complete }` |
| `useAnalytics()` | `GET /api/analytics` | `{ data, loading }` |

---

## Types

```typescript
// lead.ts
interface Lead {
  id: string;
  company_name: string;
  trustpilot_url: string;
  website_url?: string;
  trustpilot_email?: string;
  website_email?: string;
  primary_email?: string;
  phone?: string;
  country?: string;
  category?: string;
  star_rating?: number;
  email_verified: boolean;
  verification_status?: 'valid' | 'invalid' | 'catch-all' | 'unknown';
  outreach_status: 'new' | 'contacted' | 'replied' | 'converted' | 'lost';
  created_at: string;
}

// campaign.ts
interface Campaign {
  id: string;
  name: string;
  template_subject: string;
  template_body: string;
  status: 'draft' | 'sent' | 'completed';
  total_sent: number;
  total_opened: number;
  total_replied: number;
  total_bounced: number;
}
```

---

## Design System

- **Framework:** Tailwind CSS (utility-first)
- **Colors:** Indigo primary, gray neutrals, status-specific (green/blue/yellow/red)
- **Font:** System stack (no custom fonts)
- **Icons:** Lucide React
- **Charts:** Recharts (PieChart, BarChart, LineChart)
- **Grid:** 12-column on desktop, single column on mobile

## Gemini AI Integration

`frontend/src/lib/gemini.ts` — wrapper around Google Generative AI SDK.

**Used in:** `CampaignBuilder.tsx` → "Generate with AI" button.

**What it generates:** A professional HTML cold outreach email body, personalized by:
- Target country + category
- Star rating context
- OptiRate brand voice (reputation management)

Requires `VITE_GEMINI_API_KEY` environment variable.
