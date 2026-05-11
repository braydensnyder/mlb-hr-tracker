/**
 * Null-safe upsert into `games`.
 *
 * Why this exists: `enrichSchedule` and `processDate` both write game rows.
 * The MLB schedule API returns null for probable pitchers and venue when
 * MLB hasn't announced them yet. If we naively upsert null over an
 * existing good value, we lose data.
 *
 * upsertGameRows() omits null/undefined matchup-context fields from the
 * payload so Supabase only updates the columns we actually have data for.
 * Core identity/status fields (game_pk, game_date, home_team, away_team,
 * status, game_type) are always written; everything else only when known.
 *
 * Idempotent and safe to re-run.
 */
import { supabaseAdmin } from './supabaseAdmin.js';
import type { ScheduledGame } from './types.js';

export async function upsertGameRows(games: ScheduledGame[]): Promise<number> {
  if (games.length === 0) return 0;

  const rows = games.map((g) => {
    const base: Record<string, unknown> = {
      game_pk: g.game_pk,
      game_date: g.game_date,
      home_team: g.home_team,
      away_team: g.away_team,
      status: g.status,
      // game_type can legitimately be null (very rare) — write it as-is so we
      // can still filter by it; nulling it out doesn't hurt anything.
      game_type: g.game_type,
    };

    // Matchup-context fields: only include when we have a non-null value.
    // This is the key piece: a future game whose probables are TBD won't
    // erase a previously-fetched probable when MLB un-announces and re-announces.
    if (g.venue_id != null) base.venue_id = g.venue_id;
    if (g.venue_name) base.venue_name = g.venue_name;

    if (g.home_probable_pitcher_id != null) {
      base.home_probable_pitcher_id = g.home_probable_pitcher_id;
      base.home_probable_pitcher_name = g.home_probable_pitcher_name;
      base.home_probable_pitcher_hand = g.home_probable_pitcher_hand;
    }
    if (g.away_probable_pitcher_id != null) {
      base.away_probable_pitcher_id = g.away_probable_pitcher_id;
      base.away_probable_pitcher_name = g.away_probable_pitcher_name;
      base.away_probable_pitcher_hand = g.away_probable_pitcher_hand;
    }

    return base;
  });

  // defaultToNull: false → unmentioned columns keep their existing DB value
  // instead of being reset to NULL. Requires supabase-js >= 2.30 (we're on 2.45+).
  const { error } = await supabaseAdmin
    .from('games')
    .upsert(rows, { onConflict: 'game_pk', defaultToNull: false });
  if (error) throw new Error(`upsertGameRows failed: ${error.message}`);
  return rows.length;
}
