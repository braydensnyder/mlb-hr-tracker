/**
 * enrichSchedule — refresh probable pitchers + venue on `games` rows for
 * upcoming dates by re-fetching the MLB schedule.
 *
 * Why this exists separately from processDate:
 *   processDate is "ingest finalized games for date D and extract HRs."
 *   By the time D is processed, probable pitchers are usually no longer
 *   relevant. For *future* dates we want a lighter-weight job that just
 *   refreshes the schedule (probables + venue) without touching home_runs.
 *
 * Strategy:
 *   For each date in [start, end] (inclusive):
 *     - Call fetchSchedule(date) (MLB API; hydrate=probablePitcher,venue).
 *     - For each game returned, upsert the games row (creates new rows
 *       for previously unseen game_pks).
 *     - Also upsert the canonical `venues` catalog from any new venue (id, name) pairs.
 *
 * Idempotent: re-running over the same range overwrites probable pitcher
 * info with the latest. It does NOT modify `processed`, `processed_at`,
 * or any HR rows. Old HR data is never touched.
 *
 * CLI flags (via runEnrichSchedule.ts):
 *   --start YYYY-MM-DD   default: today
 *   --end YYYY-MM-DD     default: start + 7 days
 *   --delay N            ms between dates (default 350)
 *   --dry-run            no writes
 */
import { fetchSchedule } from './fetchSchedule.js';
import { upsertVenues } from './lib/venues.js';
import { upsertGameRows } from './lib/games.js';
import { withRetry } from './lib/retry.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

export interface EnrichScheduleOptions {
  start?: string; // YYYY-MM-DD
  end?: string;   // YYYY-MM-DD
  delayMs?: number;
  dryRun?: boolean;
}

export interface EnrichScheduleResult {
  start: string;
  end: string;
  daysAttempted: number;
  daysSucceeded: number;
  gamesUpserted: number;
  probablesFilled: number;     // count of probable-pitcher fields newly non-null this run
  venuesCatalogUpserts: number;
  failures: { date: string; error: string }[];
}

// Pacific calendar date — see scripts/lib/mlbDate.ts.
const todayISO = mlbToday;
const addDays = mlbAddDays;

function enumerateDates(start: string, end: string): string[] {
  if (start > end) throw new Error(`start (${start}) is after end (${end})`);
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function enrichSchedule(opts: EnrichScheduleOptions = {}): Promise<EnrichScheduleResult> {
  const start = opts.start ?? todayISO();
  const end = opts.end ?? addDays(start, 7);
  const delayMs = opts.delayMs ?? 350;
  const dryRun = !!opts.dryRun;

  const dates = enumerateDates(start, end);
  console.log(`[enrichSchedule] refreshing ${dates.length} day(s) ${start} → ${end}${dryRun ? ' (dry-run)' : ''}`);

  const result: EnrichScheduleResult = {
    start,
    end,
    daysAttempted: dates.length,
    daysSucceeded: 0,
    gamesUpserted: 0,
    probablesFilled: 0,
    venuesCatalogUpserts: 0,
    failures: [],
  };

  const seenVenues = new Map<number, string>();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    try {
      const games = await withRetry(() => fetchSchedule(date));
      console.log(`  ${date}: ${games.length} game(s)`);
      result.daysSucceeded++;

      // tally probables & venues
      for (const g of games) {
        if (g.home_probable_pitcher_id != null || g.away_probable_pitcher_id != null) {
          result.probablesFilled++;
        }
        if (g.venue_id != null && g.venue_name) {
          seenVenues.set(g.venue_id, g.venue_name);
        }
      }

      if (dryRun || games.length === 0) {
        continue;
      }

      // Null-safe: when MLB returns null for a probable pitcher this round,
      // we DO NOT overwrite a previously-fetched value. The user's safety
      // requirement: "if future probable pitchers are TBD, keep schedule
      // and update again later."
      await upsertGameRows(games);
      result.gamesUpserted += games.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ date, error: msg });
      console.error(`  ${date} FAILED: ${msg}`);
    }
    if (i < dates.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  if (!dryRun && seenVenues.size > 0) {
    const seeds = Array.from(seenVenues.entries()).map(([venue_id, name]) => ({ venue_id, name }));
    result.venuesCatalogUpserts = await upsertVenues(seeds);
  }

  console.log('[enrichSchedule] DONE', {
    daysSucceeded: result.daysSucceeded,
    gamesUpserted: result.gamesUpserted,
    probablesFilled: result.probablesFilled,
    venuesCatalogUpserts: result.venuesCatalogUpserts,
    failures: result.failures.length,
  });
  return result;
}
