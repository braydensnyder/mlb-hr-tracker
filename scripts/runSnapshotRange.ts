/**
 * CLI: generate HR target snapshots for every date in a range.
 *
 * Usage:
 *   npm run snapshot:range -- --start 2026-05-01 --end 2026-05-11
 *   npm run snapshot:range -- --start 2026-05-01 --end 2026-05-11 --force
 *   npm run snapshot:range -- --start 2026-05-01 --end 2026-05-11 --limit 25 --delay 200
 *
 * Each date is processed independently. Per-day failures are logged but
 * don't kill the range. Auto-tagging marks past dates as 'simulated' and
 * pre-game future/today dates as 'live'.
 */
import { snapshotRange } from './snapshotRange.js';

interface Parsed {
  start?: string;
  end?: string;
  force: boolean;
  limit?: number;
  delayMs?: number;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') {
      out.start = argv[++i];
    } else if (a === '--end') {
      out.end = argv[++i];
    } else if (a === '--force') {
      out.force = true;
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--limit needs a positive integer');
      out.limit = Math.floor(v);
    } else if (a === '--delay') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error('--delay needs a non-negative integer');
      out.delayMs = Math.floor(v);
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected positional arg: ${a}`);
    }
  }
  if (!out.start || !out.end) {
    throw new Error('Both --start and --end (YYYY-MM-DD) are required.\nUsage: npm run snapshot:range -- --start YYYY-MM-DD --end YYYY-MM-DD [--force] [--limit N] [--delay N]');
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await snapshotRange({
    start: opts.start!,
    end: opts.end!,
    force: opts.force,
    limit: opts.limit,
    delayMs: opts.delayMs,
  });
  if (result.failures.length > 0) {
    console.error(`[runSnapshotRange] completed with ${result.failures.length} failed date(s):`);
    for (const f of result.failures) console.error(`  ${f.date}: ${f.error}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runSnapshotRange] FAILED:', err);
  process.exit(1);
});
