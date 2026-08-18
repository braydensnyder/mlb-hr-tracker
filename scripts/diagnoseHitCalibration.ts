/**
 * diagnoseHitCalibration — audit the calibration of the current Hit
 * Score outputs against actual outcomes on frozen snapshot history.
 *
 * READ-ONLY. Does not touch the ranker, does not change any config,
 * does not write to hit_target_universe or hit_target_snapshots.
 *
 * For each of the two rankers (1+ and 2+), pulls every enriched
 * hit_target_snapshots row in the range and reports:
 *
 *   1. Overall base rate (P(hits ≥ 1) and P(hits ≥ 2)) on the sample
 *   2. Observed rate by SCORE DECILE (equal-frequency bins over
 *      hit_prob_*), so we can see whether the ranker's monotone
 *      output tracks empirical hit rate
 *   3. Observed rate by RANK BUCKET (1–3, 4–5, 6–10, 11–25, 26–50,
 *      51+, ordered so you can spot lift decay)
 *   4. Brier score: mean((predicted − actual)^2). Lower is better.
 *      For reference: predicting the base rate on every row = the
 *      Brier for a "no-skill" model.
 *   5. Calibration error: weighted mean absolute gap between predicted
 *      probability (bin mean) and observed hit rate (bin mean).
 *   6. Recommended calibration approach for the sample size:
 *        - < 200 rows → neither, sample too small
 *        - 200–500 → Platt (1-parameter logistic on the score)
 *        - 500+ → isotonic (non-parametric, more flexible)
 *   7. Expected calibrated probability for #1 / #3 / #5 / #10 based on
 *      the observed rank-bucket rates (uses simple bucket-mean, not a
 *      fitted curve — that's a Phase-later commit).
 *
 * Usage:
 *   npm run diagnose:hit-calibration                   # all enriched history
 *   npm run diagnose:hit-calibration -- --last 30
 *   npm run diagnose:hit-calibration -- --from D1 --to D2
 *   npm run diagnose:hit-calibration -- --min-rows 100
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

const MODEL_VERSION = 1;

interface Args { from: string | null; to: string; minRows: number; }
function parseArgs(argv: string[]): Args {
  let from: string | null = null, to = mlbToday(), last: number | null = null, minRows = 20;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--min-rows') minRows = Number(argv[++i]);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) from = to = a;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (last != null && !from) from = mlbAddDays(to, -(last - 1));
  return { from, to, minRows };
}

interface Row {
  target_date: string;
  player_id: number;
  rank_1plus: number | null;
  hit_prob_1plus: number | null;
  hit_score_1plus: number | null;
  rank_2plus: number | null;
  hit_prob_2plus: number | null;
  hit_score_2plus: number | null;
  hits: number | null;
  hit_1plus: boolean | null;
  hit_2plus: boolean | null;
  outcome_enriched_at: string | null;
  model_config_id_1plus: string;
  model_config_hash_1plus: string;
  model_config_id_2plus: string;
  model_config_hash_2plus: string;
}

async function loadEnrichedRows(from: string | null, to: string): Promise<Row[]> {
  const out: Row[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 200; page++) {
    let q = supabaseAdmin
      .from('hit_target_snapshots')
      .select(
        'target_date, player_id, rank_1plus, hit_prob_1plus, hit_score_1plus, ' +
        'rank_2plus, hit_prob_2plus, hit_score_2plus, ' +
        'hits, hit_1plus, hit_2plus, outcome_enriched_at, ' +
        'model_config_id_1plus, model_config_hash_1plus, ' +
        'model_config_id_2plus, model_config_hash_2plus',
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
    const rows = (data ?? []) as unknown as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function mean(xs: number[]): number { return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN; }

/** Equal-frequency deciles over a numeric column. Returns 10 bins;
 *  bin i covers indexes [i * n/10, (i+1) * n/10). Ties keep sort order. */
