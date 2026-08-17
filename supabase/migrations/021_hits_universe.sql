-- =====================================================================
-- Migration 021 — Hits universe + frozen snapshots
--
-- Two tables mirroring the HR pattern (hr_target_universe +
-- hr_target_snapshots) but for the parallel Hits tab. Every row
-- carries independent 1+ and 2+ ranker outputs and records the exact
-- frozen model_config_id + hash that produced each ranker's score, so
-- historical rankings are always reproducible.
--
-- ISOLATION CONTRACT
--   - This migration only creates NEW tables. It does not touch
--     hr_target_universe, hr_target_snapshots, home_runs,
--     learning_predictions, or any other HR-side table.
--   - Writers here (scripts/snapshotHitTargets.ts, later phases) read
--     from player_batting_lines, player_daily_hit_summary,
--     pitcher_form, players, and games — all shared data-layer tables.
--   - No HR scoring code reads from these tables.
--
-- WHY TWO TABLES
--   hit_target_universe   — LIVE view. Force-cleaned per snapshot run
--                           so the /hits page always reflects the
--                           freshest scoring. Consumers: today's board.
--   hit_target_snapshots  — FROZEN pregame archive. Written once per
--                           (target_date, player_id, model_version)
--                           at pregame time; rank/score/contributions
--                           are never mutated post-firstpitch. Outcome
--                           columns (hits, at_bats, hit_1plus, etc.)
--                           are filled by the outcome-enrichment pass.
--                           Consumers: Hits Backtest + drilldown.
--
-- WHY PER-RANKER MODEL STAMPS
--   Each row records model_config_id_1plus + model_config_hash_1plus
--   AND model_config_id_2plus + model_config_hash_2plus separately.
--   The 1+ and 2+ rankers are independent — they can be promoted /
--   updated on different cadences, and joining a row back to its
--   scoring config must survive that.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. hit_target_universe — live/working table
-- ---------------------------------------------------------------------

create table if not exists public.hit_target_universe (
  id                     bigserial primary key,
  target_date            date        not null,
  captured_at            timestamptz not null default now(),
  model_version          int         not null default 1,

  -- Reproducibility stamps — one per ranker so 1+ and 2+ can evolve
  -- independently. hash = fnv1a32 of the canonical frozen config JSON
  -- (see src/lib/hitModels.ts). id is the human-readable version tag.
  model_config_id_1plus     text not null,
  model_config_hash_1plus   text not null,
  model_config_id_2plus     text not null,
  model_config_hash_2plus   text not null,

  -- Player identity
  player_id     int  not null,
  player_name   text not null,
  team          text not null,
  opponent      text,
  game_pk       int,

  -- Lineup context (all captured at snapshot time — never inferred later)
  batting_order_slot     smallint,      -- 1..9 or NULL for bench/sub
  lineup_status          text not null, -- 'confirmed'|'pending'|'not_starting'|'postponed'|'unknown'
  opposing_starter_id    int,
  opposing_starter_hand  text,          -- 'L'|'R'|NULL

  -- 1+ ranker outputs (independent from 2+)
  hit_score_1plus        numeric,
  hit_prob_1plus         numeric,
  rank_1plus             int,           -- global rank across the eligible universe
  team_rank_1plus        int,           -- 1..K within team
  contributions_1plus_json jsonb not null default '{}'::jsonb,
  confidence_1plus       text,          -- 'high'|'medium'|'low'

  -- 2+ ranker outputs (independent from 1+)
  hit_score_2plus        numeric,
  hit_prob_2plus         numeric,
  rank_2plus             int,
  team_rank_2plus        int,
  contributions_2plus_json jsonb not null default '{}'::jsonb,
  confidence_2plus       text,

  -- Diagnostics (data-quality flags, no-lineup, no-starter, etc.)
  flags                  text[] not null default '{}',

  unique (target_date, player_id, model_version)
);

create index if not exists htu_hits_date_model_1plus_rank_idx
  on public.hit_target_universe (target_date, model_version, rank_1plus);
create index if not exists htu_hits_date_model_2plus_rank_idx
  on public.hit_target_universe (target_date, model_version, rank_2plus);
create index if not exists htu_hits_date_team_idx
  on public.hit_target_universe (target_date, team);
