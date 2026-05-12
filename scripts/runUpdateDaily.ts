/**
 * CLI: orchestrated daily update.
 *
 * Usage:
 *   npm run update:daily      → full pass (yesterday + today) — manual
 *   npm run update:morning    → pregame baseline; FORCE rebuild today snapshot
 *   npm run update:live       → midday refresh; PRESERVE morning baseline
 *   npm run update:night      → postgame final; FORCE update today snapshot
 *
 * Vercel Cron triggers the same modes automatically via the
 * `?mode=...` query in vercel.json.
 *
 * Exit codes:
 *   0  all steps ok
 *   2  some step(s) failed (run logs which); rerun is always safe
 *   1  fatal (couldn't even start)
 */
import { updateDaily, type UpdateMode } from './updateDaily.js';

const arg = (process.argv[2] ?? 'daily').toLowerCase() as UpdateMode;
if (!['daily', 'morning', 'live', 'night'].includes(arg)) {
  console.error(`Invalid mode "${arg}". Use one of: daily | morning | live | night`);
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
