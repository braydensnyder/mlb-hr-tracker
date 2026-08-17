/**
 * CLI: rebuild pitcher form for a specific date (as_of).
 * Usage:
 *   npm run rebuild:pitcher-form              # today
 *   npm run rebuild:pitcher-form -- 2026-08-10
 *   npm run rebuild:pitcher-form -- yesterday
 */
import 'dotenv/config';
import { rebuildPitcherForm } from './rebuildPitcherForm.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

function parseDate(arg?: string): string {
  if (!arg || arg === 'today') return mlbToday();
  if (arg === 'yesterday') return mlbAddDays(mlbToday(), -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  throw new Error(`Unrecognized date arg: ${arg}`);
}

async function main() {
  const date = parseDate(process.argv[2]);
  const res = await rebuildPitcherForm(date);
  console.log('[runRebuildPitcherForm] result:', res);
}

main().catch((err) => {
  console.error('[runRebuildPitcherForm] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