function decilize(rows: Row[], probKey: 'hit_prob_1plus' | 'hit_prob_2plus'): Array<{ bin: number; n: number; mean_pred: number; mean_obs: number; low: number; high: number }> {
  const usable = rows
    .filter((r) => r[probKey] != null && r.hit_1plus != null)
    .map((r) => ({ pred: r[probKey] as number, obs: probKey === 'hit_prob_1plus' ? (r.hit_1plus ? 1 : 0) : (r.hit_2plus ? 1 : 0) }))
    .sort((a, b) => a.pred - b.pred);
  const n = usable.length;
  const out: Array<{ bin: number; n: number; mean_pred: number; mean_obs: number; low: number; high: number }> = [];
  for (let i = 0; i < 10; i++) {
    const lo = Math.floor((i * n) / 10);
    const hi = Math.floor(((i + 1) * n) / 10);
    const slice = usable.slice(lo, hi);
    if (slice.length === 0) { out.push({ bin: i + 1, n: 0, mean_pred: NaN, mean_obs: NaN, low: NaN, high: NaN }); continue; }
    out.push({
      bin: i + 1,
      n: slice.length,
      mean_pred: mean(slice.map((r) => r.pred)),
      mean_obs: mean(slice.map((r) => r.obs)),
      low: slice[0].pred,
      high: slice[slice.length - 1].pred,
    });
  }
  return out;
}

/** Rank buckets requested in the audit prompt. */
const RANK_BUCKETS: Array<{ key: string; lo: number; hi: number }> = [
  { key: '1-3',    lo: 1,   hi: 3 },
  { key: '4-5',    lo: 4,   hi: 5 },
  { key: '6-10',   lo: 6,   hi: 10 },
  { key: '11-25',  lo: 11,  hi: 25 },
  { key: '26-50',  lo: 26,  hi: 50 },
  { key: '51+',    lo: 51,  hi: Number.POSITIVE_INFINITY },
];

function bucketByRank(rows: Row[], rankKey: 'rank_1plus' | 'rank_2plus', outcomeKey: 'hit_1plus' | 'hit_2plus'): Array<{ key: string; n: number; hits: number; rate: number; mean_pred: number }> {
  return RANK_BUCKETS.map((b) => {
    const inB = rows.filter((r) => {
      const rk = r[rankKey];
      return rk != null && rk >= b.lo && rk <= b.hi && r[outcomeKey] != null;
    });
    const hits = inB.reduce((s, r) => s + (r[outcomeKey] ? 1 : 0), 0);
    const probKey = outcomeKey === 'hit_1plus' ? 'hit_prob_1plus' : 'hit_prob_2plus';
    const preds = inB.map((r) => r[probKey]).filter((v): v is number => typeof v === 'number');
    return {
      key: b.key,
      n: inB.length,
      hits,
      rate: inB.length > 0 ? hits / inB.length : NaN,
      mean_pred: mean(preds),
    };
  });
}

function brier(rows: Row[], probKey: 'hit_prob_1plus' | 'hit_prob_2plus', outcomeKey: 'hit_1plus' | 'hit_2plus'): { n: number; brier: number; brier_baseline: number } {
  const usable = rows.filter((r) => r[probKey] != null && r[outcomeKey] != null);
  if (usable.length === 0) return { n: 0, brier: NaN, brier_baseline: NaN };
  const base = mean(usable.map((r) => (r[outcomeKey] ? 1 : 0)));
  let bs = 0, bsBase = 0;
  for (const r of usable) {
    const y = r[outcomeKey] ? 1 : 0;
    const p = r[probKey] as number;
    bs += (p - y) ** 2;
    bsBase += (base - y) ** 2;
  }
  return { n: usable.length, brier: bs / usable.length, brier_baseline: bsBase / usable.length };
}

/** Weighted mean absolute gap between per-decile predicted mean and
 *  observed mean, weighted by bin count. A rough calibration-error
 *  metric (Expected Calibration Error style). */
function calibrationError(deciles: ReturnType<typeof decilize>): number {
  const valid = deciles.filter((d) => d.n > 0 && Number.isFinite(d.mean_pred) && Number.isFinite(d.mean_obs));
  const total = valid.reduce((s, d) => s + d.n, 0);
  if (total === 0) return NaN;
  return valid.reduce((s, d) => s + d.n * Math.abs(d.mean_pred - d.mean_obs), 0) / total;
}

