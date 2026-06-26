-- =====================================================================
-- Migration 014 — Multi-model versions for backtesting
--
-- Seeds five alternative model strategies (v2-v6) so the Learning Engine
-- can replay v1's saved snapshots through them and compare performance.
--
-- HONEST SCOPE: these models are "signal-based replays" — they take v1's
-- saved heat_score per snapshot row and apply per-signal additive
-- bonuses based on which chips fired (HR Pitcher, Power Park, etc.).
-- Each version can ALSO override the Safe/Value/Chaos parlay-rule
-- cutoffs. They do NOT re-run the full computeHrTargets scoring
-- pipeline from raw data (that would require a schema change to save
-- subscores per snapshot, deferred to Phase 3 of the learning engine).
--
-- All five new versions have active=false. v1 stays active for live use.
-- Idempotent — uses WHERE NOT EXISTS so re-running is safe.
-- =====================================================================

-- ---------- v2 Recent Form Heavy ----------
insert into public.model_versions (version, name, weights_json, notes, active)
select 2,
       'v2 Recent Form Heavy',
       jsonb_build_object(
         'description', 'Heavier weight on last 7d HR activity + multi-day streaks',
         'signal_weights', jsonb_build_object(
           'hot_l7d',    12,
           'hr_streak',  10,
           'elite_power', 4
         ),
         'parlay_rules', jsonb_build_object()
       ),
       'Tests whether recent form / hot-hand outperforms raw power baseline.',
       false
where not exists (select 1 from public.model_versions where version = 2);

-- ---------- v3 Pitcher Matchup Heavy ----------
insert into public.model_versions (version, name, weights_json, notes, active)
select 3,
       'v3 Pitcher Matchup Heavy',
       jsonb_build_object(
         'description', 'Heavier weight on weak HR pitchers + platoon edge',
         'signal_weights', jsonb_build_object(
           'hr_pitcher',     15,
           'platoon_edge',   10,
           'pitcher_dominant', -8
         ),
         'parlay_rules', jsonb_build_object()
       ),
       'Tests whether opposing pitcher data is the dominant predictor.',
       false
where not exists (select 1 from public.model_versions where version = 3);

-- ---------- v4 Park / Weather Heavy ----------
insert into public.model_versions (version, name, weights_json, notes, active)
select 4,
       'v4 Park/Weather Heavy',
       jsonb_build_object(
         'description', 'Heavier weight on hitter-friendly parks + favorable weather',
         'signal_weights', jsonb_build_object(
           'power_park',     12,
           'wind_out',       10,
           'warm_weather',    6,
           'wind_in',         -8
         ),
         'parlay_rules', jsonb_build_object()
       ),
       'Tests whether ballpark + weather combined moves the needle vs the baseline 10-point park weight.',
       false
where not exists (select 1 from public.model_versions where version = 4);

-- ---------- v5 Value / Odds Heavy ----------
-- This one keeps signal weights identical to v1 but loosens the parlay
-- cutoffs to take MORE +400..+800 picks. Tests whether the Value style
-- is being under-utilized at current thresholds.
insert into public.model_versions (version, name, weights_json, notes, active)
select 5,
       'v5 Value/Odds Heavy',
       jsonb_build_object(
         'description', 'Same scoring as v1 but looser parlay thresholds — favors longer-odds plays',
         'signal_weights', jsonb_build_object(),
         'parlay_rules', jsonb_build_object(
           'safe_odds_max',   600,
           'value_odds_max',  800,
           'value_edge_min',  0.01,
           'chaos_odds_min',  400
         )
       ),
       'Tests whether widening Safe/Value/Chaos windows captures more HR hitters at the cost of precision.',
       false
where not exists (select 1 from public.model_versions where version = 5);

-- ---------- v6 Team Context Heavy ----------
-- DEGRADED: we don't have team-implied-runs in snapshots. This is a
-- proxy using elite_power + mid_power (high-team-power hitters tend
-- to be in stronger lineups) and a moderate boost on platoon_edge
-- (correlates with lineup-construction advantages). A "true" v6 would
-- need a separate ingest of betting market team totals + lineup
-- position data.
insert into public.model_versions (version, name, weights_json, notes, active)
select 6,
       'v6 Team Context Heavy (limited)',
       jsonb_build_object(
         'description', 'Proxy for team-power context — limited by missing team-implied-runs data',
         'signal_weights', jsonb_build_object(
           'elite_power',     8,
           'mid_power',       4,
           'platoon_edge',    6,
           'low_season_power', -4
         ),
         'parlay_rules', jsonb_build_object()
       ),
       'DEGRADED: team-implied-runs not in snapshots yet. Uses elite/mid power + platoon as a proxy. Replace once team-total ingest is wired up.',
       false
where not exists (select 1 from public.model_versions where version = 6);

-- ---------- safety: ensure only one row is active ----------
-- If for any reason multiple rows ended up active, force v1 to remain
-- the live model.
do $$
declare active_count int;
begin
  select count(*) into active_count from public.model_versions where active = true;
  if active_count > 1 then
    update public.model_versions set active = false;
    update public.model_versions set active = true where version = 1;
  end if;
end$$;
