/**
 * extractPitcherStarts(gameFeed) — pull every STARTING pitcher's pitching
 * line from a /v1.1/game/<pk>/feed/live response, shaped for the canonical
 * `pitcher_starts` table (migration 006).
 *
 * "Starter" = `players[IDxxx].stats.pitching.gamesStarted >= 1` on either
 * the home or away boxscore team. Bullpen games may produce 0 or 2+ rows;
 * the caller upserts them all and (game_id, pitcher_id) collapses duplicates.
 *
 * Every column gracefully defaults: missing stats become `null`, missing
 * HR-allowed becomes `0` (the only NOT NULL stat column besides identity).
 */
export interface PitcherStartRecord {
  game_id: number;
  game_date: string;
  pitcher_id: number;
  pitcher_name: string | null;
  pitcher_hand: string | null;
  team_id: number | null;
  team_name: string | null;
  opponent_id: number | null;
  opponent_name: string | null;
  venue_id: number | null;
  venue_name: string | null;
  innings_pitched: number | null;
  hits_allowed: number | null;
  earned_runs: number | null;
  home_runs_allowed: number;
  walks: number | null;
  strikeouts: number | null;
  pitches: number | null;
  decision: string | null;
}

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' ? u : null;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : null;
}

/** Truthy-numeric: pitching flags are sometimes 0/1, sometimes boolean. */
function flag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return false;
}

function deriveDecision(pitching: any): string | null {
  if (flag(pitching?.win))        return 'W';
  if (flag(pitching?.loss))       return 'L';
  if (flag(pitching?.save))       return 'SV';
  if (flag(pitching?.hold))       return 'H';
  if (flag(pitching?.blownSave))  return 'BS';
  return null;
}

export function extractPitcherStarts(gameFeed: any): PitcherStartRecord[] {
  const out: PitcherStartRecord[] = [];
  if (!gameFeed) return out;

  const gameId: number | undefined = gameFeed?.gamePk ?? gameFeed?.gameData?.game?.pk;
  if (gameId == null) return out;

  const gameDate: string =
    gameFeed?.gameData?.datetime?.officialDate ??
    gameFeed?.gameData?.datetime?.originalDate ??
    new Date().toISOString().slice(0, 10);

  const venueName: string | null = gameFeed?.gameData?.venue?.name ?? null;
  const venueId: number | null = gameFeed?.gameData?.venue?.id ? Number(gameFeed.gameData.venue.id) : null;

  // Team identity for both sides (used to assign opponent_*)
  const homeBox = gameFeed?.liveData?.boxscore?.teams?.home;
  const awayBox = gameFeed?.liveData?.boxscore?.teams?.away;
  const homeName: string | null = homeBox?.team?.name ?? gameFeed?.gameData?.teams?.home?.name ?? null;
  const awayName: string | null = awayBox?.team?.name ?? gameFeed?.gameData?.teams?.away?.name ?? null;
  const homeId: number | null = homeBox?.team?.id ? Number(homeBox.team.id) : (gameFeed?.gameData?.teams?.home?.id ?? null);
  const awayId: number | null = awayBox?.team?.id ? Number(awayBox.team.id) : (gameFeed?.gameData?.teams?.away?.id ?? null);

  for (const sideKey of ['home', 'away'] as const) {
    const sideBox = sideKey === 'home' ? homeBox : awayBox;
    if (!sideBox) continue;

    const teamName: string | null = sideKey === 'home' ? homeName : awayName;
    const teamId: number | null = sideKey === 'home' ? homeId : awayId;
    const opponentName: string | null = sideKey === 'home' ? awayName : homeName;
    const opponentId: number | null = sideKey === 'home' ? awayId : homeId;

    const players = sideBox?.players ?? {};
    for (const playerKey of Object.keys(players)) {
      const p = players[playerKey];
      const pitching = p?.stats?.pitching;
      if (!pitching) continue;
      const gamesStarted = numOrNull(pitching.gamesStarted) ?? 0;
      if (gamesStarted < 1) continue;

      const personId: number | undefined = p?.person?.id;
      if (personId == null) continue;

      // inningsPitched comes as "6.1" (6+1/3) or "6.0" etc. We store the
      // literal numeric — caveat: 0.1 = 1/3 inning in MLB convention, not 0.1.
      // For comparing pitcher form this is fine; for true IP math, convert
      // outs = floor(ip) * 3 + (ip - floor(ip)) * 10 downstream.
      const ipNum = numOrNull(pitching.inningsPitched);

      out.push({
        game_id: Number(gameId),
        game_date: gameDate,
        pitcher_id: Number(personId),
        pitcher_name: p?.person?.fullName ?? null,
        pitcher_hand: normHand(p?.person?.pitchHand?.code),
        team_id: teamId,
        team_name: teamName,
        opponent_id: opponentId,
        opponent_name: opponentName,
        venue_id: venueId,
        venue_name: venueName,
        innings_pitched: ipNum,
        hits_allowed: numOrNull(pitching.hits),
        earned_runs: numOrNull(pitching.earnedRuns),
        home_runs_allowed: Number(numOrNull(pitching.homeRuns) ?? 0),
        walks: numOrNull(pitching.baseOnBalls),
        strikeouts: numOrNull(pitching.strikeOuts),
        pitches: numOrNull(pitching.numberOfPitches ?? pitching.pitchesThrown),
        decision: deriveDecision(pitching),
      });
    }
  }

  return out;
}
