-- =====================================================================
-- Migration 012 — confirmed lineups on games
--
-- Stores the official starting batting order per side so HR Targets can
-- filter out players who aren't actually starting. Source: the MLB live
-- feed's boxscore.teams.{home,away}.battingOrder, populated ~2–4 hours
-- before first pitch.
--
--   home_lineup / away_lineup  — int[] of starter player_ids (9 when
--                                posted, empty until then)
--   lineups_confirmed          — true once BOTH sides have a 9-man order
--   lineups_updated_at         — when enrichLineups last wrote this row
--
-- Player lineup status is DERIVED in the frontend from these arrays +
-- games.status (no per-player column needed): in the array = starter,
-- array posted but not in it = not starting, array empty = pending.
--
-- Idempotent.
-- =====================================================================

alter table public.games
  add column if not exists home_lineup        jsonb,
  add column if not exists away_lineup        jsonb,
  add column if not exists lineups_confirmed  boolean not null default false,
  add column if not exists lineups_updated_at timestamptz;

create index if not exists games_lineups_confirmed_idx
  on public.games (game_date, lineups_confirmed);
