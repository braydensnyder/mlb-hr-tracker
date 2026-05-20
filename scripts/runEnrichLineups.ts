/**
 * CLI: fill confirmed-lineup columns on `games` rows from the MLB live feed.
 *
 * Usage:
 *   npm run enrich:lineups
 *   npm run enrich:lineups -- --start 2026-05-18 --end 2026-05-19
 *   npm run enrich:lineups -- --dry-run
 *   npm run enrich:lineups -- --limit 30
 */
import { enrichLineups } from './enrichLineups.js';

interface Parsed {
  start?: string;
  end?: string;
  delayMs?: number;
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('--start needs YYYY-MM-DD');
      out.start = v;
    } else if (a === '--end') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('--end needs YYYY-MM-DD');
      out.end = v;
    } else if (a === '--delay') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error('--delay needs a non-negative number');
      out.delayMs = v;
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--limit needs a positive integer');
      out.limit = Math.floor(v);
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
  const result = await enrichLineups(opts);
  if (result.failures.length > 0) {
    console.error(`[runEnrichLineups] completed with ${result.failures.length} failed game(s).`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runEnrichLineups] FAILED:', err);
  process.exit(1);
});
