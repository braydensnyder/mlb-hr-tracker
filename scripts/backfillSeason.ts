/**
 * backfillSeason(start, end) — process every date in [start, end] inclusive.
 *
 * - Calls processDate(date) per day, which is itself idempotent: it skips
 *   already-processed games and dedups HRs by event_key.
 * - One bad day does not kill the run; errors are logged and we keep going.
 * - We pause briefly between dates so we don't hammer the public MLB API.
 * - At the very end we rebuild player_daily_summary once for the end date,
 *   which gives the most up-to-date rolling view (the dashboard now mostly
 *   computes from raw home_runs, but we keep this fresh for backwards compat).
 */
import { processDate, type ProcessDateResult } from './processDate.js';
import { rebuildPlayerSummaries } from './rebuildPlayerSummaries.js';

export interface BackfillSummary {
  start: string;
  end: string;
  daysAttempted: number;
  daysSucceeded: number;
  daysFailed: number;
  totalGamesProcessed: number;
  totalHomeRunsInserted: number;
  failures: { date: string; error: string }[];
}

export interface BackfillOptions {
  /** ms to sleep between dates. Default 350ms ≈ 3 req/sec. */
  delayMs?: number;
  /** if true, also rebuild summaries after every date (slower, fresher). default false */
  rebuildPerDay?: boolean;
}

export async function backfillSeason(
  start: string,
  end: string,
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  assertIsDate(start);
  assertIsDate(end);
  if (start > end) throw new Error(`start (${start}) is after end (${end})`);

  const delayMs = opts.delayMs ?? 350;
  const dates = enumerateDates(start, end);

  console.log(
    `[backfillSeason] processing ${dates.length} day(s) from ${start} → ${end} ` +
      `(delay=${delayMs}ms, rebuildPerDay=${!!opts.rebuildPerDay})`,
  );

  const summary: BackfillSummary = {
    start,
    end,
    daysAttempted: dates.length,
    daysSucceeded: 0,
    daysFailed: 0,
    totalGamesProcessed: 0,
    totalHomeRunsInserted: 0,
    failures: [],
  };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const tag = `[${i + 1}/${dates.length}] ${date}`;
    try {
      const r: ProcessDateResult = await processDate(date);
      summary.daysSucceeded++;
      summary.totalGamesProcessed += r.processedGames;
      summary.totalHomeRunsInserted += r.homeRunsInserted;
      console.log(
        `${tag} done: ${r.processedGames}/${r.totalGames} games, ${r.homeRunsInserted} HRs`,
      );

      if (opts.rebuildPerDay) {
        await rebuildPlayerSummaries(date);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.daysFailed++;
      summary.failures.push({ date, error: msg });
      console.error(`${tag} FAILED: ${msg}`);
    }

    if (i < dates.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  // One final summary rebuild for the end date so rolling stats are current.
  try {
    const r = await rebuildPlayerSummaries(end);
    console.log(`[backfillSeason] final rebuild for ${end}: ${r.playersWritten} player rows`);
  } catch (err) {
    console.error('[backfillSeason] final rebuild failed:', err);
  }

  console.log('[backfillSeason] DONE', summary);
  return summary;
}

// ---------- helpers ----------

function assertIsDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date "${s}". Expected YYYY-MM-DD.`);
  }
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const stop = new Date(Date.UTC(ey, em - 1, ed));
  while (cur.getTime() <= stop.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
