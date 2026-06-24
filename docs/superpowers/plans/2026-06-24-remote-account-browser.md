# Remote "Open Account's Browser" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open an already-logged-in, centrally-hosted browser for a social account (james + future fleet), streamed into the app, to manually work as that account — deep-linked from a lead or as a general session.

**Architecture:** Extends the existing **connect flow** (DB-row message bus → EC2 Windows worker spawns Brave + noVNC + cloudflared → tunnel URL streamed to the user). Adds a `browse` mode that opens the account's **existing** profile (no cookie capture), with a **per-account single-occupant lock**, a deep-link target, and an idle/explicit teardown.

**Tech Stack:** Node + TypeScript (Express API, EC2 worker poller), Supabase Postgres, PowerShell (`ec2-windows-spawn-noVNC.ps1`), React (`SocialAccounts.tsx` + lead detail), cloudflared + noVNC (existing).

## Global Constraints

- Connect-flow state lives on **`social_accounts`** (the `connect_*` columns), NOT a separate table. Reuse them.
- API responses are exactly `{ success: true, data }` / `{ success: false, error }`.
- Migrations idempotent: `IF NOT EXISTS` / guarded `CHECK` changes; safe to re-apply.
- The account's cookies/session **never leave the worker** — the user sees only the noVNC pixel stream.
- **One non-terminal browse session per account** (single-occupant lock). A second request → `409`.
- Browse mode opens the account's EXISTING profile (`C:\fb-profiles\<account_id>`) and does **NOT** capture cookies (already logged in).
- Worker claim uses optimistic concurrency on `connect_session_id` (existing pattern) — do not break it.
- Don't change the existing `mode='connect'` behavior.
- `tsc --noEmit` clean in `server/` and `frontend/` before each commit that touches them.

---

## File Structure
- Modify: `supabase/migrations/` — new migration `054_social_browse_sessions.sql` (adds `connect_mode`, `connect_target_url`, `connect_requested_by`; widens `connect_status` CHECK with `'active'`,`'ended'`).
- Modify: `server/src/db/social-connect-requests.ts` — add browse enqueue (with lock), end, and widen types.
- Modify: `server/src/routes/social-accounts.ts` — `POST /:id/browse`, `POST /:id/browse/end` (reuse `GET /:id/connect-status` for polling).
- Test: `server/src/__tests__/social-browse-sessions.test.ts` — lock + lifecycle.
- Modify: `server/src/worker/social-connect-worker.ts` + `scripts/ec2-windows-spawn-noVNC.ps1` — handle `mode='browse'` (existing profile, target URL, no capture, idle teardown). **(live-discovery — validated on EC2.)**
- Modify: `frontend/src/views/SocialAccounts.tsx` — per-account "Open session" button + active-session/End controls.
- Modify: lead detail view + `frontend/src/hooks/` — "Open in James's browser" deep-link button.

---

## Task 1: Migration — browse-mode columns

**Files:** Create `supabase/migrations/054_social_browse_sessions.sql`

**Interfaces:** Produces columns `social_accounts.connect_mode` (text, `'connect'`|`'browse'`, default `'connect'`), `connect_target_url` (text, nullable), `connect_requested_by` (text, nullable); `connect_status` CHECK now also allows `'active'` and `'ended'`.

- [ ] **Step 1: Write the migration**
```sql
-- 054_social_browse_sessions.sql — adds 'browse' mode to the connect-flow
-- columns so a user can open an account's EXISTING logged-in profile as a
-- streamed interactive session (not a fresh login). Idempotent.
BEGIN;
ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS connect_mode         text NOT NULL DEFAULT 'connect',
  ADD COLUMN IF NOT EXISTS connect_target_url   text,
  ADD COLUMN IF NOT EXISTS connect_requested_by text;

-- Widen connect_status to allow the browse lifecycle ('active' while held,
-- 'ended' on teardown). Drop+recreate the CHECK (Postgres can't ALTER it).
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_connect_status_check;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_connect_status_check
  CHECK (connect_status IS NULL OR connect_status IN
    ('requested','provisioning','ready','captured','expired','failed','active','ended'));
COMMIT;
```
- [ ] **Step 2: Operator applies in Supabase**; verify:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name='social_accounts'
  AND column_name IN ('connect_mode','connect_target_url','connect_requested_by');
