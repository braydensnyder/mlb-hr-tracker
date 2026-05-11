/**
 * CLI: populate / refresh the canonical `players` table from /v1/people/{id}.
 *
 * Usage:
 *   npm run enrich:players
 *   npm run enrich:players -- --dry-run
 *   npm run enrich:players -- --limit 200
 *   npm run enrich:players -- --refresh-days 3
 *   npm run enrich:players -- --force         # ignore freshness, refresh all
 */
import { enrichPlayers } from './enrichPlayers.js';

interface Parsed {
  delayMs?: number;
  limit?: number;
  refreshDays?: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { dryRun: false, force: false };
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
    } else if (a === '--refresh-days') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--refresh-days needs a non-negative number`);
      out.refreshDays = Math.floor(v);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--force') {
      out.force = true;
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
  const result = await enrichPlayers(opts);
  if (result.failures.length > 0) {
    console.error(`[runEnrichPlayers] completed with ${result.failures.length} failed lookup(s).`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runEnrichPlayers] FAILED:', err);
  process.exit(1);
});
