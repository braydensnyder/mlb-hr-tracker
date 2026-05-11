-- =====================================================================
-- Migration 001 — matchup context
-- Adds handedness, venue, and probable-pitcher columns. Idempotent.
-- Apply on top of an existing DB. Fresh installs already include these
-- columns (see ../schema.sql).
-- =====================================================================

-- ---- home_runs: per-event matchup context ----
alter table public.home_runs
  add column if not exists batter_side    text,   -- 'L' | 'R' | 'S' (per-AB side)
  add column if not exists pitcher_throws text,   -- 'L' | 'R'
  add column if not exists venue_name     text;

create index if not exists home_runs_pitcher_id_idx on public.home_runs (pitcher_id);
create index if not exists home_runs_pitcher_date_idx on public.home_runs (pitcher_id, game_date desc);
create index if not exists home_runs_venue_date_idx on public.home_runs (venue_name, game_date desc);
create index if not exists home_runs_batter_side_idx on public.home_runs (batter_side);
create index if not exists home_runs_pitcher_throws_idx on public.home_runs (pitcher_throws);

-- ---- games: venue + probable pitchers (filled by fetchSchedule going forward) ----
alter table public.games
  add column if not exists venue_name                  text,
  add column if not exists home_probable_pitcher_id    bigint,
  add column if not exists home_probable_pitcher_name  text,
  add column if not exists home_probable_pitcher_hand  text,  -- 'L' | 'R'
  add column if not exists away_probable_pitcher_id    bigint,
  add column if not exists away_probable_pitcher_name  text,
  add column if not exists away_probable_pitcher_hand  text;

create index if not exists games_venue_idx on public.games (venue_name);
