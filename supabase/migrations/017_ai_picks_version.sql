-- =====================================================================
-- Migration 017 — Seed v7 "AI Picks (Ensemble)" model version
--
-- v7 is a META-MODEL. It doesn't score players from raw signals like
-- v1-v6 do. Instead, for each date it:
--
--   1. Looks at v1-v6 rolling performance from the [D-30, D-1] window
--      (strictly BEFORE the target date — no hindsight leakage).
--   2. Shrinks each version's Top-10 coverage toward a neutral prior so
--      small samples can't dominate.
--   3. Normalizes shrunk performances into ensemble weights that sum to 1.
--   4. For each player in ANY version's Top 50, computes:
--        score = Σ (versionWeight × rankValue(playerRank))
--      where rankValue decays smoothly from 1.0 at rank 1 to ~0.29 at rank 50.
--   5. Ranks players by ensemble score → the AI Top N.
--
-- The `weights_json` on this row DOCUMENTS the ensemble config so any
-- future replay is reproducible. The actual math lives in src/lib/stats.ts
-- (computeAiEnsembleRankings) — this JSON is a manifest, not a rule input.
--
-- The AI Picks pipeline runs AFTER v1-v6 capture on the night/daily
-- cron tier (see scripts/updateDaily.ts Phase 7).
--
-- Idempotent — safe to re-run.
-- =====================================================================

insert into public.model_versions (version, name, weights_json, notes, active)
select 7,
       'v7 AI Picks (Ensemble)',
       jsonb_build_object(
         'kind', 'ai_ensemble',
         'description', 'Deterministic meta-model. Ensembles v1-v6 by rolling Top-10 coverage with shrinkage toward a neutral prior. Uses only pre-target-date data (hindsight-safe).',
         'config', jsonb_build_object(
           'performanceWindowDays', 30,
           'neutralPrior', 0.15,
           'priorSampleWeight', 20,
           'rankCutoff', 50,
           'rankValueSoftness', 20
         ),
         'notes', ARRAY[
           'Version weights are recomputed for every target date using the [D-30, D-1] window',
           'Small-sample versions (< priorSampleWeight days) shrink heavily toward 0.15',
           'A player at rank 2 in a strong version scores higher than rank 10 in a weak version',
           'Fully replayable — same inputs always produce the same picks'
         ]
       ),
       'Meta-model over v1-v6. See src/lib/stats.ts computeAiEnsembleRankings + scripts/learning/computeAiPicks.ts.',
       false
where not exists (select 1 from public.model_versions where version = 7);
