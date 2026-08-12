/**
 * Rank-conditioned miss analysis (Phase 3).
 *
 * For every date in the given range, join hr_target_universe (canonical
 * full-slate ranks + Phase 1 numeric contributions) with home_runs
 * (actual outcomes) and bucketize:
 *
 *   1-10 · 11-25 · 26-50 · 51-100 · 101-150 · 151+ · UNAVAILABLE
 *
 * UNAVAILABLE = HR hitter not in hr_target_universe at all (never
 * modeled — the candidate-universe fix in mig 018 shrinks this bucket
 * but it can still happen when a player has no season HR and wasn't
 * in a posted lineup).
 *
 * Then run four comparisons:
 *   A. Top-10 rows that homered vs Top-10 rows that did NOT
 *   B. HR hitters ranked 1-10 vs HR hitters ranked 11-25
 *   C. HR hitters ranked 1-10 vs HR hitters ranked 26-50
 *   D. HR hitters ranked 1-10 vs HR hitters ranked 51+
 *
 * For each comparison every numeric contribution is averaged in both
 * groups and the delta is surfaced, sorted by |delta|. Sample sizes
 * are always displayed and marked "insufficient" when n<10 in either
 * group so nothing is concluded from a handful of rows.
 *
 * Also surfaces the top-15 signal PAIRS with the biggest frequency
 * difference between the two groups in each comparison — a first pass
 * at "repeated combinations of signals associated with ranking
 * mistakes."
 *
 * NO changes to Heat Score, weights, or any model. Read-only analysis.
 *
 * Usage:
 *   npm run learning:analyze-misses                    # last 30 days
 *   npm run learning:analyze-misses -- --from 2026-07-01 --to 2026-08-10
 *   npm run learning:analyze-misses -- --last 14
 *   npm run learning:analyze-misses -- --model 1        # default v1
 *   npm run learning:analyze-misses -- --csv out.csv    # also dump per-row CSV
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';

// ---------- Config ----------

interface Bucket { key: string; lo: number; hi: number; }
const BUCKETS: Bucket[] = [
  { key: '1-10',    lo: 1,   hi: 10 },
  { key: '11-25',   lo: 11,  hi: 25 },
  { key: '26-50',   lo: 26,  hi: 50 },
  { key: '51-100',  lo: 51,  hi: 100 },
  { key: '101-150', lo: 101, hi: 150 },
  { key: '151+',    lo: 151, hi: Number.POSITIVE_INFINITY },
];
const UNAVAILABLE = 'UNAVAILABLE';
const MIN_SAMPLE = 10; // don't draw conclusions below this

// All contribution keys we surface in comparisons. Structure mirrors
// HrTargetContributions in src/lib/stats.ts.
const CONTRIB_KEYS = [
  // base contributions (positive-only, saturating)
  'base.l3', 'base.l5', 'base.l7d', 'base.season',
  'base.pitcher', 'base.park', 'base.hand',
  // adjustments (signed)
  'adj.elite_power_floor', 'adj.low_power_cap', 'adj.cold_penalty',
  'adj.pitcher_dominance', 'adj.wild_pitcher',
  'adj.completeness_multiplier_delta', 'adj.ceiling_compression',
  'adj.weather', 'adj.lineup_pending',
  // score checkpoints (help catch which stage separates groups)
  'scores.raw_pre_adjustments', 'scores.after_completeness',
  'scores.after_ceiling', 'scores.final',
  // meta (useful diagnostics)
  'meta.stability_factor', 'meta.completeness_multiplier',
  'meta.factors_firing', 'meta.pitcher_starts_known',
] as const;
type ContribKey = typeof CONTRIB_KEYS[number];

// Boolean signals we count for pair-analysis (from signals_json).
const SIGNAL_KEYS = [
  'hr_pitcher', 'power_park', 'wind_out', 'wind_in', 'warm_weather',
  'hot_l7d', 'hr_streak', 'platoon_edge', 'elite_power', 'mid_power',
  'low_season_power', 'cold_batter', 'pitcher_dominant',
] as const;

// ---------- Types ----------

interface UniverseRow {
  target_date: string;
  player_id: number;
  player_name: string;
  team: string;
  global_rank: number;
  team_rank: number;
  heat_score: number;
  lineup_status: string;
  subscores_json: Record<string, unknown> | null;
  signals_json: Record<string, boolean> | null;
}

interface HrHit {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string | null;
  game_pk: number | null;
}

interface EnrichedRow {
  date: string;
  player_id: number;
  player_name: string;
  team: string;
  global_rank: number;
  bucket: string;
  heat_score: number;
  homered: boolean;
  contributions: Record<string, number | boolean>;
  signals: Record<string, boolean>;
}

// ---------- CLI ----------

interface Args {
  from: string;
  to: string;
  modelVersion: number;
  csvPath: string | null;
}

function parseArgs(argv: string[]): Args {
  let from = ''; let to = mlbToday();
  let modelVersion = 1;
  let last: number | null = null;
  let csvPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--model') modelVersion = Number(argv[++i]);
    else if (a === '--csv') csvPath = argv[++i];
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!from) {
    from = mlbAddDays(to, -(last ?? 30) + 1);
  }
  if (from > to) throw new Error(`--from (${from}) > --to (${to})`);
  return { from, to, modelVersion, csvPath };
}

// ---------- Helpers ----------

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  // Map our "adj." / "meta." / "base." / "scores." aliases to the
  // real subscores_json keys.
  const [head, ...rest] = parts;
  const rootKey =
    head === 'adj'  ? 'adjustments' :
    head === 'meta' ? 'meta' :
    head === 'base' ? 'base' :
    head === 'scores' ? 'scores' : head;
  let cur: any = obj;
  cur = cur?.[rootKey];
  for (const k of rest) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bucketFor(rank: number): string {
  for (const b of BUCKETS) if (rank >= b.lo && rank <= b.hi) return b.key;
  return '151+';
}

function fmtNum(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return '   -  ';
  return x.toFixed(dp).padStart(7);
}

// ---------- Data loading ----------

async function loadUniverseFor(date: string, modelVersion: number): Promise<UniverseRow[]> {
  const all: UniverseRow[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabaseAdmin
      .from('hr_target_universe')
      .select('target_date, player_id, player_name, team, global_rank, team_rank, heat_score, lineup_status, subscores_json, signals_json')
      .eq('target_date', date)
      .eq('model_version', modelVersion)
      .order('global_rank', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`universe ${date}: ${error.message}`);
    }
    const rows = (data ?? []) as UniverseRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

async function loadHrsFor(date: string): Promise<HrHit[]> {
  const all: HrHit[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('player_id, player_name, team, opponent, game_pk')
      .eq('game_date', date)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`home_runs ${date}: ${error.message}`);
    const rows = (data ?? []) as HrHit[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

// ---------- Aggregation ----------

interface BucketStats {
  bucket: string;
  n_total: number;
  n_hr: number;
  hr_rate: number;
  avg_heat: number;
  avg_rank: number;
}

function bucketize(rows: EnrichedRow[]): BucketStats[] {
  const out: BucketStats[] = [];
  for (const b of BUCKETS) {
    const inB = rows.filter((r) => r.bucket === b.key);
    const hrs = inB.filter((r) => r.homered);
    out.push({
      bucket: b.key,
      n_total: inB.length,
      n_hr: hrs.length,
      hr_rate: inB.length > 0 ? hrs.length / inB.length : 0,
      avg_heat: mean(inB.map((r) => r.heat_score)),
      avg_rank: mean(inB.map((r) => r.global_rank)),
    });
  }
  return out;
}

interface ComparisonResult {
  label: string;
  n_a: number;
  n_b: number;
  a_label: string;
  b_label: string;
  insufficient: boolean;
  contributions: Array<{
    key: string;
    mean_a: number;
    mean_b: number;
    diff: number;
    median_a: number;
    median_b: number;
  }>;
  signal_pairs: Array<{
    pair: string;
    rate_a: number;
    rate_b: number;
    diff: number;
    n_pair_a: number;
    n_pair_b: number;
  }>;
}

function compareGroups(
  label: string,
  a_label: string, a: EnrichedRow[],
  b_label: string, b: EnrichedRow[],
): ComparisonResult {
  const insufficient = a.length < MIN_SAMPLE || b.length < MIN_SAMPLE;
  const contributions = CONTRIB_KEYS.map((key) => {
    const avA = a.map((r) => Number(r.contributions[key] ?? 0));
    const avB = b.map((r) => Number(r.contributions[key] ?? 0));
    const mA = mean(avA);
    const mB = mean(avB);
    return {
      key,
      mean_a: mA,
      mean_b: mB,
      diff: mA - mB,
      median_a: median(avA),
      median_b: median(avB),
    };
  }).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  // Signal-pair analysis. All C(13, 2) = 78 pairs.
  const pairs: Array<{ pair: string; rate_a: number; rate_b: number; diff: number; n_pair_a: number; n_pair_b: number }> = [];
  for (let i = 0; i < SIGNAL_KEYS.length; i++) {
    for (let j = i + 1; j < SIGNAL_KEYS.length; j++) {
      const k1 = SIGNAL_KEYS[i];
      const k2 = SIGNAL_KEYS[j];
      const countA = a.filter((r) => r.signals[k1] && r.signals[k2]).length;
      const countB = b.filter((r) => r.signals[k1] && r.signals[k2]).length;
      const rA = a.length > 0 ? countA / a.length : 0;
      const rB = b.length > 0 ? countB / b.length : 0;
      pairs.push({
        pair: `${k1} + ${k2}`,
        rate_a: rA, rate_b: rB, diff: rA - rB,
        n_pair_a: countA, n_pair_b: countB,
      });
    }
  }
  pairs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  return {
    label, a_label, b_label,
    n_a: a.length, n_b: b.length,
    insufficient,
    contributions,
    signal_pairs: pairs.slice(0, 15),
  };
}

// ---------- Reporting ----------

function printBuckets(bs: BucketStats[], unavailableHr: number) {
  console.log(`\n── Rank buckets ──`);
  console.log(`  ${'bucket'.padEnd(11)}  ${'total'.padStart(6)}  ${'HR'.padStart(4)}  ${'HR-rate'.padStart(8)}  ${'avg-heat'.padStart(9)}  ${'avg-rank'.padStart(9)}`);
  for (const b of bs) {
    console.log(`  ${b.bucket.padEnd(11)}  ${String(b.n_total).padStart(6)}  ${String(b.n_hr).padStart(4)}  ${(b.hr_rate * 100).toFixed(1).padStart(7)}%  ${fmtNum(b.avg_heat, 1).padStart(9)}  ${fmtNum(b.avg_rank, 1).padStart(9)}`);
  }
  console.log(`  ${'UNAVAILABLE'.padEnd(11)}  ${'---'.padStart(6)}  ${String(unavailableHr).padStart(4)}  ${'---'.padStart(8)}  ${'---'.padStart(9)}  ${'---'.padStart(9)}   (HR hitters not in universe at all)`);
}

function printComparison(c: ComparisonResult) {
  console.log(`\n── ${c.label} ──`);
  console.log(`  A: ${c.a_label}  (n=${c.n_a})`);
  console.log(`  B: ${c.b_label}  (n=${c.n_b})`);
  if (c.insufficient) {
    console.log(`  ⚠ INSUFFICIENT SAMPLE — need ≥${MIN_SAMPLE} in each group. Report shown but do not conclude.`);
  }
  console.log(`\n  Top contribution differences (sorted by |A − B|):`);
  console.log(`    ${'component'.padEnd(38)}  ${'mean_A'.padStart(7)}  ${'mean_B'.padStart(7)}  ${'diff'.padStart(7)}  ${'med_A'.padStart(6)}  ${'med_B'.padStart(6)}  note`);
  const shown = c.contributions.filter((x) => Math.abs(x.diff) > 0.01).slice(0, 12);
  for (const x of shown) {
    let note = '';
    // Adjustment penalties are negative; a MORE negative mean in one
    // group means that group got hit HARDER by that penalty.
    if (x.key.startsWith('adj.') && Math.abs(x.diff) >= 0.5) {
      if (x.mean_a < x.mean_b) note = `A got MORE ${x.key.replace('adj.', '')} pain`;
      else                     note = `B got MORE ${x.key.replace('adj.', '')} pain`;
    }
    console.log(`    ${x.key.padEnd(38)}  ${fmtNum(x.mean_a, 2)}  ${fmtNum(x.mean_b, 2)}  ${fmtNum(x.diff, 2)}  ${fmtNum(x.median_a, 1).padStart(6)}  ${fmtNum(x.median_b, 1).padStart(6)}  ${note}`);
  }

  console.log(`\n  Top signal-pair frequency differences:`);
  console.log(`    ${'pair'.padEnd(38)}  ${'rate_A'.padStart(7)}  ${'rate_B'.padStart(7)}  ${'diff'.padStart(7)}  ${'n_A'.padStart(4)}  ${'n_B'.padStart(4)}`);
  const pairShown = c.signal_pairs.filter((p) => Math.abs(p.diff) > 0.02).slice(0, 10);
  if (pairShown.length === 0) {
    console.log(`    (no pair differences ≥ 2 percentage points)`);
  } else {
    for (const p of pairShown) {
      console.log(`    ${p.pair.padEnd(38)}  ${(p.rate_a * 100).toFixed(1).padStart(6)}%  ${(p.rate_b * 100).toFixed(1).padStart(6)}%  ${((p.diff) * 100).toFixed(1).padStart(6)}pp  ${String(p.n_pair_a).padStart(4)}  ${String(p.n_pair_b).padStart(4)}`);
    }
  }
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n═══ Rank-conditioned miss analysis ═══`);
  console.log(`  dates: ${args.from} .. ${args.to}`);
  console.log(`  model_version: v${args.modelVersion}`);

  // Iterate the date range.
  let d = args.from;
  const enrichedAll: EnrichedRow[] = [];
  let unavailableHrCount = 0;
  let datesWithUniverse = 0;
  let datesEmpty = 0;
  while (d <= args.to) {
    const [universe, hrs] = await Promise.all([
      loadUniverseFor(d, args.modelVersion),
      loadHrsFor(d),
    ]);
    if (universe.length === 0) {
      datesEmpty++;
      d = mlbAddDays(d, 1);
      continue;
    }
    datesWithUniverse++;
    const hrIds = new Set(hrs.map((h) => h.player_id));
    const inUniverseIds = new Set(universe.map((r) => r.player_id));
    for (const pid of hrIds) if (!inUniverseIds.has(pid)) unavailableHrCount++;

    for (const u of universe) {
      const homered = hrIds.has(u.player_id);
      const contributions: Record<string, number | boolean> = {};
      for (const key of CONTRIB_KEYS) {
        const v = getPath(u.subscores_json, key);
        contributions[key] = typeof v === 'number' ? v : (typeof v === 'boolean' ? v : 0);
      }
      const signals: Record<string, boolean> = {};
      for (const k of SIGNAL_KEYS) signals[k] = !!(u.signals_json ?? {})[k];
      enrichedAll.push({
        date: d,
        player_id: u.player_id,
        player_name: u.player_name,
        team: u.team,
        global_rank: u.global_rank,
        bucket: bucketFor(u.global_rank),
        heat_score: Number(u.heat_score),
        homered,
        contributions,
        signals,
      });
    }
    d = mlbAddDays(d, 1);
  }

  const totalHrHitters = new Set(enrichedAll.filter((r) => r.homered).map((r) => `${r.date}|${r.player_id}`)).size;
  console.log(`  universe rows: ${enrichedAll.length}`);
  console.log(`  dates with universe data: ${datesWithUniverse}  (skipped ${datesEmpty} empty date(s))`);
  console.log(`  HR hitters observed: ${totalHrHitters}  (+ ${unavailableHrCount} unavailable = not modeled)`);

  if (enrichedAll.length === 0) {
    console.log(`\n  No data. Run snapshot:today for one or more dates in the range first.`);
    process.exit(0);
  }

  // Optional CSV dump.
  if (args.csvPath) {
    const headers = ['date', 'player_id', 'player_name', 'team', 'global_rank', 'bucket', 'heat_score', 'homered',
      ...CONTRIB_KEYS,
      ...SIGNAL_KEYS.map((s) => `sig.${s}`),
    ];
    const lines = [headers.join(',')];
    for (const r of enrichedAll) {
      lines.push([
        r.date, r.player_id,
        `"${(r.player_name ?? '').replace(/"/g, '""')}"`,
        r.team, r.global_rank, r.bucket,
        r.heat_score, r.homered ? 1 : 0,
        ...CONTRIB_KEYS.map((k) => r.contributions[k] ?? ''),
        ...SIGNAL_KEYS.map((s) => r.signals[s] ? 1 : 0),
      ].join(','));
    }
    writeFileSync(args.csvPath, lines.join('\n'), 'utf8');
    console.log(`  csv written: ${args.csvPath} (${lines.length - 1} rows)`);
  }

  // Buckets.
  printBuckets(bucketize(enrichedAll), unavailableHrCount);

  // Groups for comparisons.
  const top10All  = enrichedAll.filter((r) => r.bucket === '1-10');
  const top10HR   = top10All.filter((r) => r.homered);
  const top10Miss = top10All.filter((r) => !r.homered);
  const hr1_10    = enrichedAll.filter((r) => r.homered && r.bucket === '1-10');
  const hr11_25   = enrichedAll.filter((r) => r.homered && r.bucket === '11-25');
  const hr26_50   = enrichedAll.filter((r) => r.homered && r.bucket === '26-50');
  const hr51plus  = enrichedAll.filter((r) => r.homered && (r.bucket === '51-100' || r.bucket === '101-150' || r.bucket === '151+'));

  const A = compareGroups('Comparison A: Top-10 HR vs Top-10 no-HR',
    'Top-10 rows that homered',    top10HR,
    'Top-10 rows that did NOT homer', top10Miss);

  const B = compareGroups('Comparison B: HR hitters ranked 1-10 vs 11-25',
    'HR hitters ranked 1-10',  hr1_10,
    'HR hitters ranked 11-25', hr11_25);

  const C = compareGroups('Comparison C: HR hitters ranked 1-10 vs 26-50',
    'HR hitters ranked 1-10',  hr1_10,
    'HR hitters ranked 26-50', hr26_50);

  const D = compareGroups('Comparison D: HR hitters ranked 1-10 vs 51+ (all lower buckets)',
    'HR hitters ranked 1-10', hr1_10,
    'HR hitters ranked 51+',  hr51plus);

  printComparison(A);
  printComparison(B);
  printComparison(C);
  printComparison(D);

  console.log(`\n═══ end of report ═══\n`);
  console.log(`Reading guide:`);
  console.log(`  • adj.* means are usually ≤ 0 (penalties). A MORE-negative mean in one group = that group got hit HARDER by that penalty.`);
  console.log(`  • base.* means are ≥ 0 (positive contributions). HIGHER mean = stronger signal in that group.`);
  console.log(`  • diff column is (A − B). Positive = A stronger, negative = B stronger.`);
  console.log(`  • Groups smaller than n=${MIN_SAMPLE} are flagged INSUFFICIENT SAMPLE.`);
  console.log(`  • Pair frequencies are shown as percentage points (pp) difference.`);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    console.error(`\n[analyzeMissesByRank] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
