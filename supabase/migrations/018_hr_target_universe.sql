-- =====================================================================
-- Migration 018 — Canonical hitter universe (per-date, per-model)
--
-- The `hr_target_snapshots` table (mig 007) persists only the top-50
-- rows per date. That means:
--   • players ranked 9+ per team are silently dropped during scoring
--   • players ranked 51+ globally are dropped at write time
--   • zero-HR confirmed starters are never candidates at all
--   • we CAN'T backtest "where did the missed HR hitter rank?" because
--     the row doesn't exist
--
-- `hr_target_universe` fixes those gaps. For each (target_date,
-- player_id, model_version) we persist ONE row for EVERY candidate:
--   • confirmed/pending starter from games.home_lineup / away_lineup
--   • player with ≥1 season HR on a team playing that day
-- The two sets are UNION'd. Duplicates merge.
--
-- Storing subscores + signals as structured JSON means future weight
-- replays don't have to reconstruct anything from reason text.
--
-- Does NOT replace `hr_target_snapshots`. Existing writers, readers,
-- and backtest code paths keep working exactly as they do today. This
-- table is additive.
--
-- Idempotent — safe to re-run.
-- =====================================================================

create table if not exists public.hr_target_universe (
  id                bigserial primary key,
  target_date       date        not null,
  snapshot_at       timestamptz not null default now(),
  model_version     int         not null default 1 references public.model_versions(version),

  -- Player identity
  player_id         int         not null,
  player_name       text        not null,
  team              text        not null,
  opponent          text,
  game_pk           int,

  -- Rankings
  global_rank       int         not null,   -- 1..N across all candidates
  team_rank         int         not null,   -- 1..K within team

  -- Score + lineup context
  heat_score        numeric     not null,
  lineup_status     text        not null,   -- 'confirmed' | 'pending' | 'not_starting' | 'postponed' | 'unknown'

  -- Structured subscore breakdown (mirrors HrTargetSubscores in stats.ts).
  -- Keys: l3, l5, l7d, season, pitcher, park, hand, weather, plus
  -- 'contributions' sub-object with per-component numeric contributions
  -- AFTER stability/completeness/ceiling multipliers.
  subscores_json    jsonb       not null default '{}'::jsonb,

  -- Chip signals mirror what learning_predictions.signals_json stores.
  -- Boolean map: {hr_pitcher: true, power_park: false, ...}
  signals_json      jsonb       not null default '{}'::jsonb,

  -- Full reason text (chip labels joined by ' · '). Human-readable
  -- fallback when signals_json isn't enough.
  reason            text,

  -- Optional odds captured at snapshot time (best-effort — snapshot
  -- writer will fill from odds_snapshots when available for the date).
  american_odds     int,
  implied_prob      numeric,

  -- Validation / doubleheader / malformed-data flags.
  -- e.g. 'doubleheader_second_game', 'lineup_larger_than_9', 'no_probable_pitcher'
  flags             text[]      not null default '{}',

  created_at        timestamptz not null default now(),

  unique (target_date, player_id, model_version)
);

create index if not exists htu_date_model_rank_idx
  on public.hr_target_universe (target_date, model_version, global_rank);

create index if not exists htu_date_team_rank_idx
  on public.hr_target_universe (target_date, team, team_rank);

create index if not exists htu_date_status_idx
  on public.hr_target_universe (target_date, lineup_status);

create index if not exists htu_player_idx
  on public.hr_target_universe (player_id);

-- Anon read policy — the frontend reads this table for the new
-- rank-bucket analyses. Writes only happen from scripts using the
-- service-role key.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'hr_target_universe' and policyname = 'allow_anon_read'
  ) then
    execute 'create policy allow_anon_read on public.hr_target_universe for select to anon using (true)';
  end if;
end$$;

alter table public.hr_target_universe enable row level security;