```
Expected: 3 rows.
- [ ] **Step 3: Commit** `git add supabase/migrations/054_social_browse_sessions.sql && git commit -m "feat(db): add browse-mode columns to social_accounts connect flow"`

---

## Task 2: DB module — browse enqueue (with lock) + end

**Files:** Modify `server/src/db/social-connect-requests.ts`; Test `server/src/__tests__/social-browse-sessions.test.ts`

**Interfaces:**
- Consumes: `getSupabase()`, existing `ConnectStatus`.
- Produces:
  - `BROWSE_ACTIVE_STATES = ['requested','provisioning','ready','active'] as const`
  - `class AccountInUseError extends Error { constructor(public heldBy: string|null, public expiresAt: string|null) }`
  - `enqueueBrowseSession(accountId: string, opts: { targetUrl: string|null, requestedBy: string }): Promise<ConnectRequestRow>` — throws `AccountInUseError` if a non-terminal browse session already exists for the account; otherwise sets `connect_mode='browse'`, `connect_status='requested'`, new session id, target url, requested_by, started/expires.
  - `endBrowseSession(accountId: string): Promise<void>` — sets `connect_status='ended'` (worker tears down on seeing it).

- [ ] **Step 1: Write the failing test**
```typescript
// server/src/__tests__/social-browse-sessions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase client used by the module.
const rows: Record<string, any> = {};
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => makeFakeClient(),
}));
function makeFakeClient() { /* minimal chainable stub backed by `rows` */ return fake; }
// ... (implementer: model a chainable .from().select().eq()....single()/update() over `rows`,
//      mirroring server/src/__tests__/social-connect-requests.test.ts which already
//      exercises this module — copy its fake-client harness.)

import { enqueueBrowseSession, endBrowseSession, AccountInUseError } from '../db/social-connect-requests.js';

beforeEach(() => { for (const k of Object.keys(rows)) delete rows[k]; });

it('enqueues a browse session when account is free', async () => {
  rows['acc1'] = { id: 'acc1', connect_status: null, connect_mode: 'connect' };
  const r = await enqueueBrowseSession('acc1', { targetUrl: 'https://fb.com/p/1', requestedBy: 'jane' });
  expect(rows['acc1'].connect_mode).toBe('browse');
  expect(rows['acc1'].connect_status).toBe('requested');
  expect(rows['acc1'].connect_target_url).toBe('https://fb.com/p/1');
  expect(rows['acc1'].connect_requested_by).toBe('jane');
});

it('rejects a second browse session for an in-use account', async () => {
  rows['acc1'] = { id: 'acc1', connect_status: 'active', connect_mode: 'browse', connect_requested_by: 'bob', connect_expires_at: 'X' };
  await expect(enqueueBrowseSession('acc1', { targetUrl: null, requestedBy: 'jane' }))
    .rejects.toBeInstanceOf(AccountInUseError);
});

it('endBrowseSession marks ended', async () => {
  rows['acc1'] = { id: 'acc1', connect_status: 'active', connect_mode: 'browse' };
  await endBrowseSession('acc1');
  expect(rows['acc1'].connect_status).toBe('ended');
});
```
- [ ] **Step 2: Run — fails** `cd server && npx vitest run src/__tests__/social-browse-sessions.test.ts` → FAIL (exports missing). (Use the project's existing test runner — confirm it's vitest from `social-connect-requests.test.ts`; match it.)
- [ ] **Step 3: Implement** in `social-connect-requests.ts`:
```typescript
export const BROWSE_ACTIVE_STATES = ['requested','provisioning','ready','active'] as const;

export class AccountInUseError extends Error {
  constructor(public heldBy: string | null, public expiresAt: string | null) {
    super(`account in use by ${heldBy ?? 'another user'}`);
    this.name = 'AccountInUseError';
  }
}

