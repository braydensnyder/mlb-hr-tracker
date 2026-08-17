/**
 * extractBattingLines(gameFeed) — pull every batter's per-game line
 * from a /v1.1/game/<pk>/feed/live response, shaped for the canonical
 * `player_batting_lines` table (migration 020).
 *
 * Design mirrors extractPitcherStarts.ts:
 *   - iterate boxscore.teams.{home,away}.players[*] on both sides
 *   - keep only entries with a stats.batting sub-object
 *   - normalise numeric fields with numOrNull() guards
 *   - one row per (game_id, player_id) — the caller upserts on
 *     unique(target_date, game_pk, player_id)
 *
 * Same feed extractPitcherStarts already fetches — zero new API calls.
 *
 * Lineup-slot derivation
 * ----------------------
 * MLB feeds encode batting order as a numeric string like "100"
 * (starter, slot 1), "200" (starter, slot 2), … "900" (slot 9).
 * Pinch-hitters and defensive subs get "101", "201", … "902". So:
 *   batting_order_slot = round(battingOrder / 100) when battingOrder
 *                        is a multiple of 100 (a STARTER)
 *                      = null otherwise (bench appearance / sub)
 *
 * Downstream expected-PA math should only trust non-null slots.
 *
 * Opposing-starter attribution (v1 approximation)
 * -----------------------------------------------
 * We attribute the batter's game-level hits to the OPPOSING starting
 * pitcher's hand. Slightly conflates hits taken off relievers of the
 * other hand — see comment in migration 020 header. For a batter on
 * side X, the opposing starter is the player on side ~X whose
 * stats.pitching.gamesStarted >= 1 (if multiple, we prefer the one
 * with more innings pitched — usually the true starter over an opener).
 *
 * All fields default gracefully to 0 or null; the row is only skipped
 * when person.id or a stats.batting object is missing.
 */
export interface BattingLineRecord {
  game_pk: number;
  target_date: string;
  player_id: number;
  player_name: string;
  team: string;
  opponent: string | null;

  at_bats: number;
  hits: number;
  plate_appearances: number;
  doubles: number;
  triples: number;
  home_runs: number;
  walks: number;
  strikeouts: number;
  hit_by_pitch: number;
  sac_flies: number;

  batting_order_slot: number | null;
  opposing_starter_id: number | null;
  opposing_starter_hand: string | null;    // 'L' | 'R' | null
  batter_side: string | null;              // 'L' | 'R' | 'S' | null
}

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' ? u : null;
}

function normBatSide(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}

function numOrZero(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : null;
}

/**
 * Deriving the slot from `battingOrder`.
 *   "100" → 1  · "200" → 2  · "900" → 9
 *   "101", "201", … (subs)  → null
 */
export function batterSlotFromOrder(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : (raw as number);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  if (n % 100 !== 0) return null; // sub or pinch-hitter
  const slot = Math.round(n / 100);
  return slot >= 1 && slot <= 9 ? slot : null;
}

/** Find the "true" starter on a side. If multiple players carry
 *  `gamesStarted >= 1` (openers + bulk pitcher), pick the one with the
 *  most IP. Returns { id, hand } or null. Exported for testing. */
export function findStarterOnSide(sideBox: any): { id: number; hand: string | null } | null {
  const players = sideBox?.players ?? {};
  let best: { id: number; hand: string | null; ip: number } | null = null;
  for (const key of Object.keys(players)) {
    const p = players[key];
    const pitching = p?.stats?.pitching;
    if (!pitching) continue;
    const gs = numOrZero(pitching.gamesStarted);
    if (gs < 1) continue;
    const id = p?.person?.id;
    if (id == null) continue;
    const ip = numOrZero(pitching.inningsPitched);
    if (!best || ip > best.ip) {
      best = { id: Number(id), hand: normHand(p?.person?.pitchHand?.code), ip };
    }
  }
  return best ? { id: best.id, hand: best.hand } : null;
}

export function extractBattingLines(gameFeed: any): BattingLineRecord[] {
  const out: BattingLineRecord[] = [];
  if (!gameFeed) return out;

  const gamePk: number | undefined = gameFeed?.gamePk ?? gameFeed?.gameData?.game?.pk;
  if (gamePk == null) return out;

  const targetDate: string =
    gameFeed?.gameData?.datetime?.officialDate ??
    gameFeed?.gameData?.datetime?.originalDate ??
    new Date().toISOString().slice(0, 10);

  const homeBox = gameFeed?.liveData?.boxscore?.teams?.home;
  const awayBox = gameFeed?.liveData?.boxscore?.teams?.away;
  const homeName: string | null = homeBox?.team?.name ?? gameFeed?.gameData?.teams?.home?.name ?? null;
  const awayName: string | null = awayBox?.team?.name ?? gameFeed?.gameData?.teams?.away?.name ?? null;

  // Compute opposing-starter attribution ONCE per game — same value
  // applied to every batter on the opposing side.
  const homeStarter = homeBox ? findStarterOnSide(homeBox) : null;
  const awayStarter = awayBox ? findStarterOnSide(awayBox) : null;

  for (const sideKey of ['home', 'away'] as const) {
    const sideBox = sideKey === 'home' ? homeBox : awayBox;
    if (!sideBox) continue;

    const teamName: string | null = sideKey === 'home' ? homeName : awayName;
    const opponentName: string | null = sideKey === 'home' ? awayName : homeName;
    if (!teamName) continue;

    // Batter's opposing starter = the OTHER side's starter.
    const oppStarter = sideKey === 'home' ? awayStarter : homeStarter;

    const players = sideBox?.players ?? {};
    for (const playerKey of Object.keys(players)) {
      const p = players[playerKey];
      const batting = p?.stats?.batting;
      if (!batting) continue;

      // A defensive-replacement pitcher may have a stats.batting object
      // with 0 PA. Keep it — a real zero-PA row is useful information
      // ("player was in the lineup but didn't come to bat"). Drop only
      // when person.id is missing.
      const personId: number | undefined = p?.person?.id;
      if (personId == null) continue;

      // Optional filter: skip pitchers unless they actually batted (AL
      // teams almost never have a batting line for their pitcher). We
      // keep the row if ANY of AB/PA/BB/HBP > 0; this preserves NL /
      // interleague DH-off games where the pitcher hit.
      const ab  = numOrZero(batting.atBats);
      const pa  = numOrZero(batting.plateAppearances);
      const bb  = numOrZero(batting.baseOnBalls);
      const hbp = numOrZero(batting.hitByPitch);
      const isPitcher = !!p?.stats?.pitching;
      if (isPitcher && ab + pa + bb + hbp === 0) continue;

      out.push({
        game_pk: Number(gamePk),
        target_date: targetDate,
        player_id: Number(personId),
        player_name: p?.person?.fullName ?? `#${personId}`,
        team: teamName,
        opponent: opponentName,

        at_bats: ab,
        hits: numOrZero(batting.hits),
        plate_appearances: pa,
        doubles: numOrZero(batting.doubles),
        triples: numOrZero(batting.triples),
        home_runs: numOrZero(batting.homeRuns),
        walks: bb,
        strikeouts: numOrZero(batting.strikeOuts),
        hit_by_pitch: hbp,
        sac_flies: numOrZero(batting.sacFlies),

        batting_order_slot: batterSlotFromOrder(p?.battingOrder),
        opposing_starter_id: oppStarter?.id ?? null,
        opposing_starter_hand: oppStarter?.hand ?? null,
        batter_side: normBatSide(p?.person?.batSide?.code),
      });
    }
  }

  return out;
}
