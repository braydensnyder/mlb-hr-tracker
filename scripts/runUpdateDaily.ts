/**
 * CLI: orchestrated daily update.
 *
 * Usage:
 *   npm run update:daily      → full pass (yesterday + today)
 *   npm run update:morning    → yesterday only (faster; intended for ~8 AM runs)
 *   npm run update:night      → today only (faster; intended for ~10 PM runs)
 *
 * Exit codes:
 *   0  all steps ok
 *   2  some step(s) failed (run logs which); rerun is always safe
 *   1  fatal (couldn't even start)
 */
import { updateDaily, type UpdateMode } from './updateDaily.js';

const arg = (process.argv[2] ?? 'daily').toLowerCase() as UpdateMode;
if (!['daily', 'morning', 'night'].includes(arg)) {
  console.error(`Invalid mode "${arg}". Use one of: daily | morning | night`);
  process.exit(1);
}

updateDaily(arg)
  .then((result) => {
    if (result.failures.length > 0) process.exit(2);
  })
  .catch((err) => {
    console.error('[runUpdateDaily] FATAL:', err);
    process.exit(1);
  });
