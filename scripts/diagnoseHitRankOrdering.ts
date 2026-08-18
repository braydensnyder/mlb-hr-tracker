/**
 * diagnoseHitRankOrdering — investigate why rank buckets are not
 * monotonically decreasing in observed hit rate on the current
 * snapshot history.
 *
 * READ-ONLY. Does NOT change the ranker, weights, calibration, or
 * any persisted row.
 *
 * For each outcome (1+ Hit and 2+ Hits) separately:
 *
 *   PART A — group-comparison table
 *     Groups (defined by the ranker's rank_* and the enriched outcome):
 *       A. Top-10 hit players            (rank ≤ 10, hit = true)
 *       B. Top-10 misses                 (rank ≤ 10, hit = false)
 *       C. 11-25 hit players             (rank 11..25, hit = true)
 *       D. 26-50 hit players             (rank 26..50, hit = true)
 *     For every raw feature, standardized value, weighted contribution
 *     and the final linear_score, report mean + median per group.
 *
 *   PART B — analytical answers (auto-generated from group means)
 *     1. Features systematically too high among Top-10 misses
 *        (mean_missA - mean_hitB where standardized > 0)
 *     2. Features systematically stronger among 11-50 hitters
 *     3. Contributions most responsible for pushing 11-50 hitters
 *        below Top 10
 *     4. Does lineup opportunity (expected_pa) explain buried hitters?
 *     5. Is weather overweighted vs its typical magnitude?
 *     6. Are recent-hit variables double-counting? (Pearson within
 *        the sample)
 *     7. Is pitcher context pushing players too aggressively?
 *
 *   PART C — leave-one-out reranks on the same seven dates
 *     Configs:
 *       full            (baseline)
 *       no_weather      (drop weather_temp_f, weather_wind_mph)
 *       no_recent_rate  (drop hit_rate_l7d_asof)
 *       no_recent_volume(drop hits_l7d_asof, ab_l7d_asof)
 *       no_whip         (drop pitcher_whip_asof)
 *       no_platoon      (drop platoon_hit_rate_asof)
 *       no_pitcher      (drop all pitcher_* features)
 *       opportunity     (keep season_avg, expected_pa, season_k_rate,
 *                        recent_k_rate, platoon, multi_hit only)
 *     Since contributions[k] = weight[k] * z[k] were already computed at
 *     scoring time, we don't need to re-run pool standardisation to
 *     re-rank — new_linear = linear_score - sum(dropped contributions).
 *     Per date, re-sort by new_linear, then aggregate outcome rates by
 *     rank bucket (1-3, 4-5, 6-10, 11-25, 26-50, 51+).
 *
 * The goal is NOT the highest Top-N rate on 7 days. It's to see which
 * component is DE-monotonising the rank buckets and whether removing it
 * (a) restores monotonicity and (b) preserves lift over baseline.
 *
 * Usage:
 *   npm run diagnose:hit-ordering
 *   npm run diagnose:hit-ordering -- --from 2026-08-10 --to 2026-08-16
 *   npm run diagnose:hit-ordering -- --last 14
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

const MODEL_VERSION = 1;

interface Args { from: string | null; to: string; minGroupN: number; }
function parseArgs(argv: string[]): Args {
  let from: string | null = null, to = mlbToday(), last: number | null = null, minGroupN = 10;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--min-group-n') minGroupN = Number(argv[++i]);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) from = to = a;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (last != null && !from) from = mlbAddDays(to, -(last - 1));
  return { from, to, minGroupN };
}

interface Row {
  target_date: string;
  player_id: number;
  player_name: string;
  rank_1plus: number | null;
  rank_2plus: number | null;
  hit_1plus: boolean | null;
  hit_2plus: boolean | null;
  contribs_1plus: {
    base_features: Record<string, number | null>;
    standardized: Record<string, number>;
    contributions: Record<string, number>;
    linear_score: number;
    model?: { features_used?: string[] };
  } | null;
  contribs_2plus: {
    base_features: Record<string, number | null>;
    standardized: Record<string, number>;
    contributions: Record<string, number>;
    linear_score: number;
    model?: { features_used?: string[] };
  } | null;
}

async function loadRows(from: string | null, to: string): Promise<Row[]> {
  const out: Row[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 100; page++) {
    let q = supabaseAdmin
      .from('hit_target_snapshots')
      .select(
        'target_date, player_id, player_name, ' +
        'rank_1plus, rank_2plus, hit_1plus, hit_2plus, ' +
        'contributions_1plus_json, contributions_2plus_json',
      )
      .eq('model_version', MODEL_VERSION)
      .not('outcome_enriched_at', 'is', null);
    if (from) q = q.gte('target_date', from);
    q = q.lte('target_date', to);
    const { data, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(error.message);
    }
    const rows = (data ?? []) as unknown as Array<Row & { contributions_1plus_json: any; contributions_2plus_json: any }>;
    for (const r of rows) {
      out.push({
        target_date: r.target_date,
        player_id: r.player_id,
        player_name: r.player_name,
        rank_1plus: r.rank_1plus,
        rank_2plus: r.rank_2plus,
        hit_1plus: r.hit_1plus,
        hit_2plus: r.hit_2plus,
        contribs_1plus: r.contributions_1plus_json,
        contribs_2plus: r.contributions_2plus_json,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

function mean(xs: number[]): number { return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN; }
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return NaN;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  const d = Math.sqrt(dx * dy);
  return d > 0 ? num / d : 0;
}
function fmtN(x: number, dp = 3): string { return Number.isFinite(x) ? x.toFixed(dp).padStart(7) : '   -   '; }

// -------------------------------------------------------------------
// Feature keys the ranker uses. Kept in sync with hitModels.ts DET
// presets by convention.
// -------------------------------------------------------------------
const FEATURE_KEYS_1PLUS = [
  'season_avg_asof', 'hit_rate_l7d_asof', 'hits_l7d_asof', 'ab_l7d_asof',
  'expected_pa', 'season_k_rate_asof', 'recent_k_rate_asof',
  'pitcher_h_per_9_asof', 'pitcher_whip_asof', 'pitcher_k_per_9_asof', 'pitcher_bb_per_9_asof',
  'platoon_hit_rate_asof', 'weather_temp_f', 'weather_wind_mph',
];
const FEATURE_KEYS_2PLUS = [...FEATURE_KEYS_1PLUS, 'multi_hit_rate_l10g_asof'];

const ABLATIONS: Array<{ id: string; label: string; drop?: string[]; keepOnly?: string[] }> = [
  { id: 'full',             label: 'Full (baseline)' },
  { id: 'no_weather',       label: 'No weather',           drop: ['weather_temp_f', 'weather_wind_mph'] },
  { id: 'no_recent_rate',   label: 'No recent hit rate',   drop: ['hit_rate_l7d_asof'] },
  { id: 'no_recent_volume', label: 'No recent volume',     drop: ['hits_l7d_asof', 'ab_l7d_asof'] },
  { id: 'no_whip',          label: 'No pitcher WHIP',      drop: ['pitcher_whip_asof'] },
  { id: 'no_platoon',       label: 'No platoon',           drop: ['platoon_hit_rate_asof'] },
  { id: 'no_pitcher',       label: 'No pitcher context',   drop: ['pitcher_h_per_9_asof', 'pitcher_k_per_9_asof', 'pitcher_bb_per_9_asof', 'pitcher_whip_asof'] },
  { id: 'opportunity',      label: 'Opportunity-only',     keepOnly: ['season_avg_asof', 'expected_pa', 'season_k_rate_asof', 'recent_k_rate_asof', 'platoon_hit_rate_asof', 'multi_hit_rate_l10g_asof'] },
];

const RANK_BUCKETS: Array<{ key: string; lo: number; hi: number }> = [
  { key: '1-3', lo: 1, hi: 3 },
  { key: '4-5', lo: 4, hi: 5 },
  { key: '6-10', lo: 6, hi: 10 },
  { key: '11-25', lo: 11, hi: 25 },
  { key: '26-50', lo: 26, hi: 50 },
  { key: '51+', lo: 51, hi: Number.POSITIVE_INFINITY },
];

// -------------------------------------------------------------------
// PART A — group comparison
// -------------------------------------------------------------------

interface GroupStats {
  n: number;
  raw_mean: Record<string, number>;    raw_median: Record<string, number>;
  z_mean: Record<string, number>;      z_median: Record<string, number>;
  contrib_mean: Record<string, number>;contrib_median: Record<string, number>;
  linear_mean: number;                 linear_median: number;
}

function computeGroupStats(rows: Row[], side: '1plus' | '2plus', featureKeys: string[]): GroupStats {
  const raw: Record<string, number[]> = {};
  const z:   Record<string, number[]> = {};
  const c:   Record<string, number[]> = {};
  const lin: number[] = [];
  for (const k of featureKeys) { raw[k] = []; z[k] = []; c[k] = []; }
  for (const r of rows) {
    const cb = side === '1plus' ? r.contribs_1plus : r.contribs_2plus;
    if (!cb) continue;
    lin.push(cb.linear_score);
    for (const k of featureKeys) {
      const rv = cb.base_features[k];
      if (typeof rv === 'number' && Number.isFinite(rv)) raw[k].push(rv);
      const zv = cb.standardized[k];
      if (typeof zv === 'number' && Number.isFinite(zv)) z[k].push(zv);
      const cv = cb.contributions[k];
      if (typeof cv === 'number' && Number.isFinite(cv)) c[k].push(cv);
    }
  }
  const raw_mean: Record<string, number> = {}, raw_median: Record<string, number> = {};
  const z_mean: Record<string, number> = {}, z_median: Record<string, number> = {};
  const contrib_mean: Record<string, number> = {}, contrib_median: Record<string, number> = {};
  for (const k of featureKeys) {
    raw_mean[k] = mean(raw[k]);       raw_median[k] = median(raw[k]);
    z_mean[k] = mean(z[k]);           z_median[k] = median(z[k]);
    contrib_mean[k] = mean(c[k]);     contrib_median[k] = median(c[k]);
  }
  return { n: rows.length, raw_mean, raw_median, z_mean, z_median, contrib_mean, contrib_median, linear_mean: mean(lin), linear_median: median(lin) };
}

function printGroupTable(side: '1plus' | '2plus', featureKeys: string[], groups: Record<'A' | 'B' | 'C' | 'D', GroupStats>) {
  const label = side === '1plus' ? '1+ Hit' : '2+ Hits';
  console.log(`\n══ Group comparison — ${label} ══`);
  console.log(`   A = Top-10 hit players       (n=${groups.A.n})`);
  console.log(`   B = Top-10 misses            (n=${groups.B.n})`);
  console.log(`   C = 11-25 hit players        (n=${groups.C.n})`);
  console.log(`   D = 26-50 hit players        (n=${groups.D.n})`);

  console.log(`\n   Raw feature MEANS (before standardisation):`);
  console.log(`     ${'feature'.padEnd(30)}  ${'A_hit10'.padStart(9)}  ${'B_miss10'.padStart(9)}  ${'C_hit1125'.padStart(10)}  ${'D_hit2650'.padStart(10)}`);
  for (const k of featureKeys) {
    console.log(`     ${k.padEnd(30)}  ${fmtN(groups.A.raw_mean[k])}  ${fmtN(groups.B.raw_mean[k])}  ${fmtN(groups.C.raw_mean[k]).padStart(10)}  ${fmtN(groups.D.raw_mean[k]).padStart(10)}`);
  }

  console.log(`\n   STANDARDISED feature means (per-day z-scores):`);
  console.log(`     ${'feature'.padEnd(30)}  ${'A_hit10'.padStart(9)}  ${'B_miss10'.padStart(9)}  ${'C_hit1125'.padStart(10)}  ${'D_hit2650'.padStart(10)}`);
  for (const k of featureKeys) {
    console.log(`     ${k.padEnd(30)}  ${fmtN(groups.A.z_mean[k])}  ${fmtN(groups.B.z_mean[k])}  ${fmtN(groups.C.z_mean[k]).padStart(10)}  ${fmtN(groups.D.z_mean[k]).padStart(10)}`);
  }

  console.log(`\n   Weighted CONTRIBUTION means (weight × z):`);
  console.log(`     ${'feature'.padEnd(30)}  ${'A_hit10'.padStart(9)}  ${'B_miss10'.padStart(9)}  ${'C_hit1125'.padStart(10)}  ${'D_hit2650'.padStart(10)}`);
  for (const k of featureKeys) {
    console.log(`     ${k.padEnd(30)}  ${fmtN(groups.A.contrib_mean[k])}  ${fmtN(groups.B.contrib_mean[k])}  ${fmtN(groups.C.contrib_mean[k]).padStart(10)}  ${fmtN(groups.D.contrib_mean[k]).padStart(10)}`);
  }
  console.log(`     ${'linear_score'.padEnd(30)}  ${fmtN(groups.A.linear_mean)}  ${fmtN(groups.B.linear_mean)}  ${fmtN(groups.C.linear_mean).padStart(10)}  ${fmtN(groups.D.linear_mean).padStart(10)}`);
}

// -------------------------------------------------------------------
// PART B — analytical answers
// -------------------------------------------------------------------

function printFindings(side: '1plus' | '2plus', featureKeys: string[], groups: Record<'A' | 'B' | 'C' | 'D', GroupStats>, allRows: Row[]) {
  const label = side === '1plus' ? '1+ Hit' : '2+ Hits';
  console.log(`\n══ Findings — ${label} ══`);

  // Q1: features too high among Top-10 misses.
  //     Look at contribution mean(B) − mean(A). Positive = misses got MORE credit for that feature than hitters did.
  const q1 = featureKeys
    .map((k) => ({ k, diff: (groups.B.contrib_mean[k] ?? 0) - (groups.A.contrib_mean[k] ?? 0) }))
    .filter((x) => Number.isFinite(x.diff) && x.diff > 0.05)
    .sort((a, b) => b.diff - a.diff);
  console.log(`\n   1) Features where TOP-10 MISSES got MORE contribution than Top-10 hitters:`);
  if (q1.length === 0) console.log(`      (none exceeding +0.05 in contribution)`);
  else for (const x of q1.slice(0, 6)) console.log(`      ${x.k.padEnd(30)}  contribution Δ(B−A) = +${x.diff.toFixed(3)}`);

  // Q2: features stronger among 11-50 hitters vs Top-10 hitters
  const q2 = featureKeys
    .map((k) => {
      const cd = (groups.C.contrib_mean[k] ?? 0);
      const dd = (groups.D.contrib_mean[k] ?? 0);
      const midMean = (cd + dd) / 2;
      const aMean = groups.A.contrib_mean[k] ?? 0;
      return { k, diff: midMean - aMean };
    })
    .filter((x) => Number.isFinite(x.diff) && x.diff > 0.05)
    .sort((a, b) => b.diff - a.diff);
  console.log(`\n   2) Features where 11-50 HITTERS got MORE contribution than Top-10 hitters:`);
  if (q2.length === 0) console.log(`      (none exceeding +0.05)`);
  else for (const x of q2.slice(0, 6)) console.log(`      ${x.k.padEnd(30)}  contribution Δ(mid−A) = +${x.diff.toFixed(3)}`);

  // Q3: which contribution had Top-10 hitters HIGHER than 11-50 hitters (i.e., that feature pushed Top-10 hitters above the 11-50 hitters).
  const q3 = featureKeys
    .map((k) => {
      const cd = (groups.C.contrib_mean[k] ?? 0);
      const dd = (groups.D.contrib_mean[k] ?? 0);
      const midMean = (cd + dd) / 2;
      const aMean = groups.A.contrib_mean[k] ?? 0;
      return { k, diff: aMean - midMean };
    })
    .filter((x) => Number.isFinite(x.diff) && x.diff > 0.05)
    .sort((a, b) => b.diff - a.diff);
  console.log(`\n   3) Contributions most responsible for pushing Top-10 hitters ABOVE the buried 11-50 hitters:`);
  if (q3.length === 0) console.log(`      (none exceeding +0.05 — Top-10 vs 11-50 hitters look similar on all features)`);
  else for (const x of q3.slice(0, 6)) console.log(`      ${x.k.padEnd(30)}  contribution Δ(A−mid) = +${x.diff.toFixed(3)}`);

  // Q4: opportunity check.
  const paA = groups.A.raw_mean['expected_pa'];
  const paC = groups.C.raw_mean['expected_pa'];
  const paD = groups.D.raw_mean['expected_pa'];
  const paMid = (paC + paD) / 2;
  console.log(`\n   4) Does lineup opportunity (expected_pa) explain the buried hitters?`);
  console.log(`      Top-10 hitters mean_pa = ${paA.toFixed(3)}   11-50 hitters mean_pa = ${paMid.toFixed(3)}`);
  if (paA - paMid >= 0.05) {
    console.log(`      YES — Top-10 hitters bat higher in the order by ${(paA - paMid).toFixed(3)} expected PA.`);
    console.log(`      The ranker is rewarding lineup opportunity meaningfully; the 11-50 hitters are getting hits despite fewer chances.`);
  } else if (paMid - paA >= 0.05) {
    console.log(`      NO — 11-50 hitters actually bat higher in the order. Opportunity is not the excuse.`);
  } else {
    console.log(`      NOT MEANINGFULLY — expected PA is roughly equal across Top-10 and 11-50 hitter groups.`);
  }

  // Q5: is weather overweighted?
  const wxContribA = Math.abs(groups.A.contrib_mean['weather_temp_f'] ?? 0) + Math.abs(groups.A.contrib_mean['weather_wind_mph'] ?? 0);
  const otherContribA = featureKeys
    .filter((k) => k !== 'weather_temp_f' && k !== 'weather_wind_mph')
    .reduce((s, k) => s + Math.abs(groups.A.contrib_mean[k] ?? 0), 0);
  const wxShare = otherContribA > 0 ? wxContribA / (wxContribA + otherContribA) : 0;
  console.log(`\n   5) Is weather overweighted?`);
  console.log(`      |Σ weather contribution| for Top-10 hitters = ${wxContribA.toFixed(3)}`);
  console.log(`      |Σ other  contribution| for Top-10 hitters = ${otherContribA.toFixed(3)}`);
  console.log(`      weather share of |contribution| = ${(wxShare * 100).toFixed(1)}%  → ${wxShare > 0.10 ? 'HIGH share, consider removing' : wxShare > 0.05 ? 'MODERATE share' : 'LOW share, weather is not a major driver'}`);

  // Q6: recent-hit variables double-counting?
  const pairs: Array<[string, string]> = [
    ['hit_rate_l7d_asof', 'hits_l7d_asof'],
    ['hit_rate_l7d_asof', 'ab_l7d_asof'],
    ['hits_l7d_asof', 'ab_l7d_asof'],
    ['season_k_rate_asof', 'recent_k_rate_asof'],
    ['pitcher_h_per_9_asof', 'pitcher_whip_asof'],
    ['pitcher_bb_per_9_asof', 'pitcher_whip_asof'],
  ];
  console.log(`\n   6) Pearson correlations between related features (all rows in range):`);
  for (const [a, b] of pairs) {
    const xs: number[] = []; const ys: number[] = [];
    for (const r of allRows) {
      const cb = side === '1plus' ? r.contribs_1plus : r.contribs_2plus;
      if (!cb) continue;
      const xv = cb.base_features[a], yv = cb.base_features[b];
      if (typeof xv === 'number' && typeof yv === 'number') { xs.push(xv); ys.push(yv); }
    }
    const rho = pearson(xs, ys);
    const flag = Math.abs(rho) > 0.85 ? '  ⚠ VERY strongly redundant'
             : Math.abs(rho) > 0.70 ? '  ⚠ strongly redundant'
             : Math.abs(rho) > 0.50 ? '  moderate overlap'
             : '';
    console.log(`      ${(a + ' × ' + b).padEnd(60)}  ρ = ${rho.toFixed(3)}${flag}`);
  }

  // Q7: pitcher context aggressiveness — variance of pitcher contributions.
  const pKeys = ['pitcher_h_per_9_asof', 'pitcher_whip_asof', 'pitcher_k_per_9_asof', 'pitcher_bb_per_9_asof'];
  console.log(`\n   7) Pitcher-context contribution spread (Top-10 hitters vs 11-50 hitters):`);
  console.log(`      ${'feature'.padEnd(28)}  ${'A_mean'.padStart(8)}  ${'mid_mean'.padStart(9)}  ${'A_median'.padStart(9)}  ${'mid_med'.padStart(9)}`);
  for (const k of pKeys) {
    const aMed = groups.A.contrib_median[k] ?? NaN;
    const midMed = (( groups.C.contrib_median[k] ?? 0) + (groups.D.contrib_median[k] ?? 0)) / 2;
    const aM = groups.A.contrib_mean[k] ?? NaN;
    const midM = (( groups.C.contrib_mean[k] ?? 0) + (groups.D.contrib_mean[k] ?? 0)) / 2;
    console.log(`      ${k.padEnd(28)}  ${fmtN(aM)}  ${fmtN(midM).padStart(9)}  ${fmtN(aMed).padStart(9)}  ${fmtN(midMed).padStart(9)}`);
  }
}

// -------------------------------------------------------------------
// PART C — leave-one-out reranks
// -------------------------------------------------------------------

function dropContribSum(cb: NonNullable<Row['contribs_1plus']>, dropKeys: string[]): number {
  let s = 0;
  for (const k of dropKeys) {
    const v = cb.contributions[k];
    if (typeof v === 'number' && Number.isFinite(v)) s += v;
  }
  return s;
}
function keepOnlyLinear(cb: NonNullable<Row['contribs_1plus']>, keepKeys: string[]): number {
  // linear = bias + sum(contributions). Bias for DET is 0. To keep only
  // certain features we sum contributions ONLY over the kept subset.
  // (We don't have bias explicitly here, but for the shipping DET
  // presets bias=0 — same result.)
  let s = 0;
  for (const k of keepKeys) {
    const v = cb.contributions[k];
    if (typeof v === 'number' && Number.isFinite(v)) s += v;
  }
  return s;
}

/** For each date, re-rank rows by ablated linear score, then bucket by
 *  rank and compute observed outcome rate per bucket. */
