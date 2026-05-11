/**
 * processDate(date) — fetch the schedule for a date, upsert game rows,
 * and for each game whose status is "Final" but not yet processed:
 *   1. fetch the live feed
 *   2. extract HR rows
 *   3. upsert into home_runs (dedup by event_key)
 *   4. mark the game as processed
 *
 * Designed to be safe to re-run repeatedly. Once a game is marked processed
 * it's skipped on subsequent runs.
 */
import { fetchSchedule } from './fetchSchedule.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { extractHomeRuns } from './extractHomeRuns.js';
import { extractPitcherStarts } from './extractPitcherStarts.js';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { upsertVenues } from './lib/venues.js';
import { upsertGameRows } from './lib/games.js';
import { isIngestibleGameType } from './lib/gameTypes.js';
import type { ScheduledGame } from './lib/types.js';

const FINAL_STATUSES = new Set([
  'Final',
  'Game Over',
  'Completed Early',
]);

export interface ProcessDateResult {
  date: string;
  totalGames: number;
  processedGames: number;
  skippedGames: number;
  homeRunsInserted: number;
  pitcherStartsInserted: number;
}

export async function processDate(date: string): Promise<ProcessDateResult> {
  console.log(`[processDate] starting for ${date}`);

  // ---- 1. schedule + upsert game rows ----
  const allGames = await fetchSchedule(date);
  // Filter out non-MLB game types (All-Star, exhibition, intrasquad) so we
  // never ingest HRs whose team/opponent are country names like "United States."
  // Spring training & postseason variants are kept. Unknown gameType passes through.
  const games = allGames.filter((g) => isIngestibleGameType(g.game_type));
  const skipped = allGames.length - games.length;
  console.log(
    `[processDate] schedule returned ${allGames.length} games` +
      (skipped > 0 ? ` (skipping ${skipped} non-MLB gameType)` : ''),
  );

  if (games.length > 0) {
    // Null-safe: a TBD probable pitcher won't erase a previously-fetched value.
    await upsertGameRows(games);

    // Keep the canonical venues catalog current with whatever the schedule gave us.
    const venueSeeds = games
      .filter((g) => g.venue_id != null && g.venue_name)
      .map((g) => ({ venue_id: g.venue_id as number, name: g.venue_name as string }));
    if (venueSeeds.length > 0) await upsertVenues(venueSeeds);
  }

  // ---- 2. find finalized + unprocessed games ----
  const { data: pending, error: pendErr } = await supabaseAdmin
    .from('games')
    .select('game_pk, game_date, status, processed')
    .eq('game_date', date)
    .eq('processed', false);
  if (pendErr) throw new Error(`select pending failed: ${pendErr.message}`);

  const finals = (pending ?? []).filter((g) => FINAL_STATUSES.has(g.status));
  console.log(
    `[processDate] ${finals.length} final unprocessed (of ${pending?.length ?? 0} unprocessed total)`,
  );

  // ---- 3. process each ----
  let totalHRs = 0;
  let totalStarts = 0;
  let processedCount = 0;
  for (const game of finals) {
    try {
      const feed = await fetchGameFeed(game.game_pk);
      const hrs = extractHomeRuns(feed);
      const starts = extractPitcherStarts(feed);

      if (hrs.length > 0) {
        const { error: insErr } = await supabaseAdmin
          .from('home_runs')
          .upsert(hrs, { onConflict: 'event_key' });
        if (insErr) throw new Error(`insert home_runs failed: ${insErr.message}`);
      }

      // Pitcher starts: one row per starter, even when they allowed 0 HRs —
      // critical for accurate "L3 starts HR allowed" downstream.
      //
      // Per-pitcher failures are NON-FATAL. HRs are the priority; if the
      // pitcher_starts upsert fails (e.g. schema mismatch, transient DB),
      // we still mark the game as processed so HRs land and the day's
      // ingest doesn't stall.
      let starterCount = 0;
      if (starts.length > 0) {
        try {
          const { error: psErr } = await supabaseAdmin
            .from('pitcher_starts')
            .upsert(starts, { onConflict: 'game_id,pitcher_id' });
          if (psErr) {
            console.warn(
              `  [game ${game.game_pk}] pitcher_starts upsert FAILED (non-fatal): ${psErr.message}`,
            );
          } else {
            starterCount = starts.length;
          }
        } catch (psErr) {
          const m = psErr instanceof Error ? psErr.message : String(psErr);
          console.warn(`  [game ${game.game_pk}] pitcher_starts threw (non-fatal): ${m}`);
        }
      }

      const { error: markErr } = await supabaseAdmin
        .from('games')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('game_pk', game.game_pk);
      if (markErr) throw new Error(`mark processed failed: ${markErr.message}`);

      console.log(`  [game ${game.game_pk}] ${hrs.length} HR(s), ${starterCount}/${starts.length} starter(s)`);
      totalHRs += hrs.length;
      totalStarts += starterCount;
      processedCount += 1;
    } catch (err) {
      // Don't let one bad game kill the batch — log and continue.
      console.error(`  [game ${game.game_pk}] FAILED:`, err);
    }
  }

  return {
    date,
    totalGames: games.length,
    processedGames: processedCount,
    skippedGames: games.length - processedCount,
    homeRunsInserted: totalHRs,
    pitcherStartsInserted: totalStarts,
  };
}