export async function enqueueBrowseSession(
  accountId: string,
  opts: { targetUrl: string | null; requestedBy: string },
): Promise<ConnectRequestRow> {
  const sb = getSupabase();
  const { data: cur, error: e1 } = await sb.from('social_accounts')
    .select('connect_status, connect_mode, connect_requested_by, connect_expires_at')
    .eq('id', accountId).single();
  if (e1) throw new Error(`enqueueBrowseSession read: ${e1.message}`);
  if (cur && (BROWSE_ACTIVE_STATES as readonly string[]).includes(cur.connect_status)) {
    throw new AccountInUseError(cur.connect_requested_by ?? null, cur.connect_expires_at ?? null);
  }
  const sessionId = crypto.randomUUID();
  const now = new Date(); const expires = new Date(now.getTime() + TTL_MS);
  const { data, error } = await sb.from('social_accounts').update({
    connect_mode: 'browse', connect_session_id: sessionId, connect_status: 'requested',
    connect_tunnel_url: null, connect_target_url: opts.targetUrl, connect_requested_by: opts.requestedBy,
    connect_started_at: now.toISOString(), connect_expires_at: expires.toISOString(), connect_error: null,
  }).eq('id', accountId)
    .select('id, connect_session_id, connect_status, connect_tunnel_url, connect_started_at, connect_expires_at, connect_error')
    .single();
  if (error) throw new Error(`enqueueBrowseSession: ${error.message}`);
  return data as ConnectRequestRow;
}