create index if not exists htu_hits_player_date_idx
  on public.hit_target_universe (player_id, target_date desc);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'hit_target_universe' and policyname = 'allow_anon_read'
  ) then
    execute 'create policy allow_anon_read on public.hit_target_universe for select to anon using (true)';
  end if;
end$$;
alter table public.hit_target_universe enable row level security;

comment on column public.hit_target_universe.model_config_hash_1plus is
  'FNV-1a 32-bit hex of the canonical frozen 1+ config JSON. Any change '
  'to features / weights / standardisation produces a different hash. '
  'Guarantees historical rows can be tied back to the exact scoring config.';


-- ---------------------------------------------------------------------
-- 2. hit_target_snapshots — frozen pregame archive
-- ---------------------------------------------------------------------
--
-- Same column set as hit_target_universe, PLUS:
--   - snapshot_at, pregame_run_at, snapshot_type
--   - outcome enrichment columns (nullable pregame; filled post-game
--     by the enrichment pass from player_batting_lines)
--
-- Rank / score / contributions / model stamps are IMMUTABLE after the
-- pregame write. Only the outcome columns get updated by the
-- enrichment pass — the same freeze principle as pregame v7.

create table if not exists public.hit_target_snapshots (
  id                     bigserial primary key,
  target_date            date        not null,
  snapshot_at            timestamptz not null default now(),
  pregame_run_at         timestamptz not null,
  snapshot_type          text        not null default 'pregame',  -- 'pregame'|'simulated'
  model_version          int         not null default 1,

  model_config_id_1plus     text not null,
  model_config_hash_1plus   text not null,
  model_config_id_2plus     text not null,
  model_config_hash_2plus   text not null,

  player_id     int  not null,
  player_name   text not null,
  team          text not null,
  opponent      text,
  game_pk       int,

  batting_order_slot     smallint,
  lineup_status          text not null,
  opposing_starter_id    int,
  opposing_starter_hand  text,

  hit_score_1plus        numeric,
  hit_prob_1plus         numeric,
  rank_1plus             int,
  team_rank_1plus        int,
  contributions_1plus_json jsonb not null default '{}'::jsonb,
  confidence_1plus       text,

  hit_score_2plus        numeric,
  hit_prob_2plus         numeric,
  rank_2plus             int,
  team_rank_2plus        int,
  contributions_2plus_json jsonb not null default '{}'::jsonb,
  confidence_2plus       text,

  flags                  text[] not null default '{}',

  -- ---- OUTCOME ENRICHMENT (nullable pregame) ----
  hits                   int,
  at_bats                int,
  hit_1plus              boolean,    -- convenience: hits >= 1
  hit_2plus              boolean,    -- convenience: hits >= 2
  doubles                int,
  triples                int,
  outcome_enriched_at    timestamptz,

  unique (target_date, player_id, model_version)
);

create index if not exists hts_hits_date_model_1plus_rank_idx
  on public.hit_target_snapshots (target_date, model_version, rank_1plus);
create index if not exists hts_hits_date_model_2plus_rank_idx
  on public.hit_target_snapshots (target_date, model_version, rank_2plus);
create index if not exists hts_hits_date_team_idx
  on public.hit_target_snapshots (target_date, team);
create index if not exists hts_hits_player_date_idx
  on public.hit_target_snapshots (player_id, target_date desc);
create index if not exists hts_hits_outcome_enriched_idx
  on public.hit_target_snapshots (target_date, outcome_enriched_at);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'hit_target_snapshots' and policyname = 'allow_anon_read'
  ) then
    execute 'create policy allow_anon_read on public.hit_target_snapshots for select to anon using (true)';
  end if;
end$$;
alter table public.hit_target_snapshots enable row level security;

comment on table public.hit_target_snapshots is
  'Frozen pregame Hits archive. Rank/score/contributions/model stamps are '
  'immutable after the initial pregame write. Only the outcome columns '
  '(hits, at_bats, hit_1plus, hit_2plus, doubles, triples, '
  'outcome_enriched_at) are populated by the post-game enrichment pass '
  '(scripts/enrichHitOutcomes.ts). Consumers: Hits Backtest + drilldown.';

comment on column public.hit_target_snapshots.snapshot_type is
  'pregame  — written before first pitch, canonical audit record. '
  'simulated — post-game reconstruction when a legitimate pregame '
  'snapshot was not captured (rare; flagged for the operator).';
