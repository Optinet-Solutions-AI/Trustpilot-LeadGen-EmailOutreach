import https from 'https';

type ZBStatus = 'valid' | 'invalid' | 'catch-all' | 'unknown';

interface ZBBatchItem {
  address: string;
  status: string;
  sub_status: string;
  free_email: boolean;
  did_you_mean: string;
  account: string;
  domain: string;
  domain_age_days: string;
  smtp_provider: string;
  mx_found: string;
  mx_record: string;
  firstname: string;
  lastname: string;
  gender: string;
  country: string;
  region: string;
  city: string;
  zipcode: string;
  processed_at: string;
  error?: string;
}

interface ZBBatchResponse {
  email_batch: ZBBatchItem[];
  errors?: Array<{ error: string; email_address: string }>;
}

// Verdict mapping for ZB's top-level status, with a sub_status carve-out
// for `do_not_mail` so we don't blanket-block reputational flags that
// usually still reach a real mailbox. Per ZB's docs
// (https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-status-codes),
// `toxic` and `do_not_mail` are reputation/compliance flags rather than
// mailbox-existence proof — collapsing them to `invalid` permanently silenced
// real prospects. We keep `invalid` for the genuine landmines: spamtraps,
// abuse reporters, and the two `do_not_mail` sub-statuses that imply
// suppression-list / spamtrap exposure (`global_suppression`,
// `possible_trap`). Everything else (role_based, mx_forward, role-based
// catch-all, etc.) demotes to `catch-all` or `unknown` — both already
// selectable and sendable under the campaign send-gate, so the user can
// opt-in per campaign.
function mapStatus(zbStatus: string, zbSubStatus: string): ZBStatus {
  const status = zbStatus.toLowerCase();
  const subStatus = (zbSubStatus || '').toLowerCase();
  switch (status) {
    case 'valid':       return 'valid';
    case 'invalid':     return 'invalid';
    case 'catch-all':   return 'catch-all';
    case 'spamtrap':    return 'invalid';
    case 'abuse':       return 'invalid';
    case 'toxic':       return 'unknown';
    case 'do_not_mail':
      if (subStatus === 'global_suppression' || subStatus === 'possible_trap') return 'invalid';
      return 'catch-all';
    default:            return 'unknown';
  }
}

function postJson(url: string, body: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`ZeroBounce non-JSON response: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const BATCH_SIZE = 100; // ZeroBounce batch limit

/**
 * Turn one ZeroBounce batch response into verdicts, and REFUSE to be silent
 * about addresses ZB declined to judge.
 *
 * ZB reports per-address refusals (rate limiting, quota, malformed input) in
 * `errors[]` and simply omits them from `email_batch`. Dropping that field —
 * which this module used to do — makes a refusal indistinguishable from "no
 * verdict available": the validator's Stage 5 stores NULL, the lead ends up
 * `unknown`, and nothing anywhere says ZB was never actually consulted.
 * That is how 74 leads were stamped `unknown` on 2026-09-03 without spending
 * a single credit. Throwing here surfaces the reason in the validator's
 * existing catch (`[validator] ZB fallback failed for …`) and lets the caller
 * retry instead of persisting a false verdict.
 */
export function mapBatchResponse(
  chunk: string[],
  response: ZBBatchResponse,
): Array<{ email: string; status: ZBStatus }> {
  const batch = response.email_batch ?? [];
  const results = batch.map((item) => ({
    email: item.address,
    status: mapStatus(item.status, item.sub_status),
  }));

  if (results.length === 0) {
    const reasons = (response.errors ?? [])
      .map((e) => `${e.email_address}: ${e.error}`)
      .join('; ');
    throw new Error(
      reasons
        ? `ZeroBounce returned no verdict for ${chunk.length} address(es) — ${reasons}`
        : `ZeroBounce returned no verdict for ${chunk.length} address(es) and no error detail`,
    );
  }

  if (results.length < chunk.length) {
    const reasons = (response.errors ?? [])
      .map((e) => `${e.email_address}: ${e.error}`)
      .join('; ');
    console.warn(
      `[ZeroBounce] ${chunk.length - results.length}/${chunk.length} address(es) got no verdict${reasons ? ` — ${reasons}` : ''}`,
    );
  }

  return results;
}

export async function verifyEmails(emails: string[]): Promise<Array<{ email: string; status: ZBStatus }>> {
  const apiKey = process.env.ZEROBOUNCE_API_KEY;
  if (!apiKey) throw new Error('ZEROBOUNCE_API_KEY is not set');

  const results: Array<{ email: string; status: ZBStatus }> = [];

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const chunk = emails.slice(i, i + BATCH_SIZE);
    const emailBatch = chunk.map((e) => ({ email_address: e, ip_address: '' }));

    console.log(`[ZeroBounce] Verifying batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} emails`);

    const response = (await postJson('https://api.zerobounce.net/v2/validatebatch', {
      api_key: apiKey,
      email_batch: emailBatch,
    })) as ZBBatchResponse;

    for (const r of mapBatchResponse(chunk, response)) {
      results.push(r);
    }
  }

  console.log(`[ZeroBounce] Done. ${results.filter((r) => r.status === 'valid').length} valid, ${results.filter((r) => r.status === 'invalid').length} invalid, ${results.filter((r) => r.status === 'catch-all').length} catch-all, ${results.filter((r) => r.status === 'unknown').length} unknown`);
  return results;
}