function ablationReport(rows: Row[], side: '1plus' | '2plus', abl: typeof ABLATIONS[number]): Record<string, { n: number; hits: number; rate: number }> {
  const outcomeKey = side === '1plus' ? 'hit_1plus' : 'hit_2plus';
  const rowsByDate = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = rowsByDate.get(r.target_date) ?? [];
    arr.push(r);
    rowsByDate.set(r.target_date, arr);
  }
  const bucketAgg = new Map<string, { n: number; hits: number }>();
  for (const b of RANK_BUCKETS) bucketAgg.set(b.key, { n: 0, hits: 0 });

  for (const [, dayRows] of rowsByDate) {
    const scored = dayRows
      .map((r) => {
        const cb = side === '1plus' ? r.contribs_1plus : r.contribs_2plus;
        if (!cb) return null;
        let newLinear: number;
        if (abl.keepOnly) newLinear = keepOnlyLinear(cb, abl.keepOnly);
        else if (abl.drop) newLinear = cb.linear_score - dropContribSum(cb, abl.drop);
        else newLinear = cb.linear_score;
        const y = r[outcomeKey];
        if (y == null) return null;
        return { r, score: newLinear, y: y ? 1 : 0 };
      })
      .filter((x): x is { r: Row; score: number; y: number } => x != null);
    scored.sort((a, b) => b.score - a.score);
    for (let i = 0; i < scored.length; i++) {
      const rank = i + 1;
      for (const b of RANK_BUCKETS) {
        if (rank >= b.lo && rank <= b.hi) {
          const cur = bucketAgg.get(b.key)!;
          cur.n += 1;
          cur.hits += scored[i].y;
          break;
        }
      }
    }
  }
  const out: Record<string, { n: number; hits: number; rate: number }> = {};
  for (const b of RANK_BUCKETS) {
    const c = bucketAgg.get(b.key)!;
    out[b.key] = { n: c.n, hits: c.hits, rate: c.n > 0 ? c.hits / c.n : NaN };
  }
  return out;
}

