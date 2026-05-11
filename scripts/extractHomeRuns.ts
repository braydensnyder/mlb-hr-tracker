/**
 * extractHomeRuns(gameFeed) — find every home-run play in a /v1.1/game/<pk>/feed/live response
 * and normalize it into HomeRunRecord rows ready to upsert into `home_runs`.
 *
 * MLB Stats API places plays at:
 *   gameFeed.liveData.plays.allPlays[]
 * A home run looks like:
 *   play.result.eventType === 'home_run'   (or play.result.event === 'Home Run')
 * Statcast metrics, when present, are on:
 *   play.playEvents[].hitData.{ launchSpeed, launchAngle, totalDistance }
 * (the relevant playEvent is the one with isPitch=true and the in-play hit result).
 */
import type { HomeRunRecord } from './lib/types.js';

export function extractHomeRuns(gameFeed: any): HomeRunRecord[] {
  const out: HomeRunRecord[] = [];
  if (!gameFeed) return out;

  const gamePk: number | undefined = gameFeed?.gamePk ?? gameFeed?.gameData?.game?.pk;
  // officialDate is the league-canonical date; falls back to the feed date if absent.
  const gameDate: string =
    gameFeed?.gameData?.datetime?.officialDate ??
    gameFeed?.gameData?.datetime?.originalDate ??
    new Date().toISOString().slice(0, 10);

  const homeName: string = gameFeed?.gameData?.teams?.home?.name ?? 'Unknown';
  const awayName: string = gameFeed?.gameData?.teams?.away?.name ?? 'Unknown';
  const venueName: string | null = gameFeed?.gameData?.venue?.name ?? null;
  const venueId: number | null = gameFeed?.gameData?.venue?.id ? Number(gameFeed.gameData.venue.id) : null;

  const allPlays: any[] = gameFeed?.liveData?.plays?.allPlays ?? [];

  for (const play of allPlays) {
    const eventType: string = play?.result?.eventType ?? '';
    const eventName: string = play?.result?.event ?? '';
    const isHR =
      eventType === 'home_run' ||
      eventName.toLowerCase() === 'home run';
    if (!isHR) continue;

    const batter = play?.matchup?.batter;
    const pitcher = play?.matchup?.pitcher;
    if (!batter?.id) continue;

    // halfInning is "top" (away batting) or "bottom" (home batting).
    const halfInning: string = play?.about?.halfInning ?? '';
    const battingTeamIsHome = halfInning === 'bottom';
    const team = battingTeamIsHome ? homeName : awayName;
    const opponent = battingTeamIsHome ? awayName : homeName;

    // Statcast hit data lives on the play event that produced the result.
    const hitEvent = (play.playEvents ?? [])
      .slice()
      .reverse()
      .find((ev: any) => ev?.hitData);
    const hit = hitEvent?.hitData ?? {};

    // Stable dedup key: game + batter + inning + at-bat index. atBatIndex is
    // present on every play and unique within a game, so this is bulletproof.
    const atBatIndex = play?.atBatIndex ?? play?.about?.atBatIndex ?? 'na';
    const event_key = `${gamePk}-${batter.id}-${atBatIndex}`;

    // batSide.code is the per-AB batting side (handles switch hitters correctly).
    // pitchHand.code is the pitcher's throwing hand. Both are 'L' / 'R' / 'S'.
    const batter_side = normHand(play?.matchup?.batSide?.code);
    const pitcher_throws = normHand(play?.matchup?.pitchHand?.code);

    out.push({
      game_pk: Number(gamePk),
      game_date: gameDate,
      player_id: Number(batter.id),
      player_name: batter?.fullName ?? 'Unknown Batter',
      team,
      opponent,
      inning: typeof play?.about?.inning === 'number' ? play.about.inning : null,
      pitcher_id: pitcher?.id ? Number(pitcher.id) : null,
      pitcher_name: pitcher?.fullName ?? null,
      exit_velocity: numOrNull(hit.launchSpeed),
      launch_angle: numOrNull(hit.launchAngle),
      distance: numOrNull(hit.totalDistance),
      batter_side,
      pitcher_throws,
      venue_id: venueId,
      venue_name: venueName,
      event_key,
    });
  }

  return out;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : null;
}

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}
