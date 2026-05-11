/**
 * CLI entrypoint: full rebuild of player_daily_summary from raw home_runs.
 *
 * Usage:
 *   npm run rebuild:all
 *   npm run rebuild:all -- --no-wipe          # incremental (skip the truncate)
 *   npm run rebuild:all -- --delay 200        # ms between dates (default 50)
 *
 * NOTE: the frontend never reads from player_daily_summary anymore — the
 * dashboard and player detail page derive everything from home_runs. This
 * command exists to keep server-side consumers (future Slack bots, scheduled
 * digests, etc.) consistent with the source of truth.
 */
import { rebuildAllSummaries } from './rebuildAllSummaries.js';

function parseArgs(argv: string[]) {
  let wipe = true;
  let delayMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-wipe') wipe = false;
    else if (a === '--delay') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--delay needs a non-negative number`);
      delayMs = v;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected positional arg: ${a}`);
    }
  }
  return { wipe, delayMs };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await rebuildAllSummaries(opts);
  if (result.failures.length > 0) {
    console.error(`[runRebuildAll] completed with ${result.failures.length} failed date(s):`);
    for (const f of result.failures) console.error(`  ${f.date}: ${f.error}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[runRebuildAll] FAILED:', err);
  process.exit(1);
});
