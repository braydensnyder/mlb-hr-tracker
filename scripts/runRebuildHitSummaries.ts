/**
 * CLI: rebuild hit summaries for a specific date.
 * Usage:
 *   npm run rebuild:hit-summaries              # today
 *   npm run rebuild:hit-summaries -- 2026-08-10
 *   npm run rebuild:hit-summaries -- yesterday
 */
import 'dotenv/config';
import { rebuildHitSummaries } from './rebuildHitSummaries.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

function parseDate(arg?: string): string {
  if (!arg || arg === 'today') return mlbToday();
  if (arg === 'yesterday') return mlbAddDays(mlbToday(), -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  throw new Error(`Unrecognized date arg: ${arg}`);
}

async function main() {
  const date = parseDate(process.argv[2]);
  const res = await rebuildHitSummaries(date);
  console.log('[runRebuildHitSummaries] result:', res);
}

main().catch((err) => {
  console.error('[runRebuildHitSummaries] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
