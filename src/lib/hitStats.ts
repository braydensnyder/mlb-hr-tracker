/**
 * hitStats — scoring API for the parallel Hits tab.
 *
 * ISOLATED from src/lib/stats.ts. Does not import HrTarget, does not
 * touch HR weights, does not participate in computeHrTargets. The HR
 * pipeline continues to score independently.
 *
 * Two rankers per player:
 *   - 1+ Hit  → probability of ≥ 1 hit today
 *   - 2+ Hits → probability of ≥ 2 hits today
 * Rankings are INDEPENDENT — the 2+ score is not derived from the 1+.
 *
 * Every scored row carries:
 *   - the raw as-of feature values (contributions.base_features)
 *   - the standardised values used (contributions.standardized)
 *   - the per-feature contribution to the linear score
 *     (contributions.contributions)
 *   - the model_config_id + model_config_hash it was scored under
 *   - which features were null and therefore excluded (features_missing)
 * so historical rows can always be tied back to and re-derived from the
 * exact frozen config that scored them.
 */

import {
  HIT_MODEL_1PLUS,
  HIT_MODEL_1PLUS_HASH,
  HIT_MODEL_2PLUS,
  HIT_MODEL_2PLUS_HASH,
  type HitConfigStamp,
  type HitModelConfig,
} from './hitModels.js';

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export type LineupStatus = 'confirmed' | 'pending' | 'not_starting' | 'postponed' | 'unknown';

/** Expected plate appearances by lineup slot (league-average, empirical).
 *  Source: same table calibrateHitScore uses. Not persisted per game —
 *  fixed lookup. */
export const EXPECTED_PA_BY_SLOT: Readonly<Record<number, number>> = {
  1: 4.65, 2: 4.55, 3: 4.44, 4: 4.33, 5: 4.22,
  6: 4.11, 7: 4.00, 8: 3.89, 9: 3.78,
};

/** Structured breakdown persisted per (row, ranker) so historical
 *  scoring is fully reconstructable from the row alone. */
export interface HitTargetContributions {
  /** Raw as-of feature values pre-standardisation. Nulls preserved. */
  base_features: Record<string, number | null>;
  /** Post-standardisation values actually consumed by the scorer.
   *  DET z_score_per_day: (x − μ_day) / σ_day. LR fixed: (x − μ_train) / σ_train. */
  standardized: Record<string, number>;
  /** Per-feature contribution to the linear score
   *  = weight × standardized. Sums (plus intercept) to linear_score. */
  contributions: Record<string, number>;
  /** LR bias term (0 for the current DET presets). */
  intercept: number;
  /** Sum of contributions + intercept, pre-transform. */
  linear_score: number;
  /** Post-transform: sigmoid for probability rankers. */
  probability: number;
  /** Provenance so this row can be traced back to the exact frozen config
   *  even after the config file is edited or a v2 is promoted. */
  model: {
    id: string;
    hash: string;
    kind: 'DET' | 'LR';
    is_validated: boolean;
    features_used: string[];
    features_missing: string[];
    standardize: HitModelConfig['standardize'];
  };
  /** Data-quality diagnostics used by hitConfidenceTier. Not part of the
   *  scoring pipeline but persisted so consumers can filter without
   *  re-fetching source rows. */
  quality: {
    n_prior_games: number | null;
    has_platoon: boolean;
    ab_l7d: number | null;
    pitcher_starts_known: number | null;
    weather_present: boolean;
  };
}

export interface HitReasonChip {
  label: string;
  kind: string;
  tone: 'good' | 'bad' | 'neutral';
  detail?: string;
}

export interface HitMatchupNote {
  kind: string;
  label: string;
  detail?: string;
}

export interface HitTarget {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string | null;
  game_pk: number | null;

  batting_order_slot: number | null;
  lineup_status: LineupStatus;
  opposing_starter_id: number | null;
  opposing_starter_hand: 'L' | 'R' | null;

  // 1+ ranker
  hit_score_1plus: number;
  hit_prob_1plus: number;
  contributions_1plus: HitTargetContributions;
  confidence_1plus: 'high' | 'medium' | 'low';

