-- =====================================================================
-- Migration 008 — snapshot_type column on hr_target_snapshots
--
-- Distinguishes 'live' pre-game snapshots from 'simulated' historical
-- backfills (where we don't truly know what the model would have said
-- at the time, just what it says now using data filtered to ≤ asOf).
--
-- Default 'live' so existing rows are correctly labeled — they were all
-- taken via the live update:daily path before this column existed.
--
-- Idempotent. No data is touched.
-- =====================================================================

ALTER TABLE public.hr_target_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_type text NOT NULL DEFAULT 'live';

-- Optional: a CHECK constraint to keep snapshot_type values clean.
-- Use DO block so we can add it idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hr_target_snapshots_snapshot_type_check'
  ) THEN
    ALTER TABLE public.hr_target_snapshots
      ADD CONSTRAINT hr_target_snapshots_snapshot_type_check
      CHECK (snapshot_type IN ('live', 'simulated'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS hr_target_snapshots_snapshot_type_idx
  ON public.hr_target_snapshots (snapshot_type);

NOTIFY pgrst, 'reload schema';
