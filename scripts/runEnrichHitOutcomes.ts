/**
 * CLI: enrich hit_target_snapshots outcome fields for a date.
 * Usage:
 *   npm run enrich:hit-outcomes                      # yesterday
 *   npm run enrich:hit-outcomes -- 2026-08-15
 *   npm run enrich:hit-outcomes -- today
 *   npm run enrich:hit-outcomes -- yesterday --force  # re-write even enriched rows
 */
import 'dotenv/config';
import { enrichHitOutcomes } from './enrichHitOutcomes.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

interface Args { date: string; force: boolean; }
function parseArgs(argv: string[]): Args {
  // Default to YESTERDAY — that's the typical post-game enrichment target.
  let date = mlbAddDays(mlbToday(), -1);
  let force = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === 'today') date = mlbToday();
    else if (a === 'yesterday') date = mlbAddDays(mlbToday(), -1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) date = a;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return { date, force };
}

async function main() {
  const { date, force } = parseArgs(process.argv.slice(2));
  const res = await enrichHitOutcomes(date, { force });
  console.log('[runEnrichHitOutcomes] result:', res);
}

main().catch((err) => {
  console.error('[runEnrichHitOutcomes] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
