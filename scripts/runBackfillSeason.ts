/**
 * CLI entrypoint: backfill every date in a range.
 *
 * Usage:
 *   npm run backfill:season -- 2026-03-01 2026-05-09
 *   npm run backfill:season -- 2026-03-01 2026-05-09 --delay 500
 *   npm run backfill:season -- 2026-03-01 2026-05-09 --rebuild-per-day
 *
 * Idempotent: re-running over the same range only touches games that haven't
 * been processed yet, and dedups HRs by event_key. Safe to interrupt and
 * resume — just re-run with the same range.
 */
import { backfillSeason } from './backfillSeason.js';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let delayMs: number | undefined;
  let rebuildPerDay = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delay') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--delay needs a non-negative number, got ${argv[i]}`);
      delayMs = v;
    } else if (a === '--rebuild-per-day') {
      rebuildPerDay = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 2) {
    throw new Error(
      'Usage: npm run backfill:season -- <START YYYY-MM-DD> <END YYYY-MM-DD> [--delay 350] [--rebuild-per-day]',
    );
  }

  return { start: positional[0], end: positional[1], delayMs, rebuildPerDay };
}

async function main() {
  const { start, end, delayMs, rebuildPerDay } = parseArgs(process.argv.slice(2));
  const summary = await backfillSeason(start, end, { delayMs, rebuildPerDay });

  if (summary.daysFailed > 0) {
    console.error(`[runBackfillSeason] completed with ${summary.daysFailed} failed day(s):`);
    for (const f of summary.failures) console.error(`  ${f.date}: ${f.error}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runBackfillSeason] FAILED:', err);
  process.exit(1);
});