function recommendCalibrationMethod(n: number): { name: string; note: string } {
  if (n < 200) return { name: 'NONE', note: 'sample < 200 rows — Platt is too noisy; isotonic is too flexible. Show ranker output as a rank-anchored score only until more history exists.' };
  if (n < 500) return { name: 'Platt (1-parameter logistic)', note: 'sample 200-500 — Platt is defensible (2 free parameters, learns a monotone rescaling). Isotonic risks overfitting.' };
  if (n < 2000) return { name: 'Platt or isotonic (Platt is safer)', note: 'sample 500-2000 — isotonic is fine but Platt is more stable; cross-validate.' };
  return { name: 'Isotonic (non-parametric, monotone)', note: 'sample ≥ 2000 — isotonic gives a proper flexible rank-to-probability curve.' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n═══ Hit Score calibration audit ═══`);
  console.log(`  range: ${args.from ?? '(all history)'} .. ${args.to}`);
  console.log(`  min rows for a bucket to report: ${args.minRows}\n`);

  const rows = await loadEnrichedRows(args.from, args.to);
  console.log(`  loaded ${rows.length} enriched hit_target_snapshots row(s) (model_version=${MODEL_VERSION})`);
  if (rows.length === 0) {
    console.log(`\n  Nothing to audit. Backfill hit_target_snapshots via snapshot:hits and enrich:hit-outcomes first.\n`);
    return;
  }

  // Coverage summary — unique dates + model hash distribution.
  const dates = new Set(rows.map((r) => r.target_date));
  const hashes1 = new Set(rows.map((r) => r.model_config_hash_1plus));
  const hashes2 = new Set(rows.map((r) => r.model_config_hash_2plus));
  console.log(`  unique dates: ${dates.size}`);
  console.log(`  distinct 1+ config hashes represented: ${[...hashes1].join(', ')}`);
  console.log(`  distinct 2+ config hashes represented: ${[...hashes2].join(', ')}`);
  console.log(`  ⚠ if multiple hashes appear, some rows were scored under an OLDER config. Bucket rates are still honest per-row (each row was scored by the hash it carries), but the mean predicted probability across the whole sample mixes calibrations.\n`);

  // Base rates
  const base1 = mean(rows.filter((r) => r.hit_1plus != null).map((r) => (r.hit_1plus ? 1 : 0)));
  const base2 = mean(rows.filter((r) => r.hit_2plus != null).map((r) => (r.hit_2plus ? 1 : 0)));
  console.log(`  Overall base rates on the sample:`);
  console.log(`    P(hits ≥ 1) = ${(base1 * 100).toFixed(1)}%`);
  console.log(`    P(hits ≥ 2) = ${(base2 * 100).toFixed(1)}%\n`);

  function reportSide(label: string, probKey: 'hit_prob_1plus' | 'hit_prob_2plus', rankKey: 'rank_1plus' | 'rank_2plus', outcomeKey: 'hit_1plus' | 'hit_2plus') {
    console.log(`── ${label} ──`);

    // Score deciles
    console.log(`\n  Observed hit rate by score decile (equal-frequency bins; low → high predicted):`);
    console.log(`    ${'decile'.padEnd(8)}  ${'n'.padStart(5)}  ${'pred_lo'.padStart(8)}  ${'pred_hi'.padStart(8)}  ${'mean_pred'.padStart(10)}  ${'observed'.padStart(10)}  ${'gap'.padStart(8)}`);
    const dec = decilize(rows, probKey);
    for (const d of dec) {
      if (d.n < args.minRows) {
        console.log(`    ${String(d.bin).padStart(6)}   ${String(d.n).padStart(5)}  ${'-'.padStart(8)}  ${'-'.padStart(8)}  ${'-'.padStart(10)}  ${'-'.padStart(10)}  ${'insuff'.padStart(8)}`);
        continue;
      }
      const gap = d.mean_pred - d.mean_obs;
      console.log(`    ${String(d.bin).padStart(6)}   ${String(d.n).padStart(5)}  ${d.low.toFixed(4).padStart(8)}  ${d.high.toFixed(4).padStart(8)}  ${(d.mean_pred * 100).toFixed(1).padStart(9)}%  ${(d.mean_obs * 100).toFixed(1).padStart(9)}%  ${(gap * 100).toFixed(1).padStart(6)}pp`);
    }

    // Rank buckets
    console.log(`\n  Observed hit rate by rank bucket:`);
    console.log(`    ${'bucket'.padEnd(8)}  ${'n'.padStart(5)}  ${'hits'.padStart(5)}  ${'rate'.padStart(7)}  ${'mean_pred'.padStart(10)}  ${'gap'.padStart(8)}`);
    const buckets = bucketByRank(rows, rankKey, outcomeKey);
    for (const b of buckets) {
      if (b.n < args.minRows) {
        console.log(`    ${b.key.padEnd(8)}  ${String(b.n).padStart(5)}  ${String(b.hits).padStart(5)}  ${'-'.padStart(7)}  ${'-'.padStart(10)}  ${'insuff'.padStart(8)}`);
        continue;
      }
      const gap = b.mean_pred - b.rate;
      console.log(`    ${b.key.padEnd(8)}  ${String(b.n).padStart(5)}  ${String(b.hits).padStart(5)}  ${(b.rate * 100).toFixed(1).padStart(6)}%  ${(b.mean_pred * 100).toFixed(1).padStart(9)}%  ${(gap * 100).toFixed(1).padStart(6)}pp`);
    }

    // Brier + calibration error
    const b = brier(rows, probKey, outcomeKey);
    const ce = calibrationError(dec);
    console.log(`\n  Brier score: ${b.brier.toFixed(4)} (baseline "always predict base rate" = ${b.brier_baseline.toFixed(4)})`);
    console.log(`  Weighted calibration error across deciles: ${(ce * 100).toFixed(1)}pp`);

    // What #1/#3/#5/#10 SHOULD receive (from the bucket rates, if sample is sufficient)
    console.log(`\n  Bucket-based expected calibrated probability for top ranks:`);
    const b13 = buckets.find((x) => x.key === '1-3');
    const b45 = buckets.find((x) => x.key === '4-5');
    const b610 = buckets.find((x) => x.key === '6-10');
    if (b13 && b13.n >= args.minRows) console.log(`    #1-3   → ${(b13.rate * 100).toFixed(1)}% (n=${b13.n})`);
    else console.log(`    #1-3   → insufficient sample (n=${b13?.n ?? 0})`);
    if (b45 && b45.n >= args.minRows) console.log(`    #4-5   → ${(b45.rate * 100).toFixed(1)}% (n=${b45.n})`);
    else console.log(`    #4-5   → insufficient sample (n=${b45?.n ?? 0})`);
    if (b610 && b610.n >= args.minRows) console.log(`    #6-10  → ${(b610.rate * 100).toFixed(1)}% (n=${b610.n})`);
    else console.log(`    #6-10  → insufficient sample (n=${b610?.n ?? 0})`);
    console.log('');
  }

  reportSide('1+ Hit', 'hit_prob_1plus', 'rank_1plus', 'hit_1plus');
  reportSide('2+ Hits', 'hit_prob_2plus', 'rank_2plus', 'hit_2plus');

  // Sample-size recommendation
  const method = recommendCalibrationMethod(rows.length);
  console.log(`══ Calibration method recommendation ══`);
  console.log(`  sample size: ${rows.length} rows across ${dates.size} dates`);
  console.log(`  recommended: ${method.name}`);
  console.log(`  ${method.note}\n`);

  console.log(`Reading guide:`);
  console.log(`  • 'gap' = predicted − observed. Positive gap = we overpredicted. `);
  console.log(`  • Ranker is doing its job if the decile 'observed' rates are monotonically increasing.`);
  console.log(`  • For a calibrated ranker the decile mean_pred would match mean_obs (small gap).`);
  console.log(`  • Brier below the baseline = model has predictive value. Above baseline = worse than predicting the average.`);
  console.log(`  • Ranking order is INDEPENDENT of calibration — a poorly-calibrated ranker can still rank correctly. Calibration only fixes the value shown, not the ordering.\n`);
}

main().catch((err) => {
  console.error(`\n[diagnoseHitCalibration] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
