-- =====================================================================
-- Migration 010 — weather_updated_at column on games
--
-- Adds a timestamp that records when enrichWeather last successfully
-- wrote weather columns for a game. Lets the cron-response JSON, the
-- Dashboard "Weather pending" UI, and the HR Targets weather tile show
-- HOW FRESH the weather is — and tell apart "no weather block yet"
-- (weather_updated_at IS NULL) from "wrote weather hours ago, may be stale"
-- (weather_updated_at far in the past).
--
-- Idempotent.
-- =====================================================================

alter table public.games
  add column if not exists weather_updated_at timestamptz;

-- Index so dashboards can quickly find "freshest weather across today's games"
-- without a full table scan.
create index if not exists games_weather_updated_at_idx
  on public.games (weather_updated_at desc nulls last);