  // 2+ ranker (independent — see comment above)
  hit_score_2plus: number;
  hit_prob_2plus: number;
  contributions_2plus: HitTargetContributions;
  confidence_2plus: 'high' | 'medium' | 'low';

  reason_chips: HitReasonChip[];
  matchup_notes: HitMatchupNote[];
  flags: string[];
}

export interface HitTargetsBoard {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  home_probable_pitcher: { id: number | null; name: string | null; hand: 'L' | 'R' | null };
  away_probable_pitcher: { id: number | null; name: string | null; hand: 'L' | 'R' | null };
  home_targets: HitTarget[];
  away_targets: HitTarget[];
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
}

// -------------------------------------------------------------------
// Data-layer inputs (shape only; loaders live in the writer script)
// -------------------------------------------------------------------

export interface PlayerDailyHitSummaryRow {
  player_id: number;
  hits_l7d: number | null;
  ab_l7d: number | null;
  hit_rate_l7d: number | null;
  strikeout_rate_l7d: number | null;
  multi_hit_games_l5g: number | null;
  multi_hit_games_l10g: number | null;
  hits_vs_lhp_starters: number | null;
  ab_vs_lhp_starters: number | null;
  hits_vs_rhp_starters: number | null;
  ab_vs_rhp_starters: number | null;
  season_avg: number | null;
  season_obp: number | null;
  season_slg: number | null;
  season_ops: number | null;
  /** How many games in the load window went into this row. */
  n_prior_games?: number | null;
  flags?: string[];
}

export interface PitcherFormRow {
  pitcher_id: number;
  starts_known: number;
  h_per_9: number | null;
  k_per_9: number | null;
  bb_per_9: number | null;
  whip: number | null;
}

export interface HitGameContext {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  home_probable_pitcher_id: number | null;
  home_probable_pitcher_name: string | null;
  home_probable_pitcher_hand: 'L' | 'R' | null;
  away_probable_pitcher_id: number | null;
  away_probable_pitcher_name: string | null;
  away_probable_pitcher_hand: 'L' | 'R' | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  home_lineup: number[] | null;
  away_lineup: number[] | null;
  lineups_confirmed: boolean | null;
  game_status?: string | null;
}

/** One row in the eligible-starter universe for a given date. Assembled
 *  by the writer from confirmed + pending lineups on games with a
 *  known probable pitcher. */
export interface HitCandidate {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  game_pk: number;
  batting_order_slot: number | null;
  lineup_status: LineupStatus;
  opposing_starter_id: number | null;
  opposing_starter_hand: 'L' | 'R' | null;
  batter_side: 'L' | 'R' | 'S' | null;
}

// -------------------------------------------------------------------
// Feature construction
// -------------------------------------------------------------------

export interface HitFeatureInputs {
  candidate: HitCandidate;
  summary: PlayerDailyHitSummaryRow | null;
  pitcher_form: PitcherFormRow | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
}

/**
 * Build the raw as-of feature dictionary for one player-day. Every
 * value is either a finite number or NULL — nulls are NEVER converted
 * to 0. Downstream scorer drops features that are null for a given row
 * (records them in contributions.model.features_missing).
 *
 * Feature keys mirror what calibrateHitScore.ts uses so the walk-forward
 * winner drops in without renaming.
 */
