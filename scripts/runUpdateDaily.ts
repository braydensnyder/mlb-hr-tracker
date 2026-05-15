/**
 * CLI: orchestrated update — manual entry point.
 *
 * Smart-cron tiers (what the hourly Vercel cron picks automatically):
 *   npm run update:light      → hourly tick; ingest HRs, refresh statuses
 *   npm run update:full       → heavy refresh; all enrichments + summaries
 *                               (force-rebuilds today's snapshot)
 *   npm run update:night      → postgame final; FORCE update today snapshot
 *
 * Legacy manual modes (kept for ad-hoc use):
 *   npm run update:daily      → full pass (yesterday + today)
 *   npm run update:morning    → pregame baseline; FORCE rebuild today snapshot
 *   npm run update:live       → midday refresh; PRESERVE baseline snapshot
 *
 * The Vercel cron endpoint (`/api/cron/update`) chooses light/full/night
 * automatically from the clock + cron_state — see scripts/lib/cronState.ts.
 *
 * Exit codes:
 *   0  all steps ok
 *   2  some step(s) failed (run logs which); rerun is always safe
 *   1  fatal (couldn't even start)
 */
import { updateDaily, type UpdateMode } from './updateDaily.js';

const arg = (process.argv[2] ?? 'daily').toLowerCase() as UpdateMode;
const VALID: UpdateMode[] = ['light', 'full', 'night', 'daily', 'morning', 'live'];
if (!VALID.includes(arg)) {
  console.error(`Invalid mode "${arg}". Use one of: ${VALID.join(' | ')}`);
  process.exit(1);
}

// Manual `full` runs force the snapshot rebuild (operator intent).
const forceSnapshot = arg === 'full';

updateDaily(arg, { forceSnapshot })
  .then((result) => {
    if (result.failures.length > 0) process.exit(2);
  })
  .catch((err) => {
    console.error('[runUpdateDaily] FATAL:', err);
    process.exit(1);
  });
