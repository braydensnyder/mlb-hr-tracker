-- =====================================================================
-- Migration 004 — gameType + weather placeholder columns on games
--
-- - `game_type` lets the ingest filter out non-MLB game types (WBC,
--   exhibitions, All-Star) that would otherwise pollute team strings
--   with country names like "United States."
-- - `weather` columns are placeholders. The HR Heat Score reserves a
--   `weather` weight (currently 0) so the formula is ready to receive
--   actual data without changing shape. No fetcher is wired yet.
--
-- Idempotent.
-- =====================================================================

alter table public.games
  add column if not exists game_type           text,
  add column if not exists weather             jsonb,
  add column if not exists weather_temp_f      numeric(5,2),
  add column if not exists weather_wind_mph    numeric(5,2),
  add column if not exists weather_wind_dir    text;

create index if not exists games_game_type_idx on public.games (game_type);