export function buildHitFeatures(inputs: HitFeatureInputs): Record<string, number | null> {
  const { candidate, summary, pitcher_form, weather_temp_f, weather_wind_mph } = inputs;
  const slot = candidate.batting_order_slot;
  const expected_pa = slot != null ? (EXPECTED_PA_BY_SLOT[slot] ?? 4.0) : null;

  // Platoon rate: hits vs starter's hand / AB vs same hand.
  let platoon_hit_rate_asof: number | null = null;
  if (summary && candidate.opposing_starter_hand === 'L') {
    if (summary.ab_vs_lhp_starters != null && summary.ab_vs_lhp_starters > 0 && summary.hits_vs_lhp_starters != null) {
      platoon_hit_rate_asof = summary.hits_vs_lhp_starters / summary.ab_vs_lhp_starters;
    }
  } else if (summary && candidate.opposing_starter_hand === 'R') {
    if (summary.ab_vs_rhp_starters != null && summary.ab_vs_rhp_starters > 0 && summary.hits_vs_rhp_starters != null) {
      platoon_hit_rate_asof = summary.hits_vs_rhp_starters / summary.ab_vs_rhp_starters;
    }
  }

  // Multi-hit rate over last 10 games.
  let multi_hit_rate_l10g_asof: number | null = null;
  if (summary?.multi_hit_games_l10g != null) {
    multi_hit_rate_l10g_asof = summary.multi_hit_games_l10g / 10;
  }

  // Season K rate — approximated from strikeout_rate_l7d if we don't have
  // a persisted season one. NULL when neither exists.
  const season_k_rate_asof = summary?.strikeout_rate_l7d ?? null;

  return {
    season_avg_asof:          summary?.season_avg ?? null,
    hit_rate_l7d_asof:        summary?.hit_rate_l7d ?? null,
    hits_l7d_asof:            summary?.hits_l7d ?? null,
    ab_l7d_asof:              summary?.ab_l7d ?? null,
    expected_pa,
    season_k_rate_asof,
    recent_k_rate_asof:       summary?.strikeout_rate_l7d ?? null,
    pitcher_h_per_9_asof:     pitcher_form?.h_per_9 ?? null,
    pitcher_whip_asof:        pitcher_form?.whip ?? null,
    pitcher_k_per_9_asof:     pitcher_form?.k_per_9 ?? null,
    pitcher_bb_per_9_asof:    pitcher_form?.bb_per_9 ?? null,
    platoon_hit_rate_asof,
    weather_temp_f,
    weather_wind_mph,
    multi_hit_rate_l10g_asof,
  };
}

// -------------------------------------------------------------------
// Pool statistics for z_score_per_day standardisation
// -------------------------------------------------------------------

/** μ/σ computed over the FULL eligible-starter pool for the day —
 *  rows with a null on a given feature are excluded from that feature's
 *  μ/σ only, never zero-filled. Returns per-feature stats. */
export interface PoolStandardization {
  means: Record<string, number>;
  stds: Record<string, number>;
  n_used: Record<string, number>;
}

