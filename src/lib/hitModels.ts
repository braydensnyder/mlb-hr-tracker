/**
 * hitModels — model configs for the 1+ and 2+ Hit rankers.
 *
 * ISOLATED from src/lib/stats.ts and the HR scoring path. Nothing here
 * reads HR weights, HrTarget types, or hr_target_universe. The HR
 * pipeline is unaware this file exists.
 *
 * Every persisted hit_target row records the model_config_id AND a
 * reproducibility hash (model_config_hash) of the exact frozen config
 * that scored it. That means historical rankings can always be tied to
 * the specific feature set + weights + standardisation rule that
 * produced them, even after we promote a v2 or v3.
 *
 * Initial state (this commit):
 *   - HIT_MODEL_1PLUS = 'experimental_v0_det_1plus'  is_validated=false
 *   - HIT_MODEL_2PLUS = 'experimental_v0_det_2plus'  is_validated=false
 *
 * The UI reads is_validated and shows a persistent EXPERIMENTAL badge
 * until you swap in a walk-forward winner that clears all five
 * guardrails (≥30 eval dates, positive Top-N abs lift, CI lower bound
 * > 0, ≥55% dates beating baseline, ≥25% #1 stability finishes).
 *
 * Promoting a validated winner is a one-file edit — replace the config
 * object below. Old rows stay pinned to their model_version so
 * backtest never mixes ranker generations.
 */

// ----- Types -----

/** Which side of the scoring pipeline this feature contributes to. */
export type HitKind = 'DET' | 'LR';

/** Standardisation mode.
 *  - z_score_per_day: compute μ/σ from today's eligible-starter pool.
 *    Reproducible only when the day's raw feature values are also
 *    persisted (they are — contributions.base_features on every row).
 *  - z_score_fixed:   apply frozen μ/σ from the training window
 *    (used once we promote an LR/DET winner with training-time stats).
 *  - none: raw feature values enter the weighted sum unchanged. */
export type HitStandardization = 'z_score_per_day' | 'z_score_fixed' | 'none';

export interface HitModelConfig {
  /** Stable string id like 'v1_2026_09_15_walkforward_lr_1plus'. */
  id: string;
  /** DET or LR — dispatches to different scoring functions in hitStats. */
  kind: HitKind;
  /** Feature keys in stable order. Config hash includes this list, so
   *  reordering forces a new hash even if the same features are used. */
  features: string[];
  /** How raw feature values become the weighted-sum inputs. */
  standardize: HitStandardization;
  /** Only populated when standardize === 'z_score_fixed'. */
  fixed_standardization: { means: number[]; stds: number[] } | null;
  /** Weight per feature key. Missing key = weight 0. */
  weights: Record<string, number>;
  /** LR bias term (DET usually 0). */
  bias: number;
  /** Post-linear transform: sigmoid → probability in (0,1); none = raw score. */
  transform: 'sigmoid' | 'none';
  /** Which prediction outcome this ranker targets. Persisted for backtest. */
  target: 'hit_1plus' | 'hit_2plus';
  /** Set true only when the config cleared the five promotion guardrails. */
  is_validated: boolean;
  /** Provenance record when promoted from walk-forward. Null for experimental. */
  promoted_from_walkforward: {
    from_date: string;
    to_date: string;
    dates_evaluated: number;
    top10_rate: number;
    slate_baseline: number;
    abs_lift: number;
    ci95_lo: number;
    dates_beat_pct: number;
    stability_1st_pct: number;
    promoted_at: string;
  } | null;
  /** Human-readable notes surfaced in the UI when badge is hovered. */
  notes: string;
}

/** Runtime shape a persisted row records so score reproduction stays
 *  possible after the fact — every scored row stores this pair per
 *  ranker. */
export interface HitConfigStamp {
  model_config_id: string;
  model_config_hash: string;
}

// ----- Canonical hashing -----
//
// Reproducibility hash: we want two identical configs (same features,
// weights, standardisation) to hash identically across processes and
// across TS/JS engines. Approach:
//
//   1. Round every numeric value to 6 decimal places so trivial
//      floating-point re-serialisation doesn't move the hash.
//   2. Recursively sort object keys so key-order doesn't matter.
//   3. Serialise deterministically.
//   4. Hash with FNV-1a (32-bit) → 8-char hex.
//
// FNV-1a isn't cryptographic; we're not authenticating anything, just
// identifying uniqueness. If two configs collide by accident we can
// investigate the pair — the id string is also stored and it'll flag
// the mismatch immediately.

const HASH_PRECISION = 6;

