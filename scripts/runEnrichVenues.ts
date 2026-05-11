/**
 * CLI: backfill venue_id + venue_name on home_runs and games rows missing
 * them, refresh the canonical venues catalog, and rebuild the
 * venue_hr_summary derived cache.
 *
 * Usage:
 *   npm run enrich:venues
 *   npm run enrich:venues -- --delay 500
 *   npm run enrich:venues -- --limit 50              # process only 50 games this run
 *   npm run enrich:venues -- --dry-run               # report only, no writes
 *   npm run enrich:venues -- --skip-summary          # skip the venue_hr_summary rebuild
 *   npm run enrich:venues -- --as-of 2026-05-09      # anchor for the summary
 */
import { enrichVenues } from './enrichVenues.js';

interface Parsed {
  delayMs?: number;
  limit?: number;
  dryRun: boolean;
  skipSummary: boolean;
  asOf?: string;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { dryRun: false, skipSummary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delay') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--delay needs a non-negative number`);
      out.delayMs = v;
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--limit needs a positive integer`);
      out.limit = Math.floor(v);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--skip-summary') {
      out.skipSummary = true;
    } else if (a === '--as-of') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--as-of needs YYYY-MM-DD`);
      out.asOf = v;
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
  const result = await enrichVenues(opts);
  if (result.failures.length > 0) {
    console.error(`[runEnrichVenues] completed with ${result.failures.length} failed game(s).`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runEnrichVenues] FAILED:', err);
  process.exit(1);
});
