/**
 * captureRange — backfill learning_predictions for every date in a range.
 *
 * Wraps captureDay() in a loop so you can populate the feedback loop for
 * a backlog of completed slates in one go. Continues past errors by
 * default (one date with no snapshot shouldn't kill the whole run).
 * Optionally skips dates that already have rows for the active model
 * version so re-runs cheap.
 *
 * Usage:
 *   npm run learning:capture-range -- --from 2026-06-01 --to 2026-06-26
 *   npm run learning:capture-range -- --from 2026-06-01            # to = yesterday
 *   npm run learning:capture-range -- --from 2026-06-01 --skip-existing
 *   npm run learning:capture-range -- --from 2026-06-01 --window 14
 *   npm run learning:capture-range -- --from 2026-06-01 --stop-on-error
 *
 * The script logs each date's progress and prints a final aggregate at
 * the end (totals, classifications, failed dates). Exit code is 0 if
 * every date succeeded, 1 if any failed (even with continue-on-error,
 * so CI catches partial runs).
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';
import { captureDay } from './captureDay.js';

interface Args {
  from: string;
  to: string;
  windows: number[];
  continueOnError: boolean;
  skipExisting: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    from: '',
    to: mlbAddDays(mlbToday(), -1),
    windows: [7, 14, 30],
    continueOnError: true,
    skipExisting: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--from needs YYYY-MM-DD (got ${v})`);
      out.from = v;
    } else if (a === '--to') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--to needs YYYY-MM-DD (got ${v})`);
      out.to = v;
    } else if (a === '--window') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--window needs a positive integer');
      out.windows = [v];
    } else if (a === '--skip-existing') {
      out.skipExisting = true;
    } else if (a === '--stop-on-error') {
      out.continueOnError = false;
    } else if (a === '--continue-on-error') {
      out.continueOnError = true;
    } else {
      throw new Error(`Unexpected arg: ${a}. See header comment for usage.`);
    }
  }
  if (!out.from) throw new Error('--from is required');
  if (out.from > out.to) throw new Error(`--from (${out.from}) is after --to (${out.to})`);
  return out;
}

/** Build the inclusive date list [from..to] in ascending order. */
function buildDates(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = mlbAddDays(d, 1);
  }
  return out;
}

/** Pre-check whether a date already has learning_predictions for the
 *  active model version. Returns the row count (0 = unprocessed). */
async function existingRowCount(date: string): Promise<number> {
  // Find active model version first.
  const { data: mvData, error: mvErr } = await supabaseAdmin
    .from('model_versions')
    .select('version')
    .eq('active', true)
    .order('version', { ascending: false })
    .limit(1);
  if (mvErr) throw new Error(`model_versions: ${mvErr.message}`);
  const version = (mvData ?? [])[0]?.version;
  if (version == null) throw new Error('No active model_version. Apply migration 013.');

  const { count, error } = await supabaseAdmin
    .from('learning_predictions')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('model_version', version);
  if (error) throw new Error(`existing count: ${error.message}`);
  return count ?? 0;
}

function log(msg: string) {
  console.log(`[captureRange] ${msg}`);
}
function logErr(msg: string) {
  console.error(`[captureRange] ✗ ${msg}`);
}

interface DayOutcome {
  date: string;
  status: 'success' | 'skipped' | 'failed';
  predictions_written?: number;
  tp?: number; fp?: number; fn?: number; tn?: number;
  unranked_hr_hitters?: number;
  importance_rows_written?: number;
  error?: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dates = buildDates(args.from, args.to);

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`RANGE — ${args.from} to ${args.to} (${dates.length} day${dates.length === 1 ? '' : 's'})`);
  log(`  windows=${args.windows.join(',')}  skipExisting=${args.skipExisting}  continueOnError=${args.continueOnError}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const outcomes: DayOutcome[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const pos = `${i + 1}/${dates.length}`;
    log('');
    log(`▶ ${pos}  ${date} —————————————————————————————————`);

    // Skip-existing pre-check
    if (args.skipExisting) {
      try {
        const existing = await existingRowCount(date);
        if (existing > 0) {
          log(`  ⟶ skip: ${existing} learning_predictions rows already present (use --no-skip-existing to re-run)`);
          outcomes.push({ date, status: 'skipped', predictions_written: existing });
          continue;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logErr(`pre-check failed for ${date}: ${msg}`);
        outcomes.push({ date, status: 'failed', error: msg });
        if (!args.continueOnError) {
          logErr(`stopping (--stop-on-error)`);
          process.exit(1);
        }
        continue;
      }
    }

    try {
      const result = await captureDay(date, args.windows);
      outcomes.push({
        date,
        status: 'success',
        predictions_written: result.predictions_written,
        tp: result.tp, fp: result.fp, fn: result.fn, tn: result.tn,
        unranked_hr_hitters: result.unranked_hr_hitters,
        importance_rows_written: result.importance_rows_written,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr(`${date} FAILED: ${msg}`);
      outcomes.push({ date, status: 'failed', error: msg });
      if (!args.continueOnError) {
        logErr(`stopping (--stop-on-error)`);
        process.exit(1);
      }
    }
  }

  // ---- final summary ----
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const succeeded = outcomes.filter((o) => o.status === 'success');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const failed = outcomes.filter((o) => o.status === 'failed');

  const sum = (k: keyof DayOutcome) =>
    succeeded.reduce((s, o) => s + (typeof o[k] === 'number' ? (o[k] as number) : 0), 0);

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`${failed.length === 0 ? '✅ COMPLETE' : '⚠ COMPLETE WITH ERRORS'} — ${args.from} to ${args.to}`);
  log(`  elapsed              = ${elapsedSec}s`);
  log(`  days attempted       = ${dates.length}`);
  log(`  succeeded            = ${succeeded.length}`);
  log(`  skipped (already in) = ${skipped.length}`);
  log(`  failed               = ${failed.length}`);
  log(`  predictions written  = ${sum('predictions_written').toLocaleString()}`);
  log(`  classifications      = TP=${sum('tp')} FP=${sum('fp')} FN=${sum('fn')} TN=${sum('tn')}`);
  log(`  unranked HR hitters  = ${sum('unranked_hr_hitters')}  (pool-coverage gaps)`);
  log(`  importance rows      = ${sum('importance_rows_written')}`);

  if (failed.length > 0) {
    log('');
    log(`  failures (${failed.length}):`);
    for (const f of failed) {
      log(`    ${f.date}  →  ${f.error}`);
    }
  }
  if (skipped.length > 0) {
    log('');
    log(`  skipped (${skipped.length}) — existing row counts shown:`);
    for (const s of skipped) {
      log(`    ${s.date}  →  ${s.predictions_written} rows already in DB`);
    }
  }
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Per-day machine-readable JSON for piping/automation
  console.log('[captureRange] result JSON:');
  console.log(JSON.stringify({
    from: args.from, to: args.to,
    days_attempted: dates.length,
    succeeded: succeeded.length,
    skipped: skipped.length,
    failed: failed.length,
    elapsed_seconds: Number(elapsedSec),
    totals: {
      predictions_written: sum('predictions_written'),
      tp: sum('tp'), fp: sum('fp'), fn: sum('fn'), tn: sum('tn'),
      unranked_hr_hitters: sum('unranked_hr_hitters'),
      importance_rows: sum('importance_rows_written'),
    },
    outcomes,
  }, null, 2));

  // Non-zero exit when anything failed, so CI / cron pipelines catch it.
  process.exit(failed.length === 0 ? 0 : 1);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    logErr(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
