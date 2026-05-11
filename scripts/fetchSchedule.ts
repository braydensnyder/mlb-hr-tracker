/**
 * fetchSchedule(date) — get all MLB games for a given YYYY-MM-DD.
 *
 * Returns a normalized list of { game_pk, game_date, home_team, away_team, status }.
 */
import { getScheduleRaw } from './lib/mlb.js';
import type { ScheduledGame } from './lib/types.js';

export async function fetchSchedule(date: string): Promise<ScheduledGame[]> {
  const raw = await getScheduleRaw(date);
  const out: ScheduledGame[] = [];

  for (const day of raw?.dates ?? []) {
    for (const g of day?.games ?? []) {
      // Skip non-regular MLB items if any sneak through
      if (!g?.gamePk) continue;

      // Probable pitchers may be null until MLB announces them — that's fine,
      // we surface "TBD" in the UI.
      const homePP = g?.teams?.home?.probablePitcher ?? null;
      const awayPP = g?.teams?.away?.probablePitcher ?? null;

      out.push({
        game_pk: g.gamePk,
        game_date: day.date ?? date,
        home_team: g?.teams?.home?.team?.name ?? 'Unknown',
        away_team: g?.teams?.away?.team?.name ?? 'Unknown',
        // detailedState is the user-friendly status: "Final", "In Progress", "Scheduled", etc.
        status: g?.status?.detailedState ?? g?.status?.abstractGameState ?? 'Unknown',
        game_type: typeof g?.gameType === 'string' ? g.gameType : null,

        venue_id: g?.venue?.id ? Number(g.venue.id) : null,
        venue_name: g?.venue?.name ?? null,
        home_probable_pitcher_id: homePP?.id ? Number(homePP.id) : null,
        home_probable_pitcher_name: homePP?.fullName ?? null,
        // pitchHand is sometimes present on the schedule's probablePitcher; fall
        // back to null. enrich:handedness fills in the rest from /v1/people/{id}.
        home_probable_pitcher_hand: normHand(homePP?.pitchHand?.code),
        away_probable_pitcher_id: awayPP?.id ? Number(awayPP.id) : null,
        away_probable_pitcher_name: awayPP?.fullName ?? null,
        away_probable_pitcher_hand: normHand(awayPP?.pitchHand?.code),
      });
    }
  }

  return out;
}

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}
