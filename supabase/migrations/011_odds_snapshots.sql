-- =====================================================================
-- Migration 011 — odds_snapshots: HR prop odds history
--
-- Phase 1 of the Odds tab. We DO NOT let sportsbook odds influence the
-- HR Heat Score yet — this table is purely for tracking + comparison.
-- Each row is one (book, player, game, snapshot_type) tuple captured at
-- a specific moment so we can compute line movement and compare against
-- the model's Heat Score / model probability.
--
-- snapshot_type buckets:
--   'morning'  — first snapshot of the MLB/Pacific day (~9 AM PT)
--   'midday'   — second snapshot (~1 PM PT)
--   'pregame'  — last snapshot before first pitch (~30 min pre-game)
--   'manual'   — operator-run via the CLI; never auto-overwritten
--
-- The smart cron decides which bucket fires using the Pacific clock and
-- a "did we already take a {type} snapshot today?" check against
-- (target_date, snapshot_type).
--
-- Idempotent. Safe to re-run.
-- =====================================================================

create table if not exists public.odds_snapshots (
  id                bigserial primary key,
  -- The MLB/Pacific game date the prop is FOR.
  target_date       date not null,
  -- The snapshot bucket (see header).
  snapshot_type     text not null check (snapshot_type in ('morning', 'midday', 'pregame', 'manual')),
  -- When the row was actually written (timestamptz).
  snapshot_time     timestamptz not null default now(),

  -- Game + player identity.
  game_pk           bigint not null,
  player_id         bigint,                   -- nullable when the book name didn't match our roster
  player_name       text   not null,          -- exact string the book returned, for traceability
  team              text,
  opponent          text,

  -- Book + market.
  book              text not null,            -- 'draftkings' | 'fanduel' | 'betmgm' | ...
  market_key        text not null default 'batter_home_runs',

  -- Odds, in three forms — easier to query / display than re-deriving.
  american_odds     integer not null,         -- +450, -120 — what the book displays
  decimal_odds      numeric(10, 4) not null,  -- 5.5, 1.83
  implied_prob      numeric(6, 4) not null,   -- 0.18 → 18% (already vig-included)

  -- Model snapshot at the moment we captured the odds — lets us replay
  -- "what did our model think when this line was X?" without re-running.
  heat_score        numeric(5, 2),
  confidence        text,
  model_prob        numeric(6, 4),            -- 0..1, our derived HR probability
  edge              numeric(7, 4),            -- model_prob - implied_prob (signed)

  -- Optional weather context, denormalized for the historical record.
  weather_temp_f    numeric(5, 2),
  weather_wind_mph  numeric(5, 2),
  weather_wind_dir  text,

  created_at        timestamptz not null default now()
);

-- One row per (target_date, snapshot_type, game_pk, player_id, book).
-- The model snapshot inside a bucket is immutable — re-running the
-- snapshot script should be idempotent. Use upsert (insert .. on conflict).
create unique index if not exists odds_snapshots_dedup_idx
  on public.odds_snapshots (target_date, snapshot_type, game_pk, player_id, book);

-- Hot-path queries: "show me everything for today, sorted by player".
create index if not exists odds_snapshots_target_date_idx
  on public.odds_snapshots (target_date desc, snapshot_type);

create index if not exists odds_snapshots_player_target_idx
  on public.odds_snapshots (player_id, target_date desc);

-- For "did the line move? did the player homer?" backtest joins.
create index if not exists odds_snapshots_game_pk_idx
  on public.odds_snapshots (game_pk);

-- RLS — same shape as other tables: anon can read, service-role writes.
alter table public.odds_snapshots enable row level security;

drop policy if exists "odds_snapshots read" on public.odds_snapshots;
create policy "odds_snapshots read"
  on public.odds_snapshots for select
  to anon
  using (true);
