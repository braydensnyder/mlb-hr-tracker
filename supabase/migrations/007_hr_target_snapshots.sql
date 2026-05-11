-- =====================================================================
-- Migration 007 — hr_target_snapshots (canonical shape).
--
-- Persisted Top-N HR target rankings, one row per snapshot of
-- (target_date, player_id, game_pk). Lets the Backtest page compare
-- a date's predicted top hitters against actual HRs in `home_runs`.
--
-- Surrogate PK = `id bigserial`. Uniqueness on (target_date, player_id,
-- game_pk). `snapshot_date` records when the row was written; this is a
-- timestamp distinct from `target_date` (the day games are being
-- predicted for).
--
-- Idempotent. Safe to re-run. No existing data is deleted.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.hr_target_snapshots (
  id             bigserial    PRIMARY KEY,
  target_date    date         NOT NULL,
  snapshot_date  timestamptz  NOT NULL DEFAULT now(),
  player_id      bigint       NOT NULL,
  player_name    text         NOT NULL,
  team           text         NOT NULL,
  opponent       text         NOT NULL,
  game_pk        bigint       NOT NULL,
  rank           int          NOT NULL,
  heat_score     numeric(5,1) NOT NULL,
  reason         text,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT hr_target_snapshots_target_player_game_uq
    UNIQUE (target_date, player_id, game_pk)
);

-- Idempotent column adds — handles upgrades from an earlier shape.
ALTER TABLE public.hr_target_snapshots
  ADD COLUMN IF NOT EXISTS id             bigserial,
  ADD COLUMN IF NOT EXISTS target_date    date,
  ADD COLUMN IF NOT EXISTS snapshot_date  timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS player_id      bigint,
  ADD COLUMN IF NOT EXISTS player_name    text,
  ADD COLUMN IF NOT EXISTS team           text,
  ADD COLUMN IF NOT EXISTS opponent       text,
  ADD COLUMN IF NOT EXISTS game_pk        bigint,
  ADD COLUMN IF NOT EXISTS rank           int,
  ADD COLUMN IF NOT EXISTS heat_score     numeric(5,1),
  ADD COLUMN IF NOT EXISTS reason         text,
  ADD COLUMN IF NOT EXISTS created_at     timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS hr_target_snapshots_target_date_idx ON public.hr_target_snapshots (target_date);
CREATE INDEX IF NOT EXISTS hr_target_snapshots_rank_idx        ON public.hr_target_snapshots (rank);
CREATE INDEX IF NOT EXISTS hr_target_snapshots_player_id_idx   ON public.hr_target_snapshots (player_id);
CREATE INDEX IF NOT EXISTS hr_target_snapshots_heat_score_idx  ON public.hr_target_snapshots (heat_score DESC);

ALTER TABLE public.hr_target_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read hr_target_snapshots" ON public.hr_target_snapshots;
CREATE POLICY "public read hr_target_snapshots"
  ON public.hr_target_snapshots FOR SELECT USING (true);

NOTIFY pgrst, 'reload schema';
