/**
 * Whether a fetched reply body can be acted on.
 *
 * The body arrives in a second IMAP round-trip after a message matches a lead.
 * When that fetch failed, the caller used to fall back to an empty string and
 * carry on — recording the reply with a null snippet, running the bounce and
 * auto-reply classifiers against nothing, and burning the only chance to read
 * the message: `markReplied` matches rows at status='sent', so once flipped no
 * later poll can revisit it.
 *
 * "We could not read it" and "we read it and it was empty" are different
 * facts. Only the second is safe to record; the first must leave the row
 * untouched so the next poll tries again.
 */

export type ReplyBodyAssessment =
  | { usable: true; body: string }
  | { usable: false; reason: 'fetch_failed' };

export function assessReplyBody(
  fetchSucceeded: boolean,
  body: string | null | undefined,
): ReplyBodyAssessment {
  // A failed fetch is never rescued by whatever partial text came with it —
  // classifying against half a message is how an out-of-office became a
  // genuine reply.
  if (!fetchSucceeded) return { usable: false, reason: 'fetch_failed' };
  return { usable: true, body: body ?? '' };
}
