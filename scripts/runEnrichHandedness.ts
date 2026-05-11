/**
 * CLI: backfill batter_side / pitcher_throws on home_runs rows missing them.
 *
 * Usage:
 *   npm run enrich:handedness
 *   npm run enrich:handedness -- --delay 500
 *   npm run enrich:handedness -- --limit 100      # cap people lookups this run
 *   npm run enrich:handedness -- --dry-run        # report only, no writes
 *   npm run enrich:handedness -- --pitchers-only
 *   npm run enrich:handedness -- --batters-only
 */
import { enrichHandedness } from './enrichHandedness.js';

interface Parsed {
  delayMs?: number;
  limit?: number;
  dryRun: boolean;
  pitchersOnly: boolean;
  battersOnly: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { dryRun: false, pitchersOnly: false, battersOnly: false };
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
    } else if (a === '--pitchers-only') {
      out.pitchersOnly = true;
    } else if (a === '--batters-only') {
      out.battersOnly = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected positional arg: ${a}`);
    }
  }
  if (out.pitchersOnly && out.battersOnly) {
    throw new Error('--pitchers-only and --batters-only are mutually exclusive');
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await enrichHandedness(opts);
  if (result.failures.length > 0) {
    console.error(`[runEnrichHandedness] completed with ${result.failures.length} failed lookup(s).`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runEnrichHandedness] FAILED:', err);
  process.exit(1);
});
