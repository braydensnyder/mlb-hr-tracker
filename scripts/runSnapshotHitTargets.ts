/**
 * CLI: snapshot Hits targets for a specific date.
 * Usage:
 *   npm run snapshot:hits                        # today
 *   npm run snapshot:hits -- 2026-08-15
 *   npm run snapshot:hits -- yesterday
 *   npm run snapshot:hits -- tomorrow
 *   npm run snapshot:hits -- today --force       # operator override
 */
import 'dotenv/config';
import { snapshotHitTargets } from './snapshotHitTargets.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

interface Args { date: string; force: boolean; }
function parseArgs(argv: string[]): Args {
  let date = mlbToday();
  let force = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === 'today') date = mlbToday();
    else if (a === 'yesterday') date = mlbAddDays(mlbToday(), -1);
    else if (a === 'tomorrow') date = mlbAddDays(mlbToday(), 1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) date = a;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return { date, force };
}

async function main() {
  const { date, force } = parseArgs(process.argv.slice(2));
  const res = await snapshotHitTargets(date, { force, skipIfGamesStarted: !force });
  console.log('[runSnapshotHitTargets] result:', res);
}

main().catch((err) => {
  console.error('[runSnapshotHitTargets] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
