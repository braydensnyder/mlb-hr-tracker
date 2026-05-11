/**
 * CLI: refresh probable pitchers + venue on `games` rows for a date range.
 *
 * Usage:
 *   npm run enrich:schedule
 *   npm run enrich:schedule -- --start 2026-05-10 --end 2026-05-17
 *   npm run enrich:schedule -- --dry-run
 */
import { enrichSchedule } from './enrichSchedule.js';

interface Parsed {
  start?: string;
  end?: string;
  delayMs?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--start needs YYYY-MM-DD`);
      out.start = v;
    } else if (a === '--end') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--end needs YYYY-MM-DD`);
      out.end = v;
    } else if (a === '--delay') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--delay needs a non-negative number`);
      out.delayMs = v;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected positional arg: ${a}`);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await enrichSchedule(opts);
  if (result.failures.length > 0) {
    console.error(`[runEnrichSchedule] completed with ${result.failures.length} failed day(s).`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runEnrichSchedule] FAILED:', err);
  process.exit(1);
});
