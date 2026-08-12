-- =====================================================================
-- Migration 019 — Persist numeric contribution breakdown on
--                 learning_predictions (Phase 1 preconditioning).
--
-- Today learning_predictions.signals_json is a boolean map that the
-- captureDay script derives by regex-parsing the `reason` text
-- (parseSignalsFromReason in stats.ts). That's lossy: it tells us
-- "the pitcher chip fired" but not "the pitcher contributed 12.4 pts".
--
-- Any future weight-learner or miss analysis needs the numeric
-- contributions to be queryable directly from the row. mig 018
-- already added subscores_json to hr_target_universe (v1 only, going
-- forward). This migration extends the same idea to learning_predictions
-- so every version's row can carry a full numeric breakdown.
--
-- Shape of contributions_json (see HrTargetContributions in stats.ts):
--   {
--     base: {l3, l5, l7d, season, pitcher, park, hand, weather},
--     adjustments: {
--       elite_power_floor, low_power_cap, cold_penalty,
--       pitcher_dominance, wild_pitcher,
--       completeness_multiplier_delta, ceiling_compression,
--       weather, lineup_pending
--     },
--     scores: {
--       raw_pre_adjustments, after_power_floor, after_low_power_cap,
--       after_negative_penalties, after_completeness, after_ceiling,
--       after_weather, after_lineup, final
--     },
--     meta: {
--       stability_factor, completeness_multiplier, factors_firing,
--       is_elite_power, is_auto_elite, cold_penalty_tier,
--       pitcher_starts_known, known_hand_hrs,
--       weather_temp_boost, weather_wind_boost,
--       weather_is_dome, weather_included
--     }
--   }
--
-- For v2-v6 (signal-additive replay) contributions_json describes the
-- v1 base plus the per-signal deltas the replay applied. For v7
-- (ensemble) it stores {ensemble_score, versions_agreeing,
-- version_ranks, version_weights, average_rank}.
--
-- Nothing here changes how existing rows are read. Default is '{}' so
-- older rows continue to load. Anything relying on signals_json / reason
-- continues to work.
--
-- Idempotent — safe to re-run.
-- =====================================================================

alter table public.learning_predictions
  add column if not exists contributions_json jsonb not null default '{}'::jsonb;

comment on column public.learning_predictions.contributions_json is
  'Numeric contribution breakdown (see HrTargetContributions in src/lib/stats.ts). '
  'For v1 it mirrors the base/adjustments/scores/meta object built inside '
  'computeHrTargets. For v2-v6 (replay) it includes the v1 base plus per-signal '
  'replay deltas. For v7 (ensemble) it stores ensemble math. Default {} for '
  'pre-migration rows.';

-- Lightweight index for "which rows already have contributions?" queries
-- during backfill and validation.
create index if not exists lp_contribs_present_idx
  on public.learning_predictions ((contributions_json <> '{}'::jsonb));
