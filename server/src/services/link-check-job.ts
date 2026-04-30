// Shared SSE-driven job runner for the bulk link-validation feature.
//
// Both the Leads and Affiliates views need the same UX: kick off a background
// job, stream progress events to the JobProgress panel, persist link_status
// + last_validated_at when each row finishes. The two only differ by which
// table they update (`leads` vs `affiliates`) and which column holds the URL.
import { EventEmitter } from 'events';
import { validateTrustpilotUrl } from './url-validator.js';
import { getSupabase } from '../lib/supabase.js';

export interface LinkCheckJob {
  status: 'running' | 'completed' | 'failed';
  total: number;
  checked: number;
  valid: number;
  flagged_dead: number;
  flagged_removed: number;
  unknown: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface LinkCheckRegistry {
  jobs: Map<string, LinkCheckJob>;
  events: EventEmitter;
}

export function createRegistry(): LinkCheckRegistry {
  const events = new EventEmitter();
  events.setMaxListeners(50);
  return { jobs: new Map(), events };
}

export type LinkCheckSource = 'leads' | 'affiliates';

const URL_COLUMN: Record<LinkCheckSource, string> = {
  leads: 'trustpilot_url',
  affiliates: 'tp_url',
};

// 8-way concurrency keeps Trustpilot happy while finishing a 200-row batch
// well inside the SSE keepalive window.
const CONCURRENCY = 8;

export async function runLinkCheckJob(
  jobId: string,
  source: LinkCheckSource,
  ids: string[],
  registry: LinkCheckRegistry,
): Promise<void> {
  const { jobs, events } = registry;
  const emit = (stage: string, detail: string) => {
    events.emit('progress', { jobId, stage, detail, timestamp: new Date().toISOString() });
  };

  const supabase = getSupabase();
  const urlCol = URL_COLUMN[source];

  try {
    // Dynamic column name — Supabase's static select<> typing can't infer
    // columns from a string variable, so cast through unknown.
    const { data: rows, error: fetchErr } = await supabase
      .from(source)
      .select(`id, ${urlCol}`)
      .in('id', ids);
    if (fetchErr) throw new Error(fetchErr.message);

    const rawRows = (rows ?? []) as unknown as Array<Record<string, string>>;
    const targets = rawRows
      .map((r) => ({ id: r.id, url: r[urlCol] }))
      .filter((r): r is { id: string; url: string } => Boolean(r.url));

    const job = jobs.get(jobId)!;
    job.total = targets.length;
    emit('check_start', String(targets.length));

    const now = new Date().toISOString();
    let cursor = 0;

    const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const i = cursor++;
        const target = targets[i];
        emit('check_item', `${i + 1}|${targets.length}|${target.url}`);

        const { status, error } = await validateTrustpilotUrl(target.url);

        if (status === 'VALID') job.valid++;
        else if (status === 'FLAGGED_DEAD') job.flagged_dead++;
        else if (status === 'FLAGGED_REMOVED') job.flagged_removed++;
        else job.unknown++;
        job.checked++;

        await supabase
          .from(source)
          .update({
            link_status: status,
            last_validated_at: now,
            link_validation_error: error,
          })
          .eq('id', target.id);

        emit('check_progress', `${job.checked}/${targets.length}|${target.url}|${status}`);
      }
    });
    await Promise.all(workers);

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    emit(
      'completed',
      JSON.stringify({
        total: job.total,
        checked: job.checked,
        valid: job.valid,
        flagged_dead: job.flagged_dead,
        flagged_removed: job.flagged_removed,
        unknown: job.unknown,
      }),
    );
  } catch (err) {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
    }
    emit('failed', err instanceof Error ? err.message : String(err));
  }
}

export function newJob(): LinkCheckJob {
  return {
    status: 'running',
    total: 0,
    checked: 0,
    valid: 0,
    flagged_dead: 0,
    flagged_removed: 0,
    unknown: 0,
    startedAt: new Date().toISOString(),
  };
}
