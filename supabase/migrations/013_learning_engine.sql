-- =====================================================================
-- Migration 013 — Learning Engine foundation
--
-- Builds the persistent feedback loop that lets the model learn from
-- every completed slate.
--
--   model_versions       — every weight configuration that was ever
--                          active. Never overwrite — append a new row
--                          each time weights change. Stores config in
--                          weights_json so backtests can replay any
--                          version exactly.
--
--   learning_predictions — one row per (target_date, player_id, version)
--                          for every eligible player in the snapshot.
--                          Stores the pre-game signal set + parlay
--                          membership + the outcome (homered?) + the
--                          binary classification (TP/FP/FN/TN).
--
--   feature_importance   — per-signal correlation with HR outcomes,
--                          computed over a rolling window. Refreshed by
--                          the capture script after each completed day.
--                          A signal that consistently shows up among
--                          HR hitters across many days has earned its
--                          weight; one that doesn't hasn't.
--
-- All tables are SURFACED ONLY. Nothing here auto-updates HEAT_SCORE_WEIGHTS.
-- Phase 3 (auto-optimization) requires a follow-up schema change to save
-- subscores per snapshot — deferred.
--
-- Idempotent. Run from Supabase SQL editor.
-- =====================================================================

-- ---------- 1) model_versions ----------
create table if not exists public.model_versions (
  version          int primary key,                        -- monotonically increasing
  name             text not null,                          -- 'v1 baseline (2026-06)'
  created_at       timestamptz not null default now(),
  weights_json     jsonb not null,                         -- full config
  notes            text,
  active           boolean not null default false,         -- exactly one row should be true
  -- Roll-up metrics filled by the capture script:
  parlays_built       int,
  full_3of3_hits      int,
  partial_2of3_hits   int,
  per_leg_hit_rate    numeric,
  pool_coverage_rate  numeric,
  top10_coverage_rate numeric,
  last_evaluated_for  date
);

create index if not exists model_versions_active_idx on public.model_versions (active) where active = true;

-- Seed v1 with the current live weights if no version exists yet.
insert into public.model_versions (version, name, weights_json, notes, active)
select 1,
       'v1 baseline (initial)',
       jsonb_build_object(
         'heat_score_weights', jsonb_build_object(
           'season', 35, 'l3', 14, 'l5', 8, 'l7d', 3,
           'pitcher', 20, 'park', 10, 'hand', 10, 'weather', 0
         ),
         'cold_penalty',        jsonb_build_object('elite', -8, 'mid', -4),
         'low_power_cap',       34,
         'lineup_pending_penalty', -5,
         'parlay', jsonb_build_object(
           'safe_heat_min',   55,
           'safe_odds_max',   400,
           'value_heat_min',  50,
           'value_odds_min',  250,
           'value_odds_max',  600,
           'value_edge_min',  0.02,
           'chaos_rank_max',  80,
           'chaos_odds_min',  500,
           'chaos_chip_min',  2
         )
       ),
       'Seeded by migration 013. Mirrors the constants in src/lib/stats.ts at the time of migration.',
       true
where not exists (select 1 from public.model_versions);

-- ---------- 2) learning_predictions ----------
create table if not exists public.learning_predictions (
  id                bigserial primary key,
  target_date       date    not null,
  player_id         int     not null,
  model_version     int     not null references public.model_versions(version),
  -- Pre-game state (what the model knew before first pitch):
  player_name       text    not null,
  team              text    not null,
  opponent          text,
  game_pk           int,
  rank              int,                       -- model rank that day (1-based)
  heat_score        numeric,
  model_prob        numeric,                   -- sigmoid(heat_score)
  reason            text,                      -- saved reason chip recap
  signals_json      jsonb   not null default '{}'::jsonb, -- {hr_pitcher: true, ...}
  in_safe           boolean not null default false,
  in_value          boolean not null default false,
  in_chaos          boolean not null default false,
  -- Outcome (filled after games complete):
  homered           boolean,
  hr_count          int,
  -- Classification = TP/FP/FN/TN. NULL until outcome known.
  classification    text check (classification in ('TP','FP','FN','TN') or classification is null),
  captured_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (target_date, player_id, model_version)
);

create index if not exists learning_predictions_date_idx       on public.learning_predictions (target_date);
create index if not exists learning_predictions_class_idx      on public.learning_predictions (classification);
create index if not exists learning_predictions_version_idx    on public.learning_predictions (model_version);
create index if not exists learning_predictions_player_idx     on public.learning_predictions (player_id);

-- ---------- 3) feature_importance ----------
create table if not exists public.feature_importance (
  id                bigserial primary key,
  model_version     int     not null references public.model_versions(version),
  window_days       int     not null,                       -- 7 / 14 / 30 / 60
  computed_for      date    not null,                       -- right-edge anchor
  signal_key        text    not null,                       -- 'hr_pitcher', etc.
  signal_label      text    not null,
  -- Aggregate stats over the window:
  n_present         int     not null,
  hits_present      int     not null,
  rate_present      numeric not null,
  n_absent          int     not null,
  hits_absent       int     not null,
  rate_absent       numeric not null,
  lift              numeric not null,                       -- rate_present / baseline_rate
  -- Cohen's h | sample_quality drives confidence:
  importance_score  numeric not null,                       -- abs Cohen's h, 0..pi
  sample_quality    text    not null check (sample_quality in ('high','medium','low')),
  created_at        timestamptz not null default now(),
  unique (model_version, window_days, computed_for, signal_key)
);

create index if not exists feature_importance_lookup_idx
  on public.feature_importance (model_version, window_days, computed_for);

-- ---------- 4) Anon read policies (frontend reads these) ----------
do $$
begin
  if exists (select 1 from pg_policies where tablename = 'model_versions' and policyname = 'allow_anon_read') then
    null;
  else
    execute 'create policy allow_anon_read on public.model_versions for select to anon using (true)';
  end if;
  if exists (select 1 from pg_policies where tablename = 'learning_predictions' and policyname = 'allow_anon_read') then
    null;
  else
    execute 'create policy allow_anon_read on public.learning_predictions for select to anon using (true)';
  end if;
  if exists (select 1 from pg_policies where tablename = 'feature_importance' and policyname = 'allow_anon_read') then
    null;
  else
    execute 'create policy allow_anon_read on public.feature_importance for select to anon using (true)';
  end if;
end$$;

alter table public.model_versions       enable row level security;
alter table public.learning_predictions enable row level security;
alter table public.feature_importance   enable row level security;
