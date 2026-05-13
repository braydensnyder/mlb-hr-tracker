/**
 * processDate(date) — fetch the schedule for a date, upsert game rows,
 * and pull HR + pitcher-start data from EVERY actionable game on the
 * date.
 *
 * Two ingest paths, both safe to re-run repeatedly thanks to the
 * `event_key` unique constraint on `home_runs` and the `(game_id,
 * pitcher_id)` constraint on `pitcher_starts`:
 *
 *   1. **Live ingest** — game is In Progress / Manager Challenge / etc.
 *      We pull the live feed, extract any HRs that have already
 *      happened, and upsert them. The game is NOT marked processed,
 *      so the next cron tick will re-ingest any *additional* HRs from
 *      the same game. event_key dedup means re-inserting the same HR
 *      is a no-op.
 *
 *   2. **Final ingest** — game has finished (Final / Game Over /
 *      Completed Early). Same HR extraction PLUS pitcher_starts
 *      extraction (only meaningful for completed starts) PLUS the
 *      game is marked processed=true so it's skipped on subsequent
 *      runs.
 *
 * The split lets the Dashboard reflect actual results during the
 * day — a 5th-inning HR shows up on the next 12:07/3:07 cron — while
 * keeping pitcher_starts accuracy (we only record completed lines).
 */
import { fetchSchedule } from './fetchSchedule.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { extractHomeRuns } from './extractHomeRuns.js';
import { extractPitcherStarts } from './extractPitcherStarts.js';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { upsertVenues } from './lib/venues.js';
import { upsertGameRows } from './lib/games.js';
import { isIngestibleGameType } from './lib/gameTypes.js';

/** Game statuses that indicate the game is OVER (full pitcher_starts +
 *  mark processed=true). */
const FINAL_STATUSES = new Set([
  'Final',
  'Game Over',
  'Completed Early',
]);

/** Game statuses that indicate live action has started or is on a
 *  pause — HRs may exist in the feed; pitcher_starts not yet meaningful
 *  because innings_pitched / decision aren't finalized. Don't mark
 *  processed. */
const LIVE_STATUSES = new Set([
  'In Progress',
  'Manager Challenge',
  'Delayed',
  'Delayed: Rain',
  'Suspended',
  'Suspended: Rain',
  'Warmup',
]);

export interface ProcessDateResult {
  date: string;
  totalGames: number;
  /** Games currently live (in-progress / delayed / suspended). */
  liveGamesChecked: number;
  /** Games that were finalized AND newly processed this run. */
  finalGamesProcessed: number;
  /** Games already marked processed=true (skipped). */
  alreadyProcessed: number;
  /** Games not yet scheduled to start (Preview, Scheduled, etc.). */
  pendingPregame: number;
  /** Total HR rows inserted across live + final ingest. event_key
   *  dedup means this counts the NET new rows (DB returns the inserted
   *  count, not the attempted count). */
  homeRunsInserted: number;
  /** Pitcher-start rows inserted (final games only). */
  pitcherStartsInserted: number;
  /** Most-recent home_runs.created_at across the rows we just upserted.
   *  null if nothing was inserted this run. */
  latestHrCreatedAt: string | null;
  /** Per-game outcomes for visibility — what each game contributed. */
  perGame: {
    game_pk: number;
    status: string;
    classification: 'final' | 'live' | 'already-processed' | 'pregame';
    hrs_inserted: number;
    starts_inserted: number;
    error?: string;
  }[];
}

