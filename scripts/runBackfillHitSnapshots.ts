/**
 * runBackfillHitSnapshots — reconstruct hit_target_snapshots for a
 * historical date range using strictly-prior inputs.
 *
 * Every reconstructed row is stamped snapshot_type='simulated' because
 * all games on a historical date have already started when this runs —
 * they can never be legitimate pregame audit records.
 *
 * Per date D in the range (processed chronologically):
 *   1. rebuildHitSummaries(D-1)      — writes as-of-D-1 rolling summary
 *   2. rebuildPitcherForm(D-1)       — pitcher rates from starts strictly < D
 *   3. snapshotHitTargets(D, {force:true, skipIfGamesStarted:false})
 *      → games-started fence bypassed (this IS backfill)
 *      → snapshot_type auto-tags 'simulated' because started > 0
 *   4. enrichHitOutcomes(D)          — fills hits/AB/hit_1plus/etc.
 *
 * pitcher_form is a SINGLE-row-per-pitcher table that gets overwritten
 * per rebuild. Between snapshotHitTargets(D) and rebuildPitcherForm(D)
 * on the next iteration we transiently carry as-of-(D-1) rates.
 * Because the snapshot writes contributions_json (including base_features
 * containing the pitcher rates used) BEFORE the next iteration starts,
 * the frozen snapshot row is unaffected by later rebuilds — the pitcher
 * form applied AT SCORING TIME is the value persisted on the row.
 *
 * Usage:
 *   npm run backfill:hit-snapshots -- --from 2026-08-10 --to 2026-08-16
 *   npm run backfill:hit-snapshots -- --last 7
 *   npm run backfill:hit-snapshots -- --skip-summary-rebuild    # if summaries already exist
 *   npm run backfill:hit-snapshots -- --skip-enrichment          # snapshot only
 *   npm run backfill:hit-snapshots -- --verify-only              # just print stats
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';
import { snapshotHitTargets } from './snapshotHitTargets.js';
import { enrichHitOutcomes } from './enrichHitOutcomes.js';
import { rebuildHitSummaries } from './rebuildHitSummaries.js';
import { rebuildPitcherForm } from './rebuildPitcherForm.js';

const HIT_MODEL_VERSION = 1;

interface Args {
  from: string | null;
  to: string;
  skipSummaryRebuild: boolean;
  skipEnrichment: boolean;
  verifyOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let to = mlbAddDays(mlbToday(), -1);   // default yesterday-back
  let last: number | null = null;
  let skipSummaryRebuild = false;
  let skipEnrichment = false;
  let verifyOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--skip-summary-rebuild') skipSummaryRebuild = true;
    else if (a === '--skip-enrichment') skipEnrichment = true;
    else if (a === '--verify-only') verifyOnly = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (last != null && !from) from = mlbAddDays(to, -(last - 1));
  if (!from) from = to;
  if (from > to) throw new Error(`--from (${from}) > --to (${to})`);
  return { from, to, skipSummaryRebuild, skipEnrichment, verifyOnly };
}

function iterateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  while (d <= to) { out.push(d); d = mlbAddDays(d, 1); }
  return out;
}

async function verify(from: string, to: string): Promise<void> {
  console.log(`\n═══ Verification ═══`);

  // A. rows by date
  const { data: byDateRaw, error: byDateErr } = await supabaseAdmin
    .from('hit_target_snapshots')
    .select('target_date, snapshot_type, hits')
    .eq('model_version', HIT_MODEL_VERSION)
    .gte('target_date', from)
    .lte('target_date', to);
  if (byDateErr) throw new Error(`verify: ${byDateErr.message}`);
  const rows = (byDateRaw ?? []) as { target_date: string; snapshot_type: string; hits: number | null }[];
  const byDate = new Map<string, { total: number; enriched: number; simulated: number; pregame: number }>();
  for (const r of rows) {
    const c = byDate.get(r.target_date) ?? { total: 0, enriched: 0, simulated: 0, pregame: 0 };
    c.total += 1;
    if (r.hits != null) c.enriched += 1;
    if (r.snapshot_type === 'simulated') c.simulated += 1;
    if (r.snapshot_type === 'pregame') c.pregame += 1;
    byDate.set(r.target_date, c);
  }

  console.log(`\n  1. Snapshot rows by date (model_version=${HIT_MODEL_VERSION}):`);
  console.log(`     ${'date'.padEnd(11)}  ${'total'.padStart(6)}  ${'enriched'.padStart(9)}  ${'simulated'.padStart(10)}  ${'pregame'.padStart(8)}`);
  const dates = [...byDate.keys()].sort();
  let grandTotal = 0, grandEnriched = 0;
  for (const d of dates) {
    const c = byDate.get(d)!;
    console.log(`     ${d.padEnd(11)}  ${String(c.total).padStart(6)}  ${String(c.enriched).padStart(9)}  ${String(c.simulated).padStart(10)}  ${String(c.pregame).padStart(8)}`);
    grandTotal += c.total;
    grandEnriched += c.enriched;
  }
  console.log(`     ${'TOTAL'.padEnd(11)}  ${String(grandTotal).padStart(6)}  ${String(grandEnriched).padStart(9)}  ${'—'.padStart(10)}  ${'—'.padStart(8)}`);

  // B. rows with hits IS NOT NULL (across all history for context)
  const { count: allEnriched, error: allEnrichedErr } = await supabaseAdmin
    .from('hit_target_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('model_version', HIT_MODEL_VERSION)
    .not('hits', 'is', null);
  if (allEnrichedErr) throw new Error(`allEnriched: ${allEnrichedErr.message}`);

  // C. total rows for model_version=1 (across all history)
  const { count: allRows, error: allRowsErr } = await supabaseAdmin
    .from('hit_target_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('model_version', HIT_MODEL_VERSION);
  if (allRowsErr) throw new Error(`allRows: ${allRowsErr.message}`);

  console.log(`\n  2. Rows with hits IS NOT NULL (all history, model_version=${HIT_MODEL_VERSION}): ${allEnriched ?? 0}`);
  console.log(`  3. Total rows for model_version=${HIT_MODEL_VERSION} (all history): ${allRows ?? 0}`);

  // D. distinct config hashes in the reconstructed range
  const hashes1 = new Set<string>();
  const hashes2 = new Set<string>();
  const { data: hashRows, error: hashErr } = await supabaseAdmin
    .from('hit_target_snapshots')
    .select('model_config_hash_1plus, model_config_hash_2plus')
    .eq('model_version', HIT_MODEL_VERSION)
    .gte('target_date', from)
    .lte('target_date', to);
  if (hashErr) throw new Error(`hashes: ${hashErr.message}`);
  for (const r of (hashRows ?? []) as { model_config_hash_1plus: string; model_config_hash_2plus: string }[]) {
    hashes1.add(r.model_config_hash_1plus);
    hashes2.add(r.model_config_hash_2plus);
  }
  console.log(`\n  4. Distinct config hashes in [${from} .. ${to}]:`);
  console.log(`     1+ ranker: ${hashes1.size} hash(es)  [${[...hashes1].join(', ')}]`);
  console.log(`     2+ ranker: ${hashes2.size} hash(es)  [${[...hashes2].join(', ')}]`);
  if (hashes1.size > 1 || hashes2.size > 1) {
    console.log(`     ⚠ Multiple hashes in the range means rows were scored under DIFFERENT configs.`);
    console.log(`       Per-row scoring is honest (each row carries its own hash) but sample-mean`);
    console.log(`       predicted probability mixes calibrations.`);
  }

  console.log(``);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n═══ Hit-snapshot backfill ═══`);
  console.log(`  range: ${args.from} .. ${args.to}`);
  console.log(`  skip summary rebuild: ${args.skipSummaryRebuild}`);
  console.log(`  skip enrichment:      ${args.skipEnrichment}`);
  console.log(`  verify-only:          ${args.verifyOnly}`);
  console.log(``);

  if (args.verifyOnly) {
    await verify(args.from!, args.to);
    return;
  }

  const dates = iterateDates(args.from!, args.to);
  console.log(`  ${dates.length} date(s) to process\n`);

  for (const D of dates) {
    const asOf = mlbAddDays(D, -1);
    console.log(`\n──────────────── ${D} ────────────────`);
    console.log(`  as-of inputs anchored to ${asOf}`);

    // 1. summary rebuild
    if (!args.skipSummaryRebuild) {
      try {
        await rebuildHitSummaries(asOf);
      } catch (e) {
        console.warn(`  ⚠ rebuildHitSummaries(${asOf}) failed (continuing): ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`  (skipped summary rebuild — --skip-summary-rebuild)`);
    }

    // 2. pitcher form as-of D-1
    if (!args.skipSummaryRebuild) {
      try {
        await rebuildPitcherForm(asOf);
      } catch (e) {
        console.warn(`  ⚠ rebuildPitcherForm(${asOf}) failed (continuing): ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`  (skipped pitcher-form rebuild — --skip-summary-rebuild)`);
    }

    // 3. reconstruct snapshot for D
    try {
      const res = await snapshotHitTargets(D, { force: true, skipIfGamesStarted: false });
      console.log(`  → snapshot [${res.status}] · candidates=${res.candidates_total} · universe=${res.universe_rows_written} · snapshot=${res.snapshot_rows_written} · games=${res.games_started}/${res.games_total} started`);
    } catch (e) {
      console.warn(`  ⚠ snapshotHitTargets(${D}) failed (continuing): ${e instanceof Error ? e.message : e}`);
      continue;
    }

    // 4. enrich outcomes
    if (!args.skipEnrichment) {
      try {
        const er = await enrichHitOutcomes(D);
        console.log(`  → enrichment · enriched=${er.snapshot_rows_enriched} · zeroed=${er.snapshot_rows_no_batting_line} · already=${er.snapshot_rows_already_enriched}`);
      } catch (e) {
        console.warn(`  ⚠ enrichHitOutcomes(${D}) failed (continuing): ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`  (skipped enrichment — --skip-enrichment)`);
    }
  }

  await verify(args.from!, args.to);

  console.log(`Done. Rerun the calibration audit:`);
  console.log(`  npm run diagnose:hit-calibration -- --from ${args.from} --to ${args.to}\n`);
}

main().catch((err) => {
  console.error(`\n[runBackfillHitSnapshots] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
