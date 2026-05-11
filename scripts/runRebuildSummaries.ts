/**
 * CLI entrypoint: rebuild rolling player summaries for a date.
 *
 * Usage:
 *   npm run rebuild:summaries                # uses today's date
 *   npm run rebuild:summaries -- 2025-04-15
 *   npm run rebuild:summaries -- yesterday
 */
import { rebuildPlayerSummaries } from './rebuildPlayerSummaries.js';

function resolveDate(arg: string | undefined): string | undefined {
  if (!arg || arg === 'today') return undefined;
  if (arg === 'yesterday') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    throw new Error(`Invalid date "${arg}". Use YYYY-MM-DD, "today", or "yesterday".`);
  }
  return arg;
}

async function main() {
  const date = resolveDate(process.argv[2]);
  const result = await rebuildPlayerSummaries(date);
  console.log('[runRebuildSummaries] result:', result);
}

main().catch((err) => {
  console.error('[runRebuildSummaries] FAILED:', err);
  process.exit(1);
});
