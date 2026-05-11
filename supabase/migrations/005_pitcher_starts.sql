-- =====================================================================
-- Migration 005 — pitcher_starts
--
-- One row per (pitcher_id, game_pk) for every PITCHER WHO STARTED a game.
-- Why it exists: home_runs only records games where a pitcher gave up a HR,
-- so "L3 starts HR allowed" computed from home_runs alone is misleading —
-- a start with 0 HR allowed simply doesn't appear there. This table is the
-- canonical record of every start, including 0-HR starts, so the HR Targets
-- page can compute accurate pitcher form (HR allowed L3 starts / L5 starts /
-- L14d / season).
--
-- Populated by:
--   - processDate (going forward) — reads the boxscore alongside HR extraction
--   - enrich:pitcher-starts (backfill) — iterates existing game_pks
--
-- Idempotent.
-- =====================================================================

create table if not exists public.pitcher_starts (
  pitcher_id     bigint       not null,
  game_pk        bigint       not null,
  game_date      date         not null,
  pitcher_name   text,
  team           text,
  team_id        bigint,
  pitcher_throws text,        -- 'L' | 'R'
  hr_allowed     int          not null default 0,
  outs_recorded  int,         -- IP * 3 (e.g. 18 = 6.0 IP)
  earned_runs    int,
  hits_allowed   int,
  walks          int,
  strikeouts     int,
  batters_faced  int,
  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now(),
  primary key (pitcher_id, game_pk)
);

create index if not exists pitcher_starts_pitcher_date_idx
  on public.pitcher_starts (pitcher_id, game_date desc);
create index if not exists pitcher_starts_date_idx
  on public.pitcher_starts (game_date);
create index if not exists pitcher_starts_game_pk_idx
  on public.pitcher_starts (game_pk);

drop trigger if exists trg_pitcher_starts_touch on public.pitcher_starts;
create trigger trg_pitcher_starts_touch
  before update on public.pitcher_starts
  for each row execute function public.touch_updated_at();

alter table public.pitcher_starts enable row level security;
drop policy if exists "public read pitcher_starts" on public.pitcher_starts;
create policy "public read pitcher_starts" on public.pitcher_starts for select using (true);
