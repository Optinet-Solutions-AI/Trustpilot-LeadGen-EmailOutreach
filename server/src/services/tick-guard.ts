/**
 * Stop a polling loop from running on top of itself.
 *
 * `setInterval` fires on schedule whether or not the previous tick finished.
 * Both send loops poll every 60 seconds and can easily take longer, so ticks
 * overlapped — and because each tick loads its own snapshot of per-mailbox
 * send counts at the start, every overlapping tick independently believed the
 * mailbox had room and sent up to the cap again.
 *
 * Measured 2026-09-19: 17 follow-ups left in 1.6 seconds from one instance,
 * on a loop that paces sends 2 seconds apart. Two mailboxes reached 25 sends
 * against a cap of 20, and 70 emails went out against a ceiling of 60.
 *
 * This guards one process. The service runs up to 10 instances, so it is not
 * the whole answer on its own — sends are also claimed in the database, which
 * is what holds the line across instances.
 */

export function exclusive<T>(
  fn: () => Promise<T>,
  label: string,
  log: (message: string) => void = console.log,
): () => Promise<T | undefined> {
  let running = false;

  return async (): Promise<T | undefined> => {
    if (running) {
      log(`[${label}] previous tick still running — skipping this one`);
      return undefined;
    }
    running = true;
    try {
      return await fn();
    } finally {
      // Always released. A tick that throws must not wedge the loop shut for
      // the lifetime of the process.
      running = false;
    }
  };
}
