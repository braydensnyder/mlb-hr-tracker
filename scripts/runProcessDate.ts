/**
 * CLI entrypoint: process a single date.
 *
 * Usage:
 *   npm run process:date -- 2025-04-15
 *   npm run process:date -- yesterday
 *   npm run process:date -- today
 *   npm run process:yesterday
 *   npm run process:today
 *
 * After processing, it also rebuilds rolling player summaries for that date,
 * so the dashboard reflects the new HRs immediately.
 */
import { processDate } from './processDate.js';
import { rebuildPlayerSummaries } from './rebuildPlayerSummaries.js';

function resolveDate(arg: string | undefined): string {
  const today = new Date();
  if (!arg || arg === 'today') return ymd(today);
  if (arg === 'yesterday') {
    today.setUTCDate(today.getUTCDate() - 1);
    return ymd(today);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    throw new Error(`Invalid date "${arg}". Use YYYY-MM-DD, "today", or "yesterday".`);
  }
  return arg;
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const date = resolveDate(process.argv[2]);
  const result = await processDate(date);
  console.log('[runProcessDate] processDate result:', result);

  const rebuild = await rebuildPlayerSummaries(date);
  console.log('[runProcessDate] rebuild result:', rebuild);
}

main().catch((err) => {
  console.error('[runProcessDate] FAILED:', err);
  process.exit(1);
});