export async function processDate(date: string): Promise<ProcessDateResult> {
  console.log(`[processDate] starting for ${date}`);

  // ---- 1. schedule + upsert game rows ----
  const allGames = await fetchSchedule(date);
  // Filter out non-MLB game types (All-Star, exhibition, intrasquad) so we
  // never ingest HRs whose team/opponent are country names like "United States."
  const games = allGames.filter((g) => isIngestibleGameType(g.game_type));
  const skipped = allGames.length - games.length;
  console.log(
    `[processDate] schedule returned ${allGames.length} games` +
      (skipped > 0 ? ` (skipping ${skipped} non-MLB gameType)` : ''),
  );

  if (games.length > 0) {
    await upsertGameRows(games);
    const venueSeeds = games
      .filter((g) => g.venue_id != null && g.venue_name)
      .map((g) => ({ venue_id: g.venue_id as number, name: g.venue_name as string }));
    if (venueSeeds.length > 0) await upsertVenues(venueSeeds);
  }

  // ---- 2. read back the latest game-state rows from DB (post-upsert) ----
  const { data: dbGames, error: dbErr } = await supabaseAdmin
    .from('games')
    .select('game_pk, game_date, status, processed')
    .eq('game_date', date);
  if (dbErr) throw new Error(`select games failed: ${dbErr.message}`);

  const allDay = dbGames ?? [];
  const live      = allDay.filter((g) => LIVE_STATUSES.has(g.status));
  const finals    = allDay.filter((g) => FINAL_STATUSES.has(g.status) && !g.processed);
  const done      = allDay.filter((g) => g.processed);
  const pregame   = allDay.filter((g) => !FINAL_STATUSES.has(g.status) && !LIVE_STATUSES.has(g.status) && !g.processed);
  console.log(
    `[processDate] state: ${allDay.length} total · ` +
      `${live.length} live · ${finals.length} final/unprocessed · ` +
      `${done.length} already-processed · ${pregame.length} pregame`,
  );

  let totalHRs = 0;
  let totalStarts = 0;
  let latestHrCreatedAt: string | null = null;
  const perGame: ProcessDateResult['perGame'] = [];

  // Helper that records the per-game outcome + bumps the totals.
  const record = (
    game_pk: number,
    status: string,
    classification: 'final' | 'live' | 'already-processed' | 'pregame',
    hrs_inserted: number,
    starts_inserted: number,
    error?: string,
  ) => {
    perGame.push({ game_pk, status, classification, hrs_inserted, starts_inserted, error });
    totalHRs    += hrs_inserted;
    totalStarts += starts_inserted;
  };

  // ---- 3a. process LIVE games — HRs only, leave processed=false ----
  for (const game of live) {
    try {
      const feed = await fetchGameFeed(game.game_pk);
      const hrs = extractHomeRuns(feed);
      const inserted = await upsertHomeRuns(hrs);
      latestHrCreatedAt = bumpLatestCreatedAt(latestHrCreatedAt, inserted.maxCreatedAt);
      console.log(
        `  [live game ${game.game_pk}] status="${game.status}" ` +
          `${inserted.netInserted}/${hrs.length} new HR(s) ingested ` +
          `(processed=false → will re-check next run)`,
      );
      record(game.game_pk, game.status, 'live', inserted.netInserted, 0);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`  [live game ${game.game_pk}] FAILED: ${m}`);
      record(game.game_pk, game.status, 'live', 0, 0, m);
    }
  }

  // ---- 3b. process FINAL games — HRs + pitcher_starts + mark processed ----
  for (const game of finals) {
    try {
      const feed = await fetchGameFeed(game.game_pk);
      const hrs = extractHomeRuns(feed);
      const starts = extractPitcherStarts(feed);

      const hrIns = await upsertHomeRuns(hrs);
      latestHrCreatedAt = bumpLatestCreatedAt(latestHrCreatedAt, hrIns.maxCreatedAt);

      let starterCount = 0;
      if (starts.length > 0) {
        try {
          const { error: psErr } = await supabaseAdmin
            .from('pitcher_starts')
            .upsert(starts, { onConflict: 'game_id,pitcher_id' });
          if (psErr) {
            console.warn(`  [final game ${game.game_pk}] pitcher_starts upsert FAILED (non-fatal): ${psErr.message}`);
          } else {
            starterCount = starts.length;
          }
        } catch (psErr) {
          const m = psErr instanceof Error ? psErr.message : String(psErr);
          console.warn(`  [final game ${game.game_pk}] pitcher_starts threw (non-fatal): ${m}`);
        }
      }

      // Mark processed AFTER ingest succeeds so a transient failure
      // doesn't leave us with a game we'll never re-check.
      const { error: markErr } = await supabaseAdmin
        .from('games')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('game_pk', game.game_pk);
      if (markErr) throw new Error(`mark processed failed: ${markErr.message}`);

      console.log(
        `  [final game ${game.game_pk}] ${hrIns.netInserted} new HR(s), ` +
          `${starterCount}/${starts.length} starter(s), processed=true`,
      );
      record(game.game_pk, game.status, 'final', hrIns.netInserted, starterCount);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`  [final game ${game.game_pk}] FAILED: ${m}`);
      record(game.game_pk, game.status, 'final', 0, 0, m);
    }
  }

  // ---- 3c. record the no-op buckets so the summary is honest ----
  for (const g of done)    record(g.game_pk, g.status, 'already-processed', 0, 0);
  for (const g of pregame) record(g.game_pk, g.status, 'pregame', 0, 0);

  console.log(
    `  results processed — ${finals.length} game(s), ${totalHRs} HR(s), ` +
      `${totalStarts} starter row(s) for ${date}`,
  );
  // Granular phrases the orchestrator + cron response can grep for.
  console.log(`  live games checked — ${live.length} for ${date}`);
  console.log(`  finals newly processed — ${finals.length} for ${date}`);
  console.log(`  home runs ingested — ${totalHRs} new row(s) for ${date}`);
  if (latestHrCreatedAt) {
    console.log(`  latest HR created_at — ${latestHrCreatedAt}`);
  }

  return {
    date,
    totalGames: games.length,
    liveGamesChecked: live.length,
    finalGamesProcessed: finals.length,
    alreadyProcessed: done.length,
    pendingPregame: pregame.length,
    homeRunsInserted: totalHRs,
    pitcherStartsInserted: totalStarts,
    latestHrCreatedAt,
    perGame,
  };
}

