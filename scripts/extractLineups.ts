/**
 * extractLineups(gameFeed) — pull the confirmed starting batting order
 * (and game status) from a /v1.1/game/<pk>/feed/live response.
 *
 * Source of truth: `liveData.boxscore.teams.{home,away}.battingOrder`.
 * MLB populates this with 9 personIds per side once the official lineup
 * is posted (typically 2–4 hours before first pitch). Before that the
 * array is empty / absent — that's our "lineup pending" signal.
 *
 * We DELIBERATELY treat batting-order presence as the only "is this
 * player starting?" signal. The feed does not give a clean injured-vs-
 * rested distinction pre-game, so a player whose lineup is posted but
 * who isn't in the order is classified "not starting" (could be a rest
 * day, platoon sit, or injury — all equally "won't be in the lineup").
 */

export interface GameLineups {
  game_pk: number;
  /** Detailed status string, e.g. "Scheduled", "Warmup", "In Progress",
   *  "Postponed", "Final". Drives postponed/cancelled hiding. */
  status: string | null;
  /** Player IDs in the HOME batting order (length 9 when posted, else []). */
  home_lineup: number[];
  /** Player IDs in the AWAY batting order. */
  away_lineup: number[];
  /** True when BOTH sides have a populated (≥9) batting order. */
  lineups_confirmed: boolean;
}

function toIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === 'string' ? Number(x) : (x as number);
    if (Number.isFinite(n)) out.push(n as number);
  }
  return out;
}

export function extractLineups(gameFeed: any): GameLineups | null {
  if (!gameFeed) return null;
  const game_pk: number | undefined = gameFeed?.gamePk ?? gameFeed?.gameData?.game?.pk;
  if (game_pk == null) return null;

  const status: string | null =
    gameFeed?.gameData?.status?.detailedState ??
    gameFeed?.gameData?.status?.abstractGameState ??
    null;

  const homeBox = gameFeed?.liveData?.boxscore?.teams?.home;
  const awayBox = gameFeed?.liveData?.boxscore?.teams?.away;

  const home_lineup = toIdArray(homeBox?.battingOrder);
  const away_lineup = toIdArray(awayBox?.battingOrder);

  // "Confirmed" requires a real 9-man order on BOTH sides. A partial /
  // single-side order is still treated as pending so we don't half-confirm.
  const lineups_confirmed = home_lineup.length >= 9 && away_lineup.length >= 9;

  return {
    game_pk: Number(game_pk),
    status,
    home_lineup,
    away_lineup,
    lineups_confirmed,
  };
}

/** Statuses that mean "no game will be played" — players from these games
 *  should be hidden from HR Targets entirely. */
const DEAD_GAME_STATUSES = [
  'postponed', 'cancelled', 'canceled', 'suspended', 'delayed: rain',
];

export function isDeadGameStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.trim().toLowerCase();
  return DEAD_GAME_STATUSES.some((d) => s.includes(d));
}
