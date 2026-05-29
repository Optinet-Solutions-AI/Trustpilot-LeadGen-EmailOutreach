/**
 * Pure template renderers for the colleague-network warmup.
 * No side effects, no I/O — safe to unit test.
 */

import { BODY_TEMPLATE } from './config.js';

/** Token substitution. Replaces {{recipient_name}} and {{sender_from_name}}. */
export function renderBody(opts: { recipient_name: string; sender_from_name: string }): string {
  return BODY_TEMPLATE
    .replace(/\{\{recipient_name\}\}/g, opts.recipient_name)
    .replace(/\{\{sender_from_name\}\}/g, opts.sender_from_name);
}
