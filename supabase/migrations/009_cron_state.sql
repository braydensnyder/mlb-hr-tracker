-- =====================================================================
-- Migration 009 — cron_state singleton
--
-- Backs the single smart hourly cron (`/api/cron/update`). One row,
-- id = 1, that persists across cron invocations so the endpoint can:
--   - decide the work tier (light / full / night) from the clock + how
--     long it's been since the last heavy run
--   - hold a lightweight lock to prevent overlapping runs
--   - record what each run did for the dashboard / cron-response JSON
--
-- Idempotent. Safe to re-run.
-- =====================================================================

create table if not exists public.cron_state (
  -- Singleton guard: there is exactly one row, always id = 1.
  id                 int primary key default 1 check (id = 1),

  -- When the last cron run finished (any tier).
  last_run_at        timestamptz,
  -- The tier that ran last: 'light' | 'full' | 'night'.
  last_run_mode      text,

  -- When the last HEAVY run finished (tier 'full' or 'night'). The
  -- decideMode() logic uses this to throttle heavy rebuilds to ≈ every 6h.
  last_heavy_run_at  timestamptz,
  -- When the last NIGHT/final run finished. Used to ensure night runs
  -- at most once per UTC day.
  last_night_run_at  timestamptz,

  -- Lightweight lock. `running` is flipped true while a run is in
  -- flight; `lock_acquired_at` lets a later run steal a stale lock
  -- (older than ~15 min) so a crashed run can't wedge the system.
  running            boolean      not null default false,
  lock_acquired_at   timestamptz,

  -- Monotonic counter — handy for sanity-checking the cron is firing.
  run_count          bigint       not null default 0
);

-- Seed the singleton row. on conflict do nothing → safe to re-run.
insert into public.cron_state (id) values (1)
on conflict (id) do nothing;