function roundForHash(v: unknown): unknown {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Number(v.toFixed(HASH_PRECISION));
  }
  if (Array.isArray(v)) return v.map(roundForHash);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = roundForHash((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Deterministic JSON with sorted keys and rounded numbers. */
export function canonicalConfigJson(cfg: HitModelConfig): string {
  const shape = {
    kind: cfg.kind,
    features: cfg.features,           // order matters — preserved
    standardize: cfg.standardize,
    fixed_standardization: cfg.fixed_standardization,
    weights: cfg.weights,
    bias: cfg.bias,
    transform: cfg.transform,
    target: cfg.target,
  };
  return JSON.stringify(roundForHash(shape));
}

/** FNV-1a 32-bit — small, deterministic, no dependencies. */
export function fnv1a32Hex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime = 0x01000193; JS mult loses precision so use imul.
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit and hex-pad to 8 chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Compute the reproducibility hash for a config. */
export function hashConfig(cfg: HitModelConfig): string {
  return fnv1a32Hex(canonicalConfigJson(cfg));
}

/** Get the paired {id, hash} stamp persisted alongside every score. */
export function stampFor(cfg: HitModelConfig): HitConfigStamp {
  return { model_config_id: cfg.id, model_config_hash: hashConfig(cfg) };
}

// ----- Experimental defaults -----
//
// These are the DETERMINISTIC_WEIGHTS_1PLUS / _2PLUS presets from
// calibrateHitScore.ts. They are UNVALIDATED — the walk-forward run
// with the full history hasn't yet cleared them past the promotion
// guardrails. Ship the /hits page with these behind a persistent
// EXPERIMENTAL badge. Do NOT interpret their rankings as production-
// grade until we swap in a validated winner.

const EXPERIMENTAL_FEATURE_ORDER_1PLUS = [
  'season_avg_asof',
  'hit_rate_l7d_asof',
  'hits_l7d_asof',
  'ab_l7d_asof',
  'expected_pa',
  'season_k_rate_asof',
  'recent_k_rate_asof',
  'pitcher_h_per_9_asof',
  'pitcher_whip_asof',
  'pitcher_k_per_9_asof',
  'pitcher_bb_per_9_asof',
  'platoon_hit_rate_asof',
  'weather_temp_f',
  'weather_wind_mph',
];

const EXPERIMENTAL_FEATURE_ORDER_2PLUS = [
  ...EXPERIMENTAL_FEATURE_ORDER_1PLUS,
  'multi_hit_rate_l10g_asof',
];

export const HIT_MODEL_1PLUS: HitModelConfig = {
  id: 'experimental_v0_det_1plus',
  kind: 'DET',
  features: EXPERIMENTAL_FEATURE_ORDER_1PLUS,
  standardize: 'z_score_per_day',
  fixed_standardization: null,
  weights: {
    season_avg_asof:          6,
    hit_rate_l7d_asof:        3,
    hits_l7d_asof:            1,
    ab_l7d_asof:              0,
    expected_pa:              5,
    season_k_rate_asof:      -3,
    recent_k_rate_asof:      -2,
    pitcher_h_per_9_asof:     3,
    pitcher_whip_asof:        2,
    pitcher_k_per_9_asof:    -3,
    pitcher_bb_per_9_asof:    1,
    platoon_hit_rate_asof:    1,
    weather_temp_f:           0.5,
    weather_wind_mph:         0,
  },
  bias: 0,
  transform: 'sigmoid',
  target: 'hit_1plus',
  is_validated: false,
  promoted_from_walkforward: null,
  notes:
    'Experimental placeholder. Deterministic contact-first preset from ' +
    'calibrateHitScore. No walk-forward validation yet. Rankings must be ' +
    'labelled EXPERIMENTAL in the UI until a validated winner replaces this.',
};

export const HIT_MODEL_2PLUS: HitModelConfig = {
  id: 'experimental_v0_det_2plus',
  kind: 'DET',
  features: EXPERIMENTAL_FEATURE_ORDER_2PLUS,
  standardize: 'z_score_per_day',
  fixed_standardization: null,
  weights: {
    season_avg_asof:          5,
    hit_rate_l7d_asof:        3,
    hits_l7d_asof:            2,
    ab_l7d_asof:              1,
    expected_pa:              6,
    season_k_rate_asof:      -3,
    recent_k_rate_asof:      -2,
    pitcher_h_per_9_asof:     3,
    pitcher_whip_asof:        2,
    pitcher_k_per_9_asof:    -2,
    pitcher_bb_per_9_asof:    1,
    platoon_hit_rate_asof:    1,
    weather_temp_f:           0.5,
    weather_wind_mph:         0,
    multi_hit_rate_l10g_asof: 4,
  },
  bias: 0,
  transform: 'sigmoid',
  target: 'hit_2plus',
  is_validated: false,
  promoted_from_walkforward: null,
  notes:
    'Experimental placeholder. Deterministic 2+ preset lifts multi_hit_rate + ' +
    'expected_pa. Showed promising early Top-5 lift but not yet validated on ' +
    'a walk-forward sample large enough to clear the promotion guardrails.',
};

/** Cached at module-load so writers don't recompute per row. Safe to
 *  export — the hash of an immutable config never changes at runtime. */
export const HIT_MODEL_1PLUS_HASH = hashConfig(HIT_MODEL_1PLUS);
export const HIT_MODEL_2PLUS_HASH = hashConfig(HIT_MODEL_2PLUS);

/** Small utility: dump the current model hashes so anyone editing this
 *  file can paste the new values into their commit message. Also
 *  invoked at the start of snapshotHitTargets to log which configs
 *  scored today's run into the operator's stdout. */
export function describeHitModels(): string {
  return [
    'Hit model configs:',
    `  1+: id=${HIT_MODEL_1PLUS.id.padEnd(36)} hash=${HIT_MODEL_1PLUS_HASH}  validated=${HIT_MODEL_1PLUS.is_validated}`,
    `  2+: id=${HIT_MODEL_2PLUS.id.padEnd(36)} hash=${HIT_MODEL_2PLUS_HASH}  validated=${HIT_MODEL_2PLUS.is_validated}`,
  ].join('\n');
}