export function computePoolStandardization(
  featureRows: Array<Record<string, number | null>>,
  keys: string[],
): PoolStandardization {
  const means: Record<string, number> = {};
  const stds: Record<string, number> = {};
  const n_used: Record<string, number> = {};
  for (const k of keys) {
    const vals: number[] = [];
    for (const row of featureRows) {
      const v = row[k];
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    n_used[k] = vals.length;
    if (vals.length === 0) { means[k] = 0; stds[k] = 1; continue; }
    const m = vals.reduce((s, x) => s + x, 0) / vals.length;
    means[k] = m;
    let ss = 0;
    for (const v of vals) ss += (v - m) ** 2;
    const s = Math.sqrt(ss / vals.length);
    stds[k] = s > 0 ? s : 1;
  }
  return { means, stds, n_used };
}

// -------------------------------------------------------------------
// Sigmoid — numerically stable
// -------------------------------------------------------------------
function sigmoid(z: number): number {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

// -------------------------------------------------------------------
// scoreHit — one player, one config
// -------------------------------------------------------------------

export interface HitScoringPool {
  standardize: HitModelConfig['standardize'];
  perDay: PoolStandardization | null;   // when standardize === 'z_score_per_day'
}

/** Score one player's features under one config. Missing (null) features
 *  are recorded in features_missing and contribute 0.0. Rows with too
 *  many missing features are still returned but downstream code should
 *  gate on model.features_missing.length before ranking. */
export function scoreHit(
  features: Record<string, number | null>,
  cfg: HitModelConfig,
  pool: HitScoringPool,
  quality: HitTargetContributions['quality'],
): HitTargetContributions {
  const base_features: Record<string, number | null> = {};
  const standardized: Record<string, number> = {};
  const contributions: Record<string, number> = {};
  const features_used: string[] = [];
  const features_missing: string[] = [];
  let linear = cfg.bias;

  for (const key of cfg.features) {
    const raw = features[key];
    base_features[key] = raw == null || !Number.isFinite(raw as number) ? null : (raw as number);
    if (base_features[key] == null) {
      features_missing.push(key);
      standardized[key] = 0;
      contributions[key] = 0;
      continue;
    }
    const rawNum = base_features[key] as number;

    let z: number;
    if (cfg.standardize === 'z_score_per_day' && pool.perDay) {
      const mu = pool.perDay.means[key] ?? 0;
      const sd = pool.perDay.stds[key] ?? 1;
      z = (rawNum - mu) / (sd || 1);
    } else if (cfg.standardize === 'z_score_fixed' && cfg.fixed_standardization) {
      const idx = cfg.features.indexOf(key);
      const mu = cfg.fixed_standardization.means[idx] ?? 0;
      const sd = cfg.fixed_standardization.stds[idx] ?? 1;
      z = (rawNum - mu) / (sd || 1);
    } else {
      z = rawNum;
    }

    const w = cfg.weights[key] ?? 0;
    const c = w * z;
    standardized[key] = z;
    contributions[key] = c;
    linear += c;
    features_used.push(key);
  }

  // Temperature scaling — applies ONLY to the sigmoid branch. linear_score
  // (persisted below) stays unscaled so historical rows can be re-scored
  // under any temperature without touching stored feature values.
  //   scaled = linear / temperature
  //   probability = sigmoid(scaled)
  // Default temperature=1 preserves pre-fix behaviour for configs that
  // don't set it (interface has no `?`; TypeScript enforces the field
  // but the ?? guard also protects any runtime deserialisation edge).
  const temperature = cfg.temperature > 0 ? cfg.temperature : 1;
  const scaled = linear / temperature;
  const probability = cfg.transform === 'sigmoid' ? sigmoid(scaled) : linear;

  return {
    base_features,
    standardized,
    contributions,
    intercept: cfg.bias,
    linear_score: linear,
    probability,
    model: {
      id: cfg.id,
      hash: cfg === HIT_MODEL_1PLUS ? HIT_MODEL_1PLUS_HASH
          : cfg === HIT_MODEL_2PLUS ? HIT_MODEL_2PLUS_HASH
          : hashLive(cfg),
      kind: cfg.kind,
      is_validated: cfg.is_validated,
      features_used,
      features_missing,
      standardize: cfg.standardize,
    },
    quality,
  };
}

/** Slow path — used only when scoreHit is called with a config other
 *  than the two module-level exports (e.g. an ad-hoc config in a test). */
function hashLive(cfg: HitModelConfig): string {
  // Avoid re-importing the hash function circularly at module init.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hashConfig } = require('./hitModels.js') as { hashConfig: (c: HitModelConfig) => string };
  return hashConfig(cfg);
}

// -------------------------------------------------------------------
// Confidence tier
// -------------------------------------------------------------------

export function hitConfidenceTier(q: HitTargetContributions['quality'], missingCount: number): 'high' | 'medium' | 'low' {
  // High:   ≥10 prior games, ≥12 AB in L7d, pitcher_starts_known ≥ 3,
  //         AND no more than 2 features missing.
  // Low:    <5 prior games OR ab_l7d < 5 OR no pitcher_form,
  //         OR ≥ 4 features missing.
  // Medium: everything else.
  const priorOk = (q.n_prior_games ?? 0) >= 10;
  const abOk = (q.ab_l7d ?? 0) >= 12;
  const pitcherOk = (q.pitcher_starts_known ?? 0) >= 3;
  const priorLow = (q.n_prior_games ?? 0) < 5;
  const abLow = (q.ab_l7d ?? 0) < 5;
  if (priorLow || abLow || !q.pitcher_starts_known || missingCount >= 4) return 'low';
  if (priorOk && abOk && pitcherOk && missingCount <= 2) return 'high';
  return 'medium';
}

// -------------------------------------------------------------------
// Reason chips + matchup notes (evidence-only)
// -------------------------------------------------------------------

/** Chips fire only when the data that would justify them is present
 *  and non-null. Never invented. */
export function pickHitReasonChips(
  features: Record<string, number | null>,
  contribs1: HitTargetContributions,
  contribs2: HitTargetContributions,
): HitReasonChip[] {
  const chips: HitReasonChip[] = [];

  // Contact / power side
  const seasonAvg = features.season_avg_asof;
  if (typeof seasonAvg === 'number' && seasonAvg >= 0.290) {
    chips.push({ kind: 'strong_contact', label: 'Strong contact', tone: 'good',
      detail: `.${(seasonAvg * 1000).toFixed(0).padStart(3, '0')} season AVG` });
  }
  const seasonK = features.season_k_rate_asof;
  if (typeof seasonK === 'number' && seasonK <= 0.16) {
    chips.push({ kind: 'low_k', label: 'Low K rate', tone: 'good',
      detail: `${(seasonK * 100).toFixed(1)}% K rate` });
  } else if (typeof seasonK === 'number' && seasonK >= 0.30) {
    chips.push({ kind: 'high_k', label: 'High K rate', tone: 'bad',
      detail: `${(seasonK * 100).toFixed(1)}% K rate` });
  }

  // Recent form
  const hitRateL7 = features.hit_rate_l7d_asof;
  const abL7 = features.ab_l7d_asof;
  if (typeof hitRateL7 === 'number' && typeof abL7 === 'number' && abL7 >= 12 && hitRateL7 >= 0.32) {
    chips.push({ kind: 'hot_recent', label: 'Hot last 7', tone: 'good',
      detail: `${(hitRateL7 * 100).toFixed(0)}% (${Math.round(hitRateL7 * abL7)}/${abL7})` });
  } else if (typeof hitRateL7 === 'number' && typeof abL7 === 'number' && abL7 >= 12 && hitRateL7 <= 0.15) {
    chips.push({ kind: 'cold_recent', label: 'Cold last 7', tone: 'bad',
      detail: `${(hitRateL7 * 100).toFixed(0)}% (${Math.round(hitRateL7 * abL7)}/${abL7})` });
  }

  // Multi-hit trend (relevant to 2+ but useful on both boards)
  const multiHitRate = features.multi_hit_rate_l10g_asof;
  if (typeof multiHitRate === 'number' && multiHitRate >= 0.30) {
    chips.push({ kind: 'multi_hit_trend', label: 'Multi-hit trend', tone: 'good',
      detail: `${Math.round(multiHitRate * 10)}/10 games ≥ 2 H` });
  }

  // Pitcher matchup
  const pH9 = features.pitcher_h_per_9_asof;
  if (typeof pH9 === 'number' && pH9 >= 9.5) {
    chips.push({ kind: 'favorable_h9', label: 'Favorable H/9', tone: 'good',
      detail: `Pitcher ${pH9.toFixed(2)} H/9` });
  }
  const pK9 = features.pitcher_k_per_9_asof;
  if (typeof pK9 === 'number' && pK9 >= 11) {
    chips.push({ kind: 'dominant_pitcher', label: 'Dominant K pitcher', tone: 'bad',
      detail: `Pitcher ${pK9.toFixed(2)} K/9` });
  } else if (typeof pK9 === 'number' && pK9 <= 7) {
    chips.push({ kind: 'favorable_k9', label: 'Low pitcher K/9', tone: 'good',
      detail: `Pitcher ${pK9.toFixed(2)} K/9` });
  }

  // Platoon
  const platoonRate = features.platoon_hit_rate_asof;
  if (typeof platoonRate === 'number' && typeof seasonAvg === 'number' && platoonRate >= seasonAvg + 0.030) {
    chips.push({ kind: 'platoon_edge', label: 'Platoon edge', tone: 'good',
      detail: `${(platoonRate * 100).toFixed(0)}% vs opp hand (${((platoonRate - seasonAvg) * 1000).toFixed(0)} pt above season)` });
  }

  // Lineup slot
  const slot = features.expected_pa != null
    ? Object.entries(EXPECTED_PA_BY_SLOT).find(([, pa]) => pa === features.expected_pa)?.[0]
    : null;
  if (slot != null && Number(slot) <= 3) {
    chips.push({ kind: 'top_of_order', label: `Batting ${slot}`, tone: 'good',
      detail: `Slot ${slot} → ~${(features.expected_pa as number).toFixed(2)} expected PA` });
  }

  // Model-agreement chip — quiet signal when both rankers put the player
  // firmly above their pool baseline probability. Only emit when both
  // configs used a reasonable number of features (otherwise low-info).
  const both1 = contribs1.model.features_used.length >= 5;
  const both2 = contribs2.model.features_used.length >= 5;
  if (both1 && both2 && contribs1.probability >= 0.60 && contribs2.probability >= 0.25) {
    chips.push({ kind: 'model_agreement', label: 'Both rankers strong', tone: 'good',
      detail: `1+ p=${contribs1.probability.toFixed(2)}, 2+ p=${contribs2.probability.toFixed(2)}` });
  }

  return chips;
}

export function pickHitMatchupNotes(
  features: Record<string, number | null>,
): HitMatchupNote[] {
  const notes: HitMatchupNote[] = [];

  const pH9 = features.pitcher_h_per_9_asof;
  const pWHIP = features.pitcher_whip_asof;
  if (typeof pH9 === 'number' && typeof pWHIP === 'number' && pH9 >= 9.0 && pWHIP >= 1.30) {
    notes.push({ kind: 'hittable_pitcher', label: 'Hittable pitcher',
      detail: `H/9=${pH9.toFixed(2)} · WHIP=${pWHIP.toFixed(2)}` });
  }

  const expectedPa = features.expected_pa;
  if (typeof expectedPa === 'number' && expectedPa >= 4.5) {
    notes.push({ kind: 'top_order_opportunity', label: 'Top-of-order opportunity',
      detail: `~${expectedPa.toFixed(2)} expected PA` });
  }

  const multiHitRate = features.multi_hit_rate_l10g_asof;
  if (typeof multiHitRate === 'number' && multiHitRate >= 0.30) {
    notes.push({ kind: 'multi_hit_run', label: 'Multi-hit run',
      detail: `${Math.round(multiHitRate * 10)}/10 games ≥ 2 H` });
  }

  const platoonRate = features.platoon_hit_rate_asof;
  const seasonAvg = features.season_avg_asof;
  if (typeof platoonRate === 'number' && typeof seasonAvg === 'number' && platoonRate >= seasonAvg + 0.030) {
    notes.push({ kind: 'platoon_edge', label: 'Platoon edge on opposing starter',
      detail: `${(platoonRate * 100).toFixed(0)}% vs hand` });
  }

  return notes;
}

// -------------------------------------------------------------------
// computeHitTargets — main entry
// -------------------------------------------------------------------

export interface ComputeHitTargetsOpts {
  candidates: HitCandidate[];
  gamesByPk: Map<number, HitGameContext>;
  hitSummaryById: Map<number, PlayerDailyHitSummaryRow>;
  pitcherFormById: Map<number, PitcherFormRow>;
  config1Plus?: HitModelConfig;
  config2Plus?: HitModelConfig;
}

/** Score every eligible candidate under both configs and return
 *  game-grouped boards. Standardisation pool for per-day mode is the
 *  full candidate set (not per-team, not per-game) so score comparisons
 *  are pool-consistent within the day. */
export function computeHitTargets(opts: ComputeHitTargetsOpts): HitTargetsBoard[] {
  const cfg1 = opts.config1Plus ?? HIT_MODEL_1PLUS;
  const cfg2 = opts.config2Plus ?? HIT_MODEL_2PLUS;

  // Step 1: build feature rows per candidate.
  const featureRows: Array<{
    candidate: HitCandidate;
    game: HitGameContext | null;
    features: Record<string, number | null>;
    quality: HitTargetContributions['quality'];
  }> = [];
  for (const c of opts.candidates) {
    const g = opts.gamesByPk.get(c.game_pk) ?? null;
    const summary = opts.hitSummaryById.get(c.player_id) ?? null;
    const pForm = c.opposing_starter_id != null ? opts.pitcherFormById.get(c.opposing_starter_id) ?? null : null;
    const features = buildHitFeatures({
      candidate: c,
      summary,
      pitcher_form: pForm,
      weather_temp_f: g?.weather_temp_f ?? null,
      weather_wind_mph: g?.weather_wind_mph ?? null,
    });
    const quality: HitTargetContributions['quality'] = {
      n_prior_games: summary?.n_prior_games ?? null,
      has_platoon: features.platoon_hit_rate_asof != null,
      ab_l7d: summary?.ab_l7d ?? null,
      pitcher_starts_known: pForm?.starts_known ?? null,
      weather_present: g?.weather_temp_f != null || g?.weather_wind_mph != null,
    };
    featureRows.push({ candidate: c, game: g, features, quality });
  }

  // Step 2: standardisation pool. If both configs use z_score_per_day,
  // compute one pool covering the union of their features.
  const needPool = cfg1.standardize === 'z_score_per_day' || cfg2.standardize === 'z_score_per_day';
  const allKeys = Array.from(new Set([...cfg1.features, ...cfg2.features]));
  const pool = needPool
    ? computePoolStandardization(featureRows.map((r) => r.features), allKeys)
    : null;
  const scoringPool: HitScoringPool = { standardize: cfg1.standardize, perDay: pool };

  // Step 3: score both rankers per candidate.
  const targets: HitTarget[] = featureRows.map(({ candidate, features, quality }) => {
    const c1 = scoreHit(features, cfg1, scoringPool, quality);
    const c2 = scoreHit(features, cfg2, scoringPool, quality);
    const chips = pickHitReasonChips(features, c1, c2);
    const notes = pickHitMatchupNotes(features);
    const flags: string[] = [];
    if (c1.model.features_missing.length >= 4) flags.push('many_features_missing_1plus');
    if (c2.model.features_missing.length >= 4) flags.push('many_features_missing_2plus');
    if (!quality.has_platoon) flags.push('no_platoon_data');
    if (candidate.batting_order_slot == null) flags.push('no_lineup_slot');
    if (candidate.opposing_starter_id == null) flags.push('no_opposing_starter');

    return {
      player_id: candidate.player_id,
      player_name: candidate.player_name,
      team: candidate.team,
      opponent: candidate.opponent,
      game_pk: candidate.game_pk,
      batting_order_slot: candidate.batting_order_slot,
      lineup_status: candidate.lineup_status,
      opposing_starter_id: candidate.opposing_starter_id,
      opposing_starter_hand: candidate.opposing_starter_hand,
      hit_score_1plus: c1.linear_score,
      hit_prob_1plus: c1.probability,
      contributions_1plus: c1,
      confidence_1plus: hitConfidenceTier(quality, c1.model.features_missing.length),
      hit_score_2plus: c2.linear_score,
      hit_prob_2plus: c2.probability,
      contributions_2plus: c2,
      confidence_2plus: hitConfidenceTier(quality, c2.model.features_missing.length),
      reason_chips: chips,
      matchup_notes: notes,
      flags,
    };
  });

  // Step 4: group by game. Each candidate carries game_pk.
  const boardByPk = new Map<number, HitTargetsBoard>();
  for (const t of targets) {
    if (t.game_pk == null) continue;
    if (!boardByPk.has(t.game_pk)) {
      const g = opts.gamesByPk.get(t.game_pk);
      if (!g) continue;
      boardByPk.set(t.game_pk, {
        game_pk: g.game_pk, game_date: g.game_date,
        home_team: g.home_team, away_team: g.away_team,
        home_probable_pitcher: {
          id: g.home_probable_pitcher_id,
          name: g.home_probable_pitcher_name,
          hand: g.home_probable_pitcher_hand,
        },
        away_probable_pitcher: {
          id: g.away_probable_pitcher_id,
          name: g.away_probable_pitcher_name,
          hand: g.away_probable_pitcher_hand,
        },
        home_targets: [], away_targets: [],
        weather_temp_f: g.weather_temp_f,
        weather_wind_mph: g.weather_wind_mph,
      });
    }
    const b = boardByPk.get(t.game_pk)!;
    if (t.team === b.home_team) b.home_targets.push(t);
    else if (t.team === b.away_team) b.away_targets.push(t);
    // If team doesn't match either side (data glitch), drop the row.
  }

  return Array.from(boardByPk.values()).sort((a, b) => a.game_pk - b.game_pk);
}

// -------------------------------------------------------------------
// Re-exports for callers who want the pair of config stamps handy.
// -------------------------------------------------------------------
export type { HitConfigStamp } from './hitModels.js';
export { HIT_MODEL_1PLUS, HIT_MODEL_2PLUS, HIT_MODEL_1PLUS_HASH, HIT_MODEL_2PLUS_HASH, describeHitModels } from './hitModels.js';
