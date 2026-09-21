-- Scheduler leader lock.
--
-- The send loops run on every Cloud Run instance, and the service scales to
-- 10. Each instance judged the per-mailbox cap against its own snapshot, so
-- N instances could each permit a full cap: on 2026-09-19 two mailboxes
-- reached 25 against a cap of 20 and 70 emails went out against a ceiling of
-- 60. An in-process guard cannot see the other instances; this can.
--
-- Acquire is a plain INSERT on the primary key, or an UPDATE that only
-- matches an expired row. Both are single atomic statements, so exactly one
-- instance wins. The lock carries an expiry rather than relying on release,
-- because an instance can be killed mid-tick and must not hold it for ever.

create table if not exists scheduler_locks (
  name         text primary key,
  holder       text        not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null
);

comment on table scheduler_locks is
  'Leader election for background loops. One row per loop; holder is an instance id; expires_at lets a dead holder be taken over.';

-- Taking over an expired lock is the common path after a restart, so keep it
-- indexed rather than scanning a table that will only ever hold a few rows.
create index if not exists idx_scheduler_locks_expires_at
  on scheduler_locks (expires_at);
