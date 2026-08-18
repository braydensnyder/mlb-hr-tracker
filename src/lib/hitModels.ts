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
  /** Temperature scaling applied BEFORE the sigmoid:
   *    scaled = linear / temperature
   *    probability = sigmoid(scaled)   (when transform === 'sigmoid')
   *
   *  Higher temperature → softer probabilities (less collapse to 0/1);
   *  temperature=1 is the neutral default. DET presets derived from
   *  calibrateHitScore use temperature=10 to match how they were
   *  designed (calibrateHitScore's deterministicScore does sigmoid(s/10)).
   *
   *  Temperature is part of the model identity — it's included in the
   *  canonical config hash. Rank ordering is invariant to temperature
   *  (sigmoid is monotonic), so historical ranks under any temperature
   *  remain honest even when probabilities render differently. */
  temperature: number;
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

/** Deterministic JSON with sorted keys and rounded numbers. Any change
 *  to this shape (new hashed field, new required key) changes every
 *  config's hash, so this is the one place that pins model identity. */
export function canonicalConfigJson(cfg: HitModelConfig): string {
  const shape = {
    kind: cfg.kind,
    features: cfg.features,           // order matters — preserved
    standardize: cfg.standardize,
    fixed_standardization: cfg.fixed_standardization,
    weights: cfg.weights,
    bias: cfg.bias,
    temperature: cfg.temperature ?? 1, // NEW — pre-migration configs default to 1
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

/**
 * Feature order for the experimental v0.1 (K-rate-fix) configs.
 * season_k_rate_asof was REMOVED after the buildHitFeatures bug fix
 * — that field is now always null (no real season K source yet),
 * and having it in the features list with weight -3 was producing a
 * duplicate weighting of the recent-K signal. Removing it changes
 * the config hash automatically, which is correct: post-fix scoring
 * behaviour is genuinely different from pre-fix scoring.
 */
const V0_1_FEATURE_ORDER_1PLUS = [
  'season_avg_asof',
  'hit_rate_l7d_asof',
  'hits_l7d_asof',
  'ab_l7d_asof',
  'expected_pa',
  'recent_k_rate_asof',
  'pitcher_h_per_9_asof',
  'pitcher_whip_asof',
  'pitcher_k_per_9_asof',
  'pitcher_bb_per_9_asof',
  'platoon_hit_rate_asof',
  'weather_temp_f',
  'weather_wind_mph',
];

const V0_1_FEATURE_ORDER_2PLUS = [
  ...V0_1_FEATURE_ORDER_1PLUS,
  'multi_hit_rate_l10g_asof',
];

/** v2 experiment feature order — identical to v0.1's since the v2
 *  weight edits don't change which features are read (just weights). */
const V2_FEATURE_ORDER_1PLUS = V0_1_FEATURE_ORDER_1PLUS;
const V2_FEATURE_ORDER_2PLUS = V0_1_FEATURE_ORDER_2PLUS;

export const HIT_MODEL_1PLUS: HitModelConfig = {
  id: 'experimental_v0_1_det_1plus',
  kind: 'DET',
  features: V0_1_FEATURE_ORDER_1PLUS,
  standardize: 'z_score_per_day',
  fixed_standardization: null,
  weights: {
    season_avg_asof:          6,
    hit_rate_l7d_asof:        3,
    hits_l7d_asof:            1,
    ab_l7d_asof:              0,
    expected_pa:              5,
    recent_k_rate_asof:      -2,       // was -2 pre-fix; effective was -5 due to K-rate duplication bug
    pitcher_h_per_9_asof:     3,
    pitcher_whip_asof:        2,
    pitcher_k_per_9_asof:    -3,
    pitcher_bb_per_9_asof:    1,
    platoon_hit_rate_asof:    1,
    weather_temp_f:           0.5,
    weather_wind_mph:         0,
  },
  bias: 0,
  temperature: 10,
  transform: 'sigmoid',
  target: 'hit_1plus',
  is_validated: false,
  promoted_from_walkforward: null,
  notes:
    'v0.1 — the K-rate double-counting bug in buildHitFeatures was ' +
    'fixed (season_k_rate_asof no longer silently populated from ' +
    'strikeout_rate_l7d) AND season_k_rate_asof removed from the ' +
    'features list. New hash reflects the corrected scoring behaviour. ' +
    'Historical hit_target_snapshots rows keep their pre-fix hash. ' +
    'Still EXPERIMENTAL — walk-forward promotion still pending.',
};

export const HIT_MODEL_2PLUS: HitModelConfig = {
  id: 'experimental_v0_1_det_2plus',
  kind: 'DET',
  features: V0_1_FEATURE_ORDER_2PLUS,
  standardize: 'z_score_per_day',
  fixed_standardization: null,
  weights: {
    season_avg_asof:          5,
    hit_rate_l7d_asof:        3,
    hits_l7d_asof:            2,
    ab_l7d_asof:              1,
    expected_pa:              6,
    recent_k_rate_asof:      -2,       // was -2 pre-fix; effective was -5 due to K-rate duplication bug
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
  temperature: 10,
  transform: 'sigmoid',
  target: 'hit_2plus',
  is_validated: false,
  promoted_from_walkforward: null,
  notes:
    'v0.1 — same K-rate bug fix as the 1+ variant. New hash reflects ' +
    'the corrected scoring behaviour. Historical rows keep their ' +
    'pre-fix hash. Still EXPERIMENTAL.',
};

// ---------------------------------------------------------------------
// v2 EXPERIMENT — side-by-side with v1, not a replacement
// ---------------------------------------------------------------------
//
// User-approved changes vs v1 (from the rank-ordering diagnostic):
//   - hit_rate_l7d_asof: 3 → 1   (materially reduced, not removed)
//   - pitcher_whip_asof: 2 → 0.5 (recognises ρ=0.877 with H/9;
//     not fully removed on 7 dates of evidence alone)
//   - season_k_rate_asof: excluded (same K-rate bug fix; if it re-
//     appears in the feature builder later, v2 configs won't try to
//     read it)
//   - recent_k_rate_asof: -2 (unchanged; the diagnostic showed the
//     historical -5 effective weight came from the K-rate duplication
//     bug, and user does not want to preserve that accidental weight)
//   - Every other weight unchanged from v1
//
// Temperature kept at 10 so v1 and v2 Hit Score magnitudes are directly
// comparable in the disagreement view.
//
// is_validated stays false — v2 becomes validated only through the same
// walk-forward promotion guardrails as v1 would.

export const HIT_MODEL_1PLUS_V2: HitModelConfig = {
  id: 'experimental_v2_det_1plus',
  kind: 'DET',
  features: V2_FEATURE_ORDER_1PLUS,
  standardize: 'z_score_per_day',
  fixed_standardization: null,
  weights: {
    season_avg_asof:          6,
    hit_rate_l7d_asof:        1,       // v1: 3
    hits_l7d_asof:            1,
    ab_l7d_asof:              0,
    expected_pa:              5,
    recent_k_rate_asof:      -2,
    pitcher_h_per_9_asof:     3,
    pitcher_whip_asof:        0.5,     // v1: 2 (ρ=0.877 with H/9)
    pitcher_k_per_9_asof:    -3,
    pitcher_bb_per_9_asof:    1,
    platoon_hit_rate_asof:    1,
    weather_temp_f:           0.5,
    weather_wind_mph:         0,
  },
  bias: 0,
  temperature: 10,
  transform: 'sigmoid',
  target: 'hit_1plus',
  is_validated: false,
  promoted_from_walkforward: null,
  notes:
    'v2 experiment (1+). Reduced hit_rate_l7d 3→1 to test the ' +
    'no-recent-rate ablation finding. Reduced pitcher_whip 2→0.5 to ' +
    'partially deduplicate with H/9 (ρ=0.877). Pitcher context and ' +
    'season/opportunity signals preserved. Runs side-by-side with v1; ' +
    'promotion decided by prospective walk-forward performance.',
};

export const HIT_MODEL_2PLUS_V2: HitModelConfig = {
  id: 'experimental_v2_det_2plus',
  kind: 'DET',
  features: V2_FEATURE_ORDER_2PLUS,
  standardize: 'z_score_per_day',
  fixed_standardization: null,
  weights: {
    season_avg_asof:          5,
    hit_rate_l7d_asof:        1,       // v1: 3 — ablation showed Top-3 38.1 → 47.6, mono 0.216 → 0.310
    hits_l7d_asof:            2,
    ab_l7d_asof:              1,
    expected_pa:              6,
    recent_k_rate_asof:      -2,
    pitcher_h_per_9_asof:     3,
    pitcher_whip_asof:        0.5,     // v1: 2
    pitcher_k_per_9_asof:    -2,
    pitcher_bb_per_9_asof:    1,
    platoon_hit_rate_asof:    1,
    weather_temp_f:           0.5,
    weather_wind_mph:         0,
    multi_hit_rate_l10g_asof: 4,
  },
  bias: 0,
  temperature: 10,
  transform: 'sigmoid',
  target: 'hit_2plus',
  is_validated: false,
  promoted_from_walkforward: null,
  notes:
    'v2 experiment (2+). Same reductions as v2 1+. Multi-hit rate + ' +
    'expected_pa + pitcher context all preserved per the ablation ' +
    'evidence (no_pitcher damaged 6-10 bucket). Runs side-by-side ' +
    'with v1; promotion decided by prospective walk-forward performance.',
};

/** Cached at module-load so writers don't recompute per row. Safe to
 *  export — the hash of an immutable config never changes at runtime. */
export const HIT_MODEL_1PLUS_HASH = hashConfig(HIT_MODEL_1PLUS);
export const HIT_MODEL_2PLUS_HASH = hashConfig(HIT_MODEL_2PLUS);
export const HIT_MODEL_1PLUS_V2_HASH = hashConfig(HIT_MODEL_1PLUS_V2);
export const HIT_MODEL_2PLUS_V2_HASH = hashConfig(HIT_MODEL_2PLUS_V2);

// ---------------------------------------------------------------------
// HIT_MODEL_VERSIONS — the source of truth for which model_versions
// exist and which config pair scores each. snapshotHitTargets iterates
// this array so future v3/v4 additions are a one-file edit.
//
// The model_version int matches the model_version column on
// hit_target_universe / hit_target_snapshots — that column is what the
// UI's model selector filters by.
// ---------------------------------------------------------------------

export interface HitModelVersionSpec {
  version: number;
  label: string;                  // 'v1 Current' | 'v2 Experimental' etc.
  is_default: boolean;            // which one the UI shows by default
  config_1plus: HitModelConfig;
  config_2plus: HitModelConfig;
}

export const HIT_MODEL_VERSIONS: HitModelVersionSpec[] = [
  {
    version: 1,
    label: 'v1 Current',
    is_default: true,
    config_1plus: HIT_MODEL_1PLUS,
    config_2plus: HIT_MODEL_2PLUS,
  },
  {
    version: 2,
    label: 'v2 Experimental',
    is_default: false,
    config_1plus: HIT_MODEL_1PLUS_V2,
    config_2plus: HIT_MODEL_2PLUS_V2,
  },
];

/** Small utility: dump every model version's ids + hashes so an operator
 *  editing this file can paste the new values into their commit message.
 *  Called at the start of snapshotHitTargets to log which configs scored
 *  the run into stdout. */
export function describeHitModels(): string {
  const lines: string[] = ['Hit model configs:'];
  for (const v of HIT_MODEL_VERSIONS) {
    lines.push(
      `  v${v.version} (${v.label})` + (v.is_default ? '  [default]' : ''),
      `    1+: id=${v.config_1plus.id.padEnd(36)} hash=${hashConfig(v.config_1plus)}  validated=${v.config_1plus.is_validated}`,
      `    2+: id=${v.config_2plus.id.padEnd(36)} hash=${hashConfig(v.config_2plus)}  validated=${v.config_2plus.is_validated}`,
    );
  }
  return lines.join('\n');
}
