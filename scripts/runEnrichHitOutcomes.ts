/**
 * CLI: enrich hit_target_snapshots outcome fields.
 *
 * Two modes:
 *   1. Single date (default — mirrors nightly Phase 6c usage).
 *   2. Range (--from / --to) — re-enrich a backfilled window without
 *      re-running the whole snapshot pass. Handy when the outcome
 *      columns got wiped by a force-rewrite snapshot but the batting
 *      lines are already extracted.
 *
 * Enrichment writes ONLY the outcome columns (hits, at_bats, hit_1plus,
 * hit_2plus, doubles, triples, outcome_enriched_at). Rank, score,
 * contributions, config hashes are never touched — same freeze contract
 * as pregame v7.
 *
 * Usage:
 *   npm run enrich:hit-outcomes                              # yesterday
 *   npm run enrich:hit-outcomes -- 2026-08-15
 *   npm run enrich:hit-outcomes -- today
 *   npm run enrich:hit-outcomes -- yesterday --force         # re-write already-enriched rows
 *   npm run enrich:hit-outcomes -- --from 2026-08-10 --to 2026-08-17
 *   npm run enrich:hit-outcomes -- --from 2026-08-10 --to 2026-08-17 --force
 */
import 'dotenv/config';
import { enrichHitOutcomes } from './enrichHitOutcomes.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

interface Args {
  from: string | null;
  to: string | null;
  singleDate: string | null;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let to: string | null = null;
  let singleDate: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === 'today') singleDate = mlbToday();
    else if (a === 'yesterday') singleDate = mlbAddDays(mlbToday(), -1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) singleDate = a;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  // Range mode overrides single date; default single date = yesterday.
  if (from && !to) to = from;
  if (to && !from) from = to;
  if (!from && !to && !singleDate) singleDate = mlbAddDays(mlbToday(), -1);
  if (from && to && from > to) throw new Error(`--from (${from}) > --to (${to})`);
  return { from, to, singleDate, force };
}

function iterateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  while (d <= to) { out.push(d); d = mlbAddDays(d, 1); }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dates = args.from && args.to
    ? iterateDates(args.from, args.to)
    : [args.singleDate!];

  console.log(`[runEnrichHitOutcomes] ${dates.length} date(s): ${dates.join(', ')}${args.force ? ' (force)' : ''}`);

  // Track failures so a mid-loop error can't be lost in the console
  // scrollback. The final line reports pass/fail.
  const failed: Array<{ date: string; message: string }> = [];
  const summaries: Array<{ date: string; enriched: number; zeroed: number; already: number; total: number; per_version: string }> = [];

  for (const d of dates) {
    try {
      const res = await enrichHitOutcomes(d, { force: args.force });
      const pv = res.per_version
        .map((v) => `v${v.model_version}=${v.snapshot_rows_enriched}/${v.snapshot_rows_total}`)
        .join(' ');
      summaries.push({
        date: d,
        enriched: res.snapshot_rows_enriched,
        zeroed: res.snapshot_rows_no_batting_line,
        already: res.snapshot_rows_already_enriched,
        total: res.snapshot_rows_total,
        per_version: pv,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ date: d, message: msg });
      console.error(`[enrich] ${d} FAILED: ${msg}`);
    }
  }

  console.log(`\n=== Enrichment summary ===`);
  for (const s of summaries) {
    console.log(`  ${s.date}  enriched=${s.enriched}/${s.total}  zeroed=${s.zeroed}  already=${s.already}  · ${s.per_version}`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} date(s) FAILED:`);
    for (const f of failed) console.error(`  ${f.date}: ${f.message}`);
    process.exit(1);
  }
  console.log(`\nAll ${dates.length} date(s) enriched successfully.`);
}

main().catch((err) => {
  console.error('[runEnrichHitOutcomes] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