export async function endBrowseSession(accountId: string): Promise<void> {
  const { error } = await getSupabase().from('social_accounts')
    .update({ connect_status: 'ended' as ConnectStatus }).eq('id', accountId);
  if (error) throw new Error(`endBrowseSession: ${error.message}`);
}
```
Also widen `ConnectStatus` union with `'active' | 'ended'`.
- [ ] **Step 4: Run — passes** (3 passed). Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `git add server/src/db/social-connect-requests.ts server/src/__tests__/social-browse-sessions.test.ts && git commit -m "feat(backend): browse-session enqueue with per-account lock + end"`

---

## Task 3: API routes — POST /:id/browse + /:id/browse/end

**Files:** Modify `server/src/routes/social-accounts.ts`

**Interfaces:**
- Consumes: `enqueueBrowseSession`, `endBrowseSession`, `AccountInUseError` (Task 2); existing `getConnectRequestStatus` for polling.
- Produces: `POST /api/social-accounts/:id/browse` body `{ targetUrl?: string, requestedBy: string }` → `{success,data:{connect_session_id,...}}`, or `409 {success:false,error}` when `AccountInUseError`. `POST /api/social-accounts/:id/browse/end` → `{success:true}`.

- [ ] **Step 1: Add the routes** (mirror the existing `/:id/connect` handler shape):
```typescript
router.post('/:id/browse', async (req: Request, res: Response) => {
  try {
    const { targetUrl, requestedBy } = req.body as { targetUrl?: string; requestedBy?: string };
    if (!requestedBy) { res.status(400).json({ success: false, error: 'requestedBy is required' }); return; }
    const row = await enqueueBrowseSession(String(req.params.id), { targetUrl: targetUrl ?? null, requestedBy });
    res.json({ success: true, data: row });
  } catch (err) {
    if (err instanceof AccountInUseError) {
      res.status(409).json({ success: false, error: `In use by ${err.heldBy ?? 'another user'}${err.expiresAt ? ` until ${err.expiresAt}` : ''}` });
      return;
    }
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.post('/:id/browse/end', async (req: Request, res: Response) => {
  try { await endBrowseSession(String(req.params.id)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: (err as Error).message }); }
});
```
Add the imports. (Polling reuses the existing `GET /:id/connect-status`.)
- [ ] **Step 2: Type-check** `cd server && npx tsc --noEmit` → clean.
- [ ] **Step 3: Commit** `git add server/src/routes/social-accounts.ts && git commit -m "feat(backend): browse session start/end routes"`

---

## Task 4: EC2 worker + spawn script — browse mode (LIVE-DISCOVERY)

**Files:** Modify `server/src/worker/social-connect-worker.ts`, `scripts/ec2-windows-spawn-noVNC.ps1`

> **LIVE-DISCOVERY:** this runs on the Windows EC2 worker (noVNC/cloudflared/Brave). Validate on the worker; don't claim done from code alone.

**Interfaces:** Consumes the claim pattern in `claimPendingConnectRequest` + `updateConnectStatus`. The worker already handles `mode='connect'`; this adds the `browse` branch.

- [ ] **Step 1:** In the worker poll loop, read `connect_mode` on the claimed row. For `browse`: call the spawn script with the account's **existing** profile dir + `connect_target_url` (default facebook.com), and **skip** the cookie-capture watcher.
- [ ] **Step 2:** In `ec2-windows-spawn-noVNC.ps1`, add a `-Mode browse -TargetUrl <url>` path: launch Brave on `C:\fb-profiles\<account_id>` at `$TargetUrl`, start VNC+noVNC+cloudflared as today, write `connect_tunnel_url` + `connect_status='active'`.
- [ ] **Step 3:** Teardown triggers for browse: (a) `connect_status='ended'` observed (user clicked End), or (b) `connect_expires_at` passed (idle TTL) → kill Brave + tunnel + noVNC, set `connect_status='ended'`. The profile is **left intact** (keeps the account warm). On open, if Brave lands on `/login` → set `connect_status='failed'`, `connect_error='account session stale — run Connect first'`.
- [ ] **Step 4: Live smoke on EC2** — start a browse session for james from the app → confirm tunnel opens to a logged-in james at the target URL → End session → confirm teardown + lock released. Record findings in `workflows/`.
- [ ] **Step 5: Commit** `git add server/src/worker/social-connect-worker.ts scripts/ec2-windows-spawn-noVNC.ps1 && git commit -m "feat(worker): browse-mode remote session (existing profile, deep-link, idle teardown)"`

---

## Task 5: Frontend — launch buttons + session controls

**Files:** Modify `frontend/src/views/SocialAccounts.tsx`, lead detail view, a `frontend/src/hooks/` hook (mirror `useCommentDrafts.ts` / existing connect-modal code in SocialAccounts).

**Interfaces:** Consumes `POST /api/social-accounts/:id/browse`, `.../browse/end`, `GET /:id/connect-status`.

- [ ] **Step 1: Hook** `useBrowseSession` — `start(accountId, {targetUrl, requestedBy})`, poll `connect-status` until `connect_tunnel_url` set, `end(accountId)`; expose `loading`, `error`, `tunnelUrl`, `status`. Surface the `409` "in use" message.
- [ ] **Step 2: SocialAccounts.tsx** — per-account **"Open session"** button → `start(accountId, {requestedBy: <current user>})` → when `tunnelUrl` ready, `window.open(tunnelUrl, '_blank')` (FB CSP blocks iframing — open a tab). Show an "active — End session" control while held.
- [ ] **Step 3: Lead detail** — **"Open in James's browser"** button, visible for FB-presence leads → `start(<account for lead's country>, {targetUrl: lead.post_url, requestedBy})`. (Account resolution can reuse the comment path's lead→account logic, or pass the lead_id and let the server resolve.)
- [ ] **Step 4: Type-check + manual** `cd frontend && npx tsc --noEmit` → clean; click-through against a local server: start → tab opens (or shows "click to open") → End.
- [ ] **Step 5: Commit** `git add frontend/src && git commit -m "feat(frontend): open remote account browser (session + lead deep-link)"`

---

## Self-Review
- **Spec coverage:** browse mode on connect flow → Tasks 1,2,4. Per-account lock → Task 2. Both triggers (lead deep-link + general) → Task 5. Worker existing-profile + deep-link + teardown → Task 4. Security (pixel stream, no cookie capture) → inherent in Task 4 (browse skips capture, reuses noVNC). Stale-session detection → Task 4 Step 3. ✓
- **Placeholders:** Task 2's fake-client harness says "copy from `social-connect-requests.test.ts`" — that's a real existing harness to mirror, not a TODO. Task 4 is LIVE-DISCOVERY (EC2/noVNC can't be unit-asserted) — flagged with a live smoke gate, not fake steps. Frontend account-resolution offers two concrete options. No other gaps.
- **Type consistency:** `enqueueBrowseSession(accountId, {targetUrl, requestedBy})`, `endBrowseSession(accountId)`, `AccountInUseError(heldBy, expiresAt)`, `BROWSE_ACTIVE_STATES`, status values `'active'`/`'ended'` — consistent across Tasks 2/3/5.

## Dependencies / notes
- Requires the existing connect flow working on the worker (james connected).
- **Single account = one global lock**; the fleet relieves concurrency automatically.
- This is manual browsing — it complements, doesn't replace, the server-side scrape/comment automation.
