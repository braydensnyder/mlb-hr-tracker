/**
 * CLI: fill probable pitcher info on games where the schedule API didn't
 * return one, using the live feed as a fallback.
 *
 * Usage:
 *   npm run enrich:probable-pitchers
 *   npm run enrich:probable-pitchers -- --start 2026-05-01 --end 2026-05-10
 *   npm run enrich:probable-pitchers -- --dry-run
 *   npm run enrich:probable-pitchers -- --limit 50
 */
import { enrichProbablePitchers } from './enrichProbablePitchers.js';

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
  const result = await enrichProbablePitchers(opts);
  if (result.failures.length > 0) {
    console.error(`[runEnrichProbablePitchers] completed with ${result.failures.length} failed game(s).`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runEnrichProbablePitchers] FAILED:', err);
  process.exit(1);
});