/** Monotonicity score: how well the bucket rates decrease from 1-3 to 51+.
 *  Computed as sum of (rate[i] − rate[i+1]) — a perfectly monotonic
 *  sequence gives sum = rate[first] − rate[last]. Negative jumps count
 *  against, so a non-monotonic sequence gives a lower total. */
function monotonicityScore(bucketRates: Record<string, { rate: number }>): number {
  const order = RANK_BUCKETS.map((b) => b.key);
  let s = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const a = bucketRates[order[i]].rate;
    const b = bucketRates[order[i + 1]].rate;
    if (Number.isFinite(a) && Number.isFinite(b)) s += (a - b);
  }
  return s;
}

function printAblationTable(side: '1plus' | '2plus', rows: Row[], baseRate: number) {
  const label = side === '1plus' ? '1+ Hit' : '2+ Hits';
  console.log(`\n══ Leave-one-out reranks — ${label} (slate baseline = ${(baseRate * 100).toFixed(1)}%) ══`);
  const results = ABLATIONS.map((abl) => ({
    abl,
    buckets: ablationReport(rows, side, abl),
  }));
  console.log(`   ${'config'.padEnd(20)}  ${'1-3'.padStart(7)}  ${'4-5'.padStart(7)}  ${'6-10'.padStart(7)}  ${'11-25'.padStart(7)}  ${'26-50'.padStart(7)}  ${'51+'.padStart(7)}  ${'mono'.padStart(6)}`);
  console.log(`   ${'baseline'.padEnd(20)}  ${(baseRate * 100).toFixed(1).padStart(6)}%  ${(baseRate * 100).toFixed(1).padStart(6)}%  ${(baseRate * 100).toFixed(1).padStart(6)}%  ${(baseRate * 100).toFixed(1).padStart(6)}%  ${(baseRate * 100).toFixed(1).padStart(6)}%  ${(baseRate * 100).toFixed(1).padStart(6)}%  ${'—'.padStart(6)}`);
  for (const { abl, buckets } of results) {
    const cells = RANK_BUCKETS.map((b) => {
      const c = buckets[b.key];
      return Number.isFinite(c.rate) ? `${(c.rate * 100).toFixed(1).padStart(6)}%` : `  n=${c.n}  `;
    }).join('  ');
    const mono = monotonicityScore(buckets);
    console.log(`   ${abl.label.padEnd(20)}  ${cells}  ${mono.toFixed(3).padStart(6)}`);
  }
  console.log(`   'mono' = sum of adjacent bucket drops (higher = more monotonically decreasing rank vs hit rate).`);
  console.log(`           positive & similar to 'full' → ablation preserves ordering AND lift`);
  console.log(`           positive & larger than 'full' → ablation IMPROVES monotonicity`);
  console.log(`           negative or zero → ranker is not monotonic on this ablation`);
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n═══ Hit rank-ordering diagnostic ═══`);
  console.log(`  range: ${args.from ?? '(all history)'} .. ${args.to}`);
  console.log(`  min group n for reporting: ${args.minGroupN}`);

  const rows = await loadRows(args.from, args.to);
  console.log(`  loaded ${rows.length} enriched snapshot row(s)`);
  if (rows.length === 0) {
    console.log(`\n  Nothing to analyze. Run backfill:hit-snapshots first.\n`);
    return;
  }

  const dates = new Set(rows.map((r) => r.target_date));
  console.log(`  covering ${dates.size} unique date(s)`);
  const hashesA = new Set<string>();
  for (const r of rows) if (r.contribs_1plus) hashesA.add(((r.contribs_1plus as any).model?.hash) ?? '?');
  console.log(`  contribution blobs present: 1+ = ${rows.filter((r) => r.contribs_1plus).length},  2+ = ${rows.filter((r) => r.contribs_2plus).length}`);

  function processSide(side: '1plus' | '2plus', featureKeys: string[]) {
    const rankKey = side === '1plus' ? 'rank_1plus' : 'rank_2plus';
    const outcomeKey = side === '1plus' ? 'hit_1plus' : 'hit_2plus';
    const enriched = rows.filter((r) => r[rankKey] != null && r[outcomeKey] != null);
    const baseRate = enriched.filter((r) => r[outcomeKey] === true).length / (enriched.length || 1);

    // Groups
    const A = enriched.filter((r) => (r[rankKey] as number) <= 10 && r[outcomeKey] === true);
    const B = enriched.filter((r) => (r[rankKey] as number) <= 10 && r[outcomeKey] === false);
    const C = enriched.filter((r) => { const k = r[rankKey] as number; return k >= 11 && k <= 25 && r[outcomeKey] === true; });
    const D = enriched.filter((r) => { const k = r[rankKey] as number; return k >= 26 && k <= 50 && r[outcomeKey] === true; });
    const groups = {
      A: computeGroupStats(A, side, featureKeys),
      B: computeGroupStats(B, side, featureKeys),
      C: computeGroupStats(C, side, featureKeys),
      D: computeGroupStats(D, side, featureKeys),
    };
    printGroupTable(side, featureKeys, groups);
    if (Math.min(A.length, B.length, C.length, D.length) < args.minGroupN) {
      console.log(`\n   ⚠ At least one group has < ${args.minGroupN} rows — findings below are directional only.`);
    }
    printFindings(side, featureKeys, groups, enriched);
    printAblationTable(side, enriched, baseRate);
  }

  processSide('1plus', FEATURE_KEYS_1PLUS);
  processSide('2plus', FEATURE_KEYS_2PLUS);

  console.log(`\n═══ end of diagnostic ═══\n`);
  console.log(`Reading guide:`);
  console.log(`  • Group tables show the ACTUAL numbers the ranker saw for each subgroup. If Top-10 misses`);
  console.log(`    consistently have higher standardised values on a feature than Top-10 hitters do, that`);
  console.log(`    feature is over-rewarded and pushes the wrong players up.`);
  console.log(`  • Findings section auto-derives the answers to Q1-Q7 from the group means.`);
  console.log(`  • Ablation table: each row is a rerank of THE SAME rows under a different weight set. The`);
  console.log(`    'mono' column measures how monotonic the rank buckets are (higher = better ordering).`);
  console.log(`    An ablation that raises 'mono' meaningfully AND preserves Top-3/Top-5 lift over baseline`);
  console.log(`    is a candidate for a future weight change. NO CHANGES ARE APPLIED HERE.\n`);
}

main().catch((err) => {
  console.error(`\n[diagnoseHitRankOrdering] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