/**
 * Upsert HR rows and report (a) how many were actually NEW (net new
 * rows inserted) and (b) the freshest `created_at` we saw. Re-ingesting
 * the same HR is a no-op thanks to the event_key unique constraint.
 *
 * Supabase doesn't return per-row insert-vs-update info, so we lean on
 * a tiny SELECT … IN (event_key) AFTER the upsert to count distinct
 * created_at values. If the row's created_at matches the upsert moment
 * within 5s, we treat it as net-new. Reasonable proxy; the metric is
 * surfaced for dashboarding only, not used for any business logic.
 */
async function upsertHomeRuns(hrs: any[]): Promise<{ netInserted: number; maxCreatedAt: string | null }> {
  if (hrs.length === 0) return { netInserted: 0, maxCreatedAt: null };

  const t0 = new Date();
  const { error: insErr } = await supabaseAdmin
    .from('home_runs')
    .upsert(hrs, { onConflict: 'event_key' });
  if (insErr) throw new Error(`upsert home_runs failed: ${insErr.message}`);

  const keys = hrs.map((h) => h.event_key);
  const { data, error } = await supabaseAdmin
    .from('home_runs')
    .select('event_key, created_at')
    .in('event_key', keys);
  if (error || !data) return { netInserted: 0, maxCreatedAt: null };

  let netInserted = 0;
  let maxCreatedAt: string | null = null;
  const FIVE_SEC_MS = 5_000;
  for (const r of data as { event_key: string; created_at: string }[]) {
    const ts = new Date(r.created_at).getTime();
    if (Math.abs(ts - t0.getTime()) <= FIVE_SEC_MS) netInserted++;
    if (!maxCreatedAt || r.created_at > maxCreatedAt) maxCreatedAt = r.created_at;
  }
  return { netInserted, maxCreatedAt };
}

function bumpLatestCreatedAt(cur: string | null, next: string | null): string | null {
  if (!next) return cur;
  if (!cur) return next;
  return next > cur ? next : cur;
}
