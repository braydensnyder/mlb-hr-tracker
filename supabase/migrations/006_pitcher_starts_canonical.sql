-- =====================================================================
-- Migration 006 — pitcher_starts (canonical shape)
--
-- Supersedes 005_pitcher_starts.sql. Earlier migration used different
-- column names (game_pk, pitcher_throws, hr_allowed, outs_recorded);
-- this migration is the authoritative shape going forward.
--
-- If migration 005 was applied, this script ADDs the new columns
-- alongside the old ones — you can keep both or drop the old columns
-- manually afterwards. If 005 was never applied (most users), this
-- creates the table fresh.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.pitcher_starts (
  game_id            bigint       NOT NULL,
  game_date          date         NOT NULL,
  pitcher_id         bigint       NOT NULL,
  pitcher_name       text,
  pitcher_hand       text,
  team_id            bigint,
  team_name          text,
  opponent_id        bigint,
  opponent_name      text,
  venue_id           bigint,
  venue_name         text,
  innings_pitched    numeric(4,1),
  hits_allowed       int,
  earned_runs        int,
  home_runs_allowed  int          NOT NULL DEFAULT 0,
  walks              int,
  strikeouts         int,
  pitches            int,
  decision           text,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, pitcher_id)
);

-- If the table already existed (from migration 005's old shape), add the
-- new columns. ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE public.pitcher_starts
  ADD COLUMN IF NOT EXISTS game_id            bigint,
  ADD COLUMN IF NOT EXISTS pitcher_hand       text,
  ADD COLUMN IF NOT EXISTS team_name          text,
  ADD COLUMN IF NOT EXISTS opponent_id        bigint,
  ADD COLUMN IF NOT EXISTS opponent_name      text,
  ADD COLUMN IF NOT EXISTS venue_id           bigint,
  ADD COLUMN IF NOT EXISTS venue_name         text,
  ADD COLUMN IF NOT EXISTS innings_pitched    numeric(4,1),
  ADD COLUMN IF NOT EXISTS home_runs_allowed  int,
  ADD COLUMN IF NOT EXISTS pitches            int,
  ADD COLUMN IF NOT EXISTS decision           text;

CREATE INDEX IF NOT EXISTS pitcher_starts_pitcher_id_idx       ON public.pitcher_starts (pitcher_id);
CREATE INDEX IF NOT EXISTS pitcher_starts_game_date_idx        ON public.pitcher_starts (game_date DESC);
CREATE INDEX IF NOT EXISTS pitcher_starts_pitcher_date_idx     ON public.pitcher_starts (pitcher_id, game_date DESC);
CREATE INDEX IF NOT EXISTS pitcher_starts_hr_allowed_idx       ON public.pitcher_starts (home_runs_allowed);

ALTER TABLE public.pitcher_starts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read pitcher_starts" ON public.pitcher_starts;
CREATE POLICY "public read pitcher_starts" ON public.pitcher_starts FOR SELECT USING (true);

NOTIFY pgrst, 'reload schema';
