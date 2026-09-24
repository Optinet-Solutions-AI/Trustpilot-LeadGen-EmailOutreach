/**
 * Seed inbox-placement test — pure planning logic, shared by the background
 * sender (seed-test/sender.ts) and scripts/seed-placement-send.ts. No I/O.
 *
 * Every seed is mailed once by EVERY sender, so each domain's placement is
 * measured on the same mailboxes. Unsent (seed, sender) pairs are planned onto
 * Manila days at `perDay` per sender. A missed day rolls the plan forward, so
 * the dates on the page are always the honest next ones.
 */

export const SEED_TZ = 'Asia/Manila';

export interface SeedSender { connectionId: number; email: string; fromName: string }

export interface SeedResult {
  n: number; email: string; sender: string; ref: string;
  status: 'queued' | 'sent' | 'failed'; sent_at: string | null; error: string | null;
  /** Manila calendar day this pair went out, or is planned to (YYYY-MM-DD). */
  scheduled_for?: string | null;
}

export interface SeedRun {
  runId: string;
  subject: string;
  per_day: number;
  timezone: string;
  /** The background sender only touches runs with this set. */
  auto_send?: boolean;
  updated_at: string;
  results: SeedResult[];
}

export const SEED_SUBJECT = 'Quick question about your online reviews';

export function seedBody(ref: string, fromName: string): string {
  return '<p>Hi there,</p>\n' +
    '<p>I came across your business while looking at local companies with recent customer reviews, ' +
    'and noticed a few that went unanswered. Replying to them — even the unhappy ones — is one of the ' +
    'simplest ways to win back trust with people deciding whether to call you.</p>\n' +
    '<p>We help small businesses respond to and recover their reviews. Would a short summary of what ' +
    'we found be useful?</p>\n' +
    `<p>Best,<br>${fromName.replace(/ at .*/, '')}<br>OptiRate</p>\n` +
    `<p style="font-size:10px;color:#bbb;">Ref ${ref}</p>`;
}

/** YYYY-MM-DD in Manila for an instant. */
export function manilaDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SEED_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Hour of day (0-23) in Manila for an instant. */
export function manilaHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: SEED_TZ, hour: '2-digit', hourCycle: 'h23' }).format(d));
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse ONGAGE_SENDERS ("conn_id:from_address:from_name, ..."). */
export function parseSeedSenders(raw: string | undefined): SeedSender[] {
  return (raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [conn, email, ...name] = s.split(':');
    return { connectionId: parseInt(conn, 10), email: (email || '').trim().toLowerCase(), fromName: name.join(':').trim() || 'OptiRate' };
  }).filter((s) => s.connectionId && s.email);
}

/** One row per (seed, sender). The first run gave each seed one sender and
 *  the bare ref; those rows keep it, the other pairs get a sender suffix. */
export function buildPairs(runId: string, seeds: string[], pool: SeedSender[], prior: SeedResult[]): SeedResult[] {
  const byPair = new Map(prior.map((r) => [`${r.email}|${r.sender}`, r]));
  const out: SeedResult[] = [];
  seeds.forEach((email, i) => {
    const nnn = String(i + 1).padStart(3, '0');
    for (const s of pool) {
      out.push(byPair.get(`${email}|${s.email}`) ?? {
        n: i + 1, email, sender: s.email, ref: `${runId}-${nnn}-${s.email.split('@')[0]}`,
        status: 'queued', sent_at: null, error: null,
      });
    }
  });
  return out;
}

/** Seed sends a sender made on a Manila day. Counted from sent_at, never
 *  from the plan, so the cap holds however the plan moved. */
export function sentOnDay(results: SeedResult[], sender: string, day: string): number {
  return results.filter((r) => r.sender === sender && r.status === 'sent' && r.sent_at && manilaDay(new Date(r.sent_at)) === day).length;
}

/** Plan unsent pairs onto days, perDay per sender, starting today with
 *  whatever room today has left. Mutates `scheduled_for` in place. */
export function planPairs(results: SeedResult[], senders: string[], perDay: number, now = new Date()): void {
  const today = manilaDay(now);
  for (const s of senders) {
    const mine = results.filter((r) => r.sender === s);
    for (const r of mine) if (r.status === 'sent' && r.sent_at) r.scheduled_for = manilaDay(new Date(r.sent_at));
    let day = today;
    let room = Math.max(0, perDay - sentOnDay(results, s, today));
    for (const r of mine.filter((x) => x.status !== 'sent').sort((a, b) => a.n - b.n)) {
      while (room === 0) { day = addDays(day, 1); room = perDay; }
      r.scheduled_for = day;
      room--;
    }
  }
}

/** The next pair to send right now, or null. Rotates senders so no domain
 *  bursts: prefers the sender whose last seed send is oldest. Failed pairs
 *  are not retried automatically. */
export function nextDuePair(results: SeedResult[], senders: string[], perDay: number, now = new Date()): SeedResult | null {
  const today = manilaDay(now);
  const lastSent = (s: string) => Math.max(0, ...results
    .filter((r) => r.sender === s && r.sent_at).map((r) => new Date(r.sent_at!).getTime()));
  const order = [...senders].sort((a, b) => lastSent(a) - lastSent(b));
  for (const s of order) {
    if (sentOnDay(results, s, today) >= perDay) continue;
    const due = results
      .filter((r) => r.sender === s && r.status === 'queued' && r.scheduled_for && r.scheduled_for <= today)
      .sort((a, b) => (a.scheduled_for! < b.scheduled_for! ? -1 : a.scheduled_for! > b.scheduled_for! ? 1 : a.n - b.n));
    if (due[0]) return due[0];
  }
  return null;
}
