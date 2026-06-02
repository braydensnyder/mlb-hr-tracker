/**
 * Pure aggregation helpers for the dashboard + HR Targets model.
 *
 * All functions take a flat array of `home_runs` rows and an "anchor date"
 * (the right edge of the window, typically the user-selected end date).
 * They never mutate input. They return small, view-ready objects so the
 * dashboard components stay dumb.
 *
 * `HomeRunRow` lives here (not in supabase.ts) so this module is fully
 * self-contained — node scripts can import it without dragging in the
 * Supabase browser client.
 */

/** One row from the `home_runs` table. Re-exported from supabase.ts. */
export interface HomeRunRow {
  id: number;
  game_pk: number;
  game_date: string;
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  inning: number | null;
  pitcher_id: number | null;
  pitcher_name: string | null;
  exit_velocity: number | null;
  launch_angle: number | null;
  distance: number | null;
  batter_side: string | null;
  pitcher_throws: string | null;
  venue_id: number | null;
  venue_name: string | null;
  created_at: string;
}

// ---------- canonical team resolution ----------

/**
 * A minimal map of player_id → canonical MLB team name.
 *
 * Built from the `players` table (see fetchPlayerIndex in supabase helpers).
 * Used by `applyCanonicalTeams` to remap each HR row's `team` field to the
 * player's *current MLB team* before any aggregation. This guarantees that
 * leaderboards, hot-hitter panels, and player pages never display a non-MLB
 * team string (e.g., "United States" from a WBC row).
 */
export type PlayerTeamIndex = ReadonlyMap<number, { team: string | null; full_name?: string | null }>;

/**
 * Return a NEW HomeRunRow array with each row's `team` (and `player_name`,
 * if available in the index) replaced by the canonical value. Rows whose
 * player_id isn't in the index pass through unchanged so we degrade
 * gracefully when enrich:players hasn't been run yet.
 */
export function applyCanonicalTeams<T extends HomeRunRow>(rows: T[], index: PlayerTeamIndex): T[] {
  if (!index || index.size === 0) return rows;
  return rows.map((r) => {
    const canon = index.get(r.player_id);
    if (!canon || !canon.team) return r;
    if (r.team === canon.team && (!canon.full_name || r.player_name === canon.full_name)) return r;
    return { ...r, team: canon.team, player_name: canon.full_name ?? r.player_name };
  });
}

// ---------- date math (string-only, no Date objects) ----------

export function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

// ---------- per-player aggregation ----------

export interface PlayerAgg {
  player_id: number;
  player_name: string;
  team: string;
  /** Every HR row for this player in the window, newest first. */
  rows: HomeRunRow[];
  /** Distinct game_dates (string), newest first. */
  distinctDates: string[];
  /** Per-date HR counts: Map<game_date, count>. */
  perDate: Map<string, number>;
  totalInWindow: number;
}

export function aggregateByPlayer(rows: HomeRunRow[]): Map<number, PlayerAgg> {
  const out = new Map<number, PlayerAgg>();
  for (const r of rows) {
    let p = out.get(r.player_id);
    if (!p) {
      p = {
        player_id: r.player_id,
        player_name: r.player_name,
        team: r.team,
        rows: [],
        distinctDates: [],
        perDate: new Map(),
        totalInWindow: 0,
      };
      out.set(r.player_id, p);
    }
    p.rows.push(r);
    p.totalInWindow += 1;
    p.perDate.set(r.game_date, (p.perDate.get(r.game_date) ?? 0) + 1);
    // keep most recent display name/team
    p.player_name = r.player_name;
    p.team = r.team;
  }
  for (const p of out.values()) {
    p.rows.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : b.id - a.id));
    p.distinctDates = Array.from(p.perDate.keys()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  }
  return out;
}

// ---------- "hot hitters last N games" ----------

export interface HotHitter {
  player_id: number;
  player_name: string;
  team: string;
  hrs_in_last_n_games: number;
  games_with_hr_in_window: number;
  total_in_window: number;
  most_recent_hr: string;
}

/**
 * For each player, sum HRs across their N most-recent distinct game_dates
 * (only dates ≤ anchor). N typically 3 or 5. Sorted desc by that sum then
 * by total_in_window for tie-breaks.
 */
export function hotHittersLastNGames(
  byPlayer: Map<number, PlayerAgg>,
  anchor: string,
  n: number,
): HotHitter[] {
  const rows: HotHitter[] = [];
  for (const p of byPlayer.values()) {
    const eligibleDates = p.distinctDates.filter((d) => d <= anchor).slice(0, n);
    if (eligibleDates.length === 0) continue;
    let sum = 0;
    for (const d of eligibleDates) sum += p.perDate.get(d) ?? 0;
    rows.push({
      player_id: p.player_id,
      player_name: p.player_name,
      team: p.team,
      hrs_in_last_n_games: sum,
      games_with_hr_in_window: eligibleDates.length,
      total_in_window: p.totalInWindow,
      most_recent_hr: eligibleDates[0],
    });
  }
  rows.sort(
    (a, b) =>
      b.hrs_in_last_n_games - a.hrs_in_last_n_games ||
      b.total_in_window - a.total_in_window ||
      a.player_name.localeCompare(b.player_name),
  );
  return rows;
}

// ---------- "HRs in last X days" ----------

export interface RangeHr {
  player_id: number;
  player_name: string;
  team: string;
  hrs: number;
  total_in_window: number;
}

export function hrsInLastDays(
  byPlayer: Map<number, PlayerAgg>,
  anchor: string,
  days: number,
): RangeHr[] {
  const start = addDays(anchor, -(days - 1));
  const out: RangeHr[] = [];
  for (const p of byPlayer.values()) {
    let n = 0;
    for (const [date, count] of p.perDate) {
      if (date >= start && date <= anchor) n += count;
    }
    if (n > 0) {
      out.push({
        player_id: p.player_id,
        player_name: p.player_name,
        team: p.team,
        hrs: n,
        total_in_window: p.totalInWindow,
      });
    }
  }
  out.sort(
    (a, b) =>
      b.hrs - a.hrs ||
      b.total_in_window - a.total_in_window ||
      a.player_name.localeCompare(b.player_name),
  );
  return out;
}

// ---------- team leaderboards ----------

export interface TeamHr {
  team: string;
  hrs: number;
  unique_hitters: number;
}

export function teamHrLeaderboard(
  rows: HomeRunRow[],
  opts: { since?: string; until?: string } = {},
): TeamHr[] {
  const buckets = new Map<string, { hrs: number; players: Set<number> }>();
  for (const r of rows) {
    if (opts.since && r.game_date < opts.since) continue;
    if (opts.until && r.game_date > opts.until) continue;
    let b = buckets.get(r.team);
    if (!b) {
      b = { hrs: 0, players: new Set() };
      buckets.set(r.team, b);
    }
    b.hrs += 1;
    b.players.add(r.player_id);
  }
  return Array.from(buckets.entries())
    .map(([team, b]) => ({ team, hrs: b.hrs, unique_hitters: b.players.size }))
    .sort((a, b) => b.hrs - a.hrs || a.team.localeCompare(b.team));
}

// ---------- back-to-back games ----------

export interface BackToBack {
  player_id: number;
  player_name: string;
  team: string;
  /** The two consecutive calendar dates (ascending). */
  date_a: string;
  date_b: string;
  /** Total HRs across the two days. */
  hrs_in_streak: number;
  /** Length of the *current* streak ending at the most recent HR date. */
  current_streak_len: number;
}

/**
 * Players whose two most recent HR dates within the window are consecutive
 * calendar days (delta == 1). We approximate "back-to-back games" as
 * back-to-back calendar days, which is correct for the vast majority of the
 * MLB schedule (off days are common but a "back-to-back HR" is colloquially
 * back-to-back days). Sorted by current_streak_len desc, then by HRs in those
 * two days desc.
 */
export function backToBackHr(
  byPlayer: Map<number, PlayerAgg>,
  anchor: string,
): BackToBack[] {
  const out: BackToBack[] = [];
  for (const p of byPlayer.values()) {
    const eligible = p.distinctDates.filter((d) => d <= anchor);
    if (eligible.length < 2) continue;
    const newest = eligible[0];
    const prev = eligible[1];
    if (daysBetween(prev, newest) !== 1) continue;

    // measure current streak length
    let streak = 1;
    for (let i = 0; i < eligible.length - 1; i++) {
      if (daysBetween(eligible[i + 1], eligible[i]) === 1) streak++;
      else break;
    }

    out.push({
      player_id: p.player_id,
      player_name: p.player_name,
      team: p.team,
      date_a: prev,
      date_b: newest,
      hrs_in_streak: (p.perDate.get(prev) ?? 0) + (p.perDate.get(newest) ?? 0),
      current_streak_len: streak,
    });
  }
  out.sort(
    (a, b) =>
      b.current_streak_len - a.current_streak_len ||
      b.hrs_in_streak - a.hrs_in_streak ||
      (b.date_b < a.date_b ? -1 : 1),
  );
  return out;
}

// ---------- 2+ HR in last 5 games ----------

export interface MultiHrGame {
  player_id: number;
  player_name: string;
  team: string;
  multi_hr_games: { date: string; hrs: number }[];
  /** Sum of HRs across those multi-HR games (in the last 5 game window). */
  total_multi_hrs: number;
}

export function multiHrInLastNGames(
  byPlayer: Map<number, PlayerAgg>,
  anchor: string,
  windowGames: number,
  threshold = 2,
): MultiHrGame[] {
  const out: MultiHrGame[] = [];
  for (const p of byPlayer.values()) {
    const lastN = p.distinctDates.filter((d) => d <= anchor).slice(0, windowGames);
    const multi = lastN
      .map((d) => ({ date: d, hrs: p.perDate.get(d) ?? 0 }))
      .filter((g) => g.hrs >= threshold);
    if (multi.length === 0) continue;
    out.push({
      player_id: p.player_id,
      player_name: p.player_name,
      team: p.team,
      multi_hr_games: multi,
      total_multi_hrs: multi.reduce((s, g) => s + g.hrs, 0),
    });
  }
  out.sort(
    (a, b) =>
      b.multi_hr_games.length - a.multi_hr_games.length ||
      b.total_multi_hrs - a.total_multi_hrs ||
      a.player_name.localeCompare(b.player_name),
  );
  return out;
}

// ---------- season leaderboard (just total HRs in window per player) ----------

export interface SeasonLeader {
  player_id: number;
  player_name: string;
  team: string;
  hrs: number;
  last_hr: string;
}

export function seasonLeaders(byPlayer: Map<number, PlayerAgg>): SeasonLeader[] {
  return Array.from(byPlayer.values())
    .filter((p) => p.totalInWindow > 0)
    .map((p) => ({
      player_id: p.player_id,
      player_name: p.player_name,
      team: p.team,
      hrs: p.totalInWindow,
      last_hr: p.distinctDates[0],
    }))
    .sort(
      (a, b) =>
        b.hrs - a.hrs ||
        (b.last_hr < a.last_hr ? -1 : 1) ||
        a.player_name.localeCompare(b.player_name),
    );
}

// ---------- single-player "as of" view ----------

/**
 * Compute every stat the PlayerDetail page needs from one player's raw HR
 * rows, anchored at `anchor`. This is intentionally the same math the
 * Dashboard uses, just packaged for one player — so the player page and
 * the dashboard cells can NEVER disagree.
 *
 * `home_runs` is the single source of truth. Do not derive any of these
 * from `player_daily_summary` on the frontend.
 */
export interface PlayerView {
  /** All rows passed in, newest first. */
  rows: HomeRunRow[];
  /** Anchor date used (YYYY-MM-DD). */
  anchor: string;

  player_id: number | null;
  player_name: string;
  team: string;

  hrs_today: number;
  season_total: number;
  hrs_last_3_games: number;
  hrs_last_5_games: number;
  hrs_last_7_days: number;
  hrs_last_14_days: number;
  last_hr_date: string | null;

  /** Most recent distinct game_dates ≤ anchor (newest first), with per-date HR counts. */
  recent_games: { date: string; hrs: number }[];
}

export function computePlayerView(rows: HomeRunRow[], anchor: string): PlayerView {
  // Defensive sort — never trust caller order.
  const sorted = [...rows].sort((a, b) =>
    a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : b.id - a.id,
  );

  // Only consider rows up to and including the anchor date. Anything later
  // (e.g. a future-dated row that snuck in) must NOT influence the view.
  const inScope = sorted.filter((r) => r.game_date <= anchor);

  const yearStart = `${anchor.slice(0, 4)}-01-01`;

  // per-date counts (only ≤ anchor)
  const perDate = new Map<string, number>();
  for (const r of inScope) perDate.set(r.game_date, (perDate.get(r.game_date) ?? 0) + 1);

  const distinctDates = Array.from(perDate.keys()).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );

  // last 3 / last 5 distinct game dates
  const last3Dates = new Set(distinctDates.slice(0, 3));
  const last5Dates = new Set(distinctDates.slice(0, 5));

  const sevenStart = addDays(anchor, -6);
  const fourteenStart = addDays(anchor, -13);

  let hrs_today = 0;
  let season_total = 0;
  let hrs_last_3_games = 0;
  let hrs_last_5_games = 0;
  let hrs_last_7_days = 0;
  let hrs_last_14_days = 0;

  for (const r of inScope) {
    const d = r.game_date;
    if (d === anchor) hrs_today++;
    if (d >= yearStart) season_total++;
    if (last3Dates.has(d)) hrs_last_3_games++;
    if (last5Dates.has(d)) hrs_last_5_games++;
    if (d >= sevenStart) hrs_last_7_days++;
    if (d >= fourteenStart) hrs_last_14_days++;
  }

  // Pick display name/team from the most recent in-scope row, falling back to
  // whatever the caller passed in (in case all rows are out of scope).
  const newest = inScope[0] ?? sorted[0] ?? null;

  return {
    rows: sorted,
    anchor,
    player_id: newest?.player_id ?? null,
    player_name: newest?.player_name ?? `Player`,
    team: newest?.team ?? '—',
    hrs_today,
    season_total,
    hrs_last_3_games,
    hrs_last_5_games,
    hrs_last_7_days,
    hrs_last_14_days,
    last_hr_date: distinctDates[0] ?? null,
    recent_games: distinctDates.map((d) => ({ date: d, hrs: perDate.get(d) ?? 0 })),
  };
}

// ---------- pitcher HR-allowed leaderboard ----------

export interface PitcherAllowed {
  pitcher_id: number;
  pitcher_name: string;
  /** Pitcher's team is approximated as "the opponent of the batter" — i.e., the
   *  defending team in each HR row. We pick the most common opponent across
   *  this pitcher's HR-allowed rows; for the rare cross-trade pitcher this may
   *  shift mid-season but it's right for "current team" most of the time. */
  team: string;
  pitcher_throws: string | null; // 'L' | 'R' | null when unknown
  season_allowed: number;
  /** HRs allowed in pitcher's most recent 3 HR-allowed game-dates ≤ anchor. */
  allowed_last_3_starts: number;
  /** Same for 5 dates. */
  allowed_last_5_starts: number;
  /** HRs allowed in [anchor-13, anchor]. */
  allowed_last_14_days: number;
  most_recent_allowed: string;
}

export function pitcherHrLeaderboard(rows: HomeRunRow[], anchor: string): PitcherAllowed[] {
  const fourteenStart = addDays(anchor, -13);
  const buckets = new Map<
    number,
    {
      name: string;
      hand: string | null;
      teamCounts: Map<string, number>;
      perDate: Map<string, number>;
      total: number;
      l14: number;
    }
  >();

  for (const r of rows) {
    if (r.pitcher_id == null) continue;
    if (r.game_date > anchor) continue;
    let b = buckets.get(r.pitcher_id);
    if (!b) {
      b = { name: r.pitcher_name ?? `#${r.pitcher_id}`, hand: r.pitcher_throws ?? null, teamCounts: new Map(), perDate: new Map(), total: 0, l14: 0 };
      buckets.set(r.pitcher_id, b);
    }
    // keep the most recently observed name & hand (handles renames / late enrichment)
    b.name = r.pitcher_name ?? b.name;
    if (r.pitcher_throws) b.hand = r.pitcher_throws;
    // pitcher's team = batter's opponent
    b.teamCounts.set(r.opponent, (b.teamCounts.get(r.opponent) ?? 0) + 1);
    b.perDate.set(r.game_date, (b.perDate.get(r.game_date) ?? 0) + 1);
    b.total += 1;
    if (r.game_date >= fourteenStart) b.l14 += 1;
  }

  const out: PitcherAllowed[] = [];
  for (const [pitcher_id, b] of buckets) {
    const distinctDates = Array.from(b.perDate.keys()).sort((a, b2) => (a < b2 ? 1 : a > b2 ? -1 : 0));
    const last3 = distinctDates.slice(0, 3);
    const last5 = distinctDates.slice(0, 5);
    const sum = (dates: string[]) => dates.reduce((s, d) => s + (b.perDate.get(d) ?? 0), 0);

    // pick the team the pitcher most often defended against
    let team = '—';
    let max = -1;
    for (const [t, c] of b.teamCounts) if (c > max) { team = t; max = c; }

    out.push({
      pitcher_id,
      pitcher_name: b.name,
      team,
      pitcher_throws: b.hand,
      season_allowed: b.total,
      allowed_last_3_starts: sum(last3),
      allowed_last_5_starts: sum(last5),
      allowed_last_14_days: b.l14,
      most_recent_allowed: distinctDates[0] ?? '',
    });
  }
  out.sort(
    (a, b2) =>
      b2.season_allowed - a.season_allowed ||
      b2.allowed_last_14_days - a.allowed_last_14_days ||
      a.pitcher_name.localeCompare(b2.pitcher_name),
  );
  return out;
}

// ---------- handedness splits ----------

export interface HandednessSplit {
  /** Total HRs across rows where pitcher_throws is known. */
  total_known: number;
  /** Rows with no pitcher_throws data — useful for "X% of HRs lack handedness data" UI hints. */
  total_unknown: number;
  vs_lhp: number;
  vs_rhp: number;
}

export function leagueHandednessSplit(rows: HomeRunRow[], anchor: string): HandednessSplit {
  const out: HandednessSplit = { total_known: 0, total_unknown: 0, vs_lhp: 0, vs_rhp: 0 };
  for (const r of rows) {
    if (r.game_date > anchor) continue;
    if (r.pitcher_throws === 'L') { out.vs_lhp++; out.total_known++; }
    else if (r.pitcher_throws === 'R') { out.vs_rhp++; out.total_known++; }
    else out.total_unknown++;
  }
  return out;
}

export interface PlayerHandednessSplit {
  player_id: number;
  player_name: string;
  team: string;
  /** Per-AB batter side that we observed in HR rows (rare to vary outside of switch hitters). */
  bat_side: string | null;
  vs_lhp: number;
  vs_rhp: number;
  unknown: number;
  vs_lhp_l30d: number;
  vs_rhp_l30d: number;
  total: number;
}

/** Per-player handedness split anchored at the as-of date. */
export function playerHandednessSplits(rows: HomeRunRow[], anchor: string): PlayerHandednessSplit[] {
  const thirtyStart = addDays(anchor, -29);
  const buckets = new Map<number, PlayerHandednessSplit>();
  for (const r of rows) {
    if (r.game_date > anchor) continue;
    let b = buckets.get(r.player_id);
    if (!b) {
      b = {
        player_id: r.player_id,
        player_name: r.player_name,
        team: r.team,
        bat_side: r.batter_side ?? null,
        vs_lhp: 0,
        vs_rhp: 0,
        unknown: 0,
        vs_lhp_l30d: 0,
        vs_rhp_l30d: 0,
        total: 0,
      };
      buckets.set(r.player_id, b);
    }
    b.player_name = r.player_name;
    b.team = r.team;
    if (r.batter_side) b.bat_side = r.batter_side;
    b.total++;
    const inL30 = r.game_date >= thirtyStart;
    if (r.pitcher_throws === 'L') { b.vs_lhp++; if (inL30) b.vs_lhp_l30d++; }
    else if (r.pitcher_throws === 'R') { b.vs_rhp++; if (inL30) b.vs_rhp_l30d++; }
    else b.unknown++;
  }
  return Array.from(buckets.values()).sort((a, b) => b.total - a.total || a.player_name.localeCompare(b.player_name));
}

/** Compute the handedness split for a single player's rows, anchored at asOf. */
export function singlePlayerHandedness(rows: HomeRunRow[], anchor: string): PlayerHandednessSplit | null {
  const split = playerHandednessSplits(rows, anchor);
  return split[0] ?? null;
}

// ---------- venue (ballpark) leaderboard ----------

export interface VenueStats {
  venue_name: string;
  season: number;
  l7d: number;
  l14d: number;
  /** Distinct teams seen homering at this venue — proxy for "teams playing here". */
  teams_seen: string[];
}

export function venueLeaderboard(rows: HomeRunRow[], anchor: string): VenueStats[] {
  const sevenStart = addDays(anchor, -6);
  const fourteenStart = addDays(anchor, -13);
  const buckets = new Map<string, { season: number; l7: number; l14: number; teams: Set<string> }>();
  for (const r of rows) {
    if (!r.venue_name) continue;
    if (r.game_date > anchor) continue;
    let b = buckets.get(r.venue_name);
    if (!b) {
      b = { season: 0, l7: 0, l14: 0, teams: new Set() };
      buckets.set(r.venue_name, b);
    }
    b.season++;
    if (r.game_date >= sevenStart) b.l7++;
    if (r.game_date >= fourteenStart) b.l14++;
    b.teams.add(r.team);
    b.teams.add(r.opponent);
  }
  return Array.from(buckets.entries())
    .map(([venue_name, b]) => ({
      venue_name,
      season: b.season,
      l7d: b.l7,
      l14d: b.l14,
      teams_seen: Array.from(b.teams).sort(),
    }))
    // Rank by L14 friendliness then season volume — user's "HR friendliness based on stored data"
    .sort((a, b) => b.l14d - a.l14d || b.season - a.season || a.venue_name.localeCompare(b.venue_name));
}

// ---------- HR Targets (heat score) ----------

/**
 * "HR Heat Score" — a research-only ranking of which hitters are most
 * likely to homer in a specific game. NOT a guaranteed pick.
 *
 * Each component is normalized to 0..1 by dividing its raw value by a
 * saturation cap, then multiplied by its weight. The final heat score is
 * the weighted sum (max = 100 since weights total 100). This shape
 * de-emphasizes single-game L3 streaks vs the previous uncapped formula
 * and makes the contribution of each signal easy to read off.
 *
 * `weather` is a 0-weight placeholder so the formula already accepts the
 * field when weather data is wired in.
 *
 * Components and weights (tunable in HEAT_SCORE_WEIGHTS):
 *   l3       35  — HRs in last 3 distinct HR-game-dates (sat at 3)
 *   l5       20  — HRs in last 5 distinct HR-game-dates (sat at 4)
 *   l7d      15  — HRs in last 7 calendar days          (sat at 5)
 *   season   10  — season HRs                            (sat at 30)
 *   pitcher  10  — opposing pitcher L14d HRs allowed     (sat at 6)
 *   park      5  — venue L14d HRs                        (sat at 12)
 *   hand      5  — share of HRs vs probable's throwing hand
 *   weather   0  — placeholder
 *
 * Every component degrades gracefully:
 *   - missing pitcher → hand + pitcher contributions = 0
 *   - missing venue   → park contribution = 0
 *   - new player      → l3/l5/l7d/season still meaningful
 */

/**
 * Heat score weights (sum to 100).
 *
 * Season Power is the **structural base** — 40% of the model. Recent form
 * is a 25% booster, not a driver. Matchup signals fill the rest. The
 * shape was retuned because the previous 38/30 split let short-term hot
 * streaks outweigh true power.
 *
 *   Season Power     = 40   (season HR; floored for elites — see Power Floor)
 *   Recent Form      = 25   (l3 14 + l5 8 + l7d 3 — dampened by stability)
 *   Pitcher Matchup  = 15
 *   Handedness       = 10
 *   Venue            = 10
 *   Weather          =  0   (placeholder)
 *
 * Plus two hard guard rails (see below):
 *   - Auto-elite at season_hr ≥ 12: Power Floor + full stability automatically.
 *   - Low-power cap: non-elite, sub-5-HR players capped at LOW_POWER_CAP
 *     unless they've hit 2+ HR in last 3 games.
 */
export const HEAT_SCORE_WEIGHTS = {
  // Rebalanced 2026 (task #155): 35/25/20/10/10 — drop season slightly
  // (was 40), raise pitcher (was 15) so matchup matters more, keep park
  // + hand at 10. Recent form unchanged at 25 (l3+l5+l7d).
  season: 35,   // was 40
  l3: 14,       // unchanged
  l5: 8,        // unchanged
  l7d: 3,       // unchanged
  pitcher: 20,  // was 15
  park: 10,     // unchanged
  hand: 10,     // unchanged
  weather: 0,   // placeholder
} as const;

export const HEAT_SCORE_SATURATION = {
  // Tightened (task #155) so individual components are harder to max
  // out and thus typical scores land in the user's target 55-70 range.
  l3: 3,
  l5: 4,
  l7d: 5,
  season: 35,        // was 30 — Schwarber/Judge territory
  pitcher_l14d: 8,   // was 6 — need 8 HR allowed in 14d to fully max
  park_l14d: 15,     // was 12 — tougher park cap
  hand: 5,
} as const;

/**
 * Ceiling compression — applied AFTER all per-component contributions
 * and penalties so even a perfectly-aligned slugger can't trivially hit
 * 100. Above `soft_cap`, every point gets multiplied by `compression`,
 * yielding diminishing returns:
 *   raw 70  → 70
 *   raw 80  → 70 + (80-70)*0.4 = 74
 *   raw 90  → 70 + (90-70)*0.4 = 78
 *   raw 100 → 70 + (100-70)*0.4 = 82
 *
 * Means 85+ requires every major factor extremely strong AND a high
 * completeness multiplier — exactly what the user asked for.
 */
export const HEAT_SCORE_CEILING = {
  soft_cap: 70,
  compression: 0.4,
} as const;

/**
 * Completeness multiplier — counts how many of the 5 independent
 * factors (season power, recent form composite, pitcher, hand, park)
 * are firing meaningfully (≥ `factor_threshold` of their saturation),
 * then scales the heat by `base + per_factor * count`.
 *
 *   0 factors firing → 0.75x (heavy haircut — one-factor wonder)
 *   1 factors firing → 0.80x
 *   2 factors firing → 0.85x
 *   3 factors firing → 0.90x
 *   4 factors firing → 0.95x
 *   5 factors firing → 1.00x (full credit — true alignment)
 *
 * Elite power hitters get +1 to factorsFiring (handled inline) so a
 * slugger with only season power still scores in the "respectable"
 * band — the user explicitly asked that names like Judge / Ohtani not
 * get buried by one-factor outlier rows.
 */
export const HEAT_SCORE_COMPLETENESS = {
  factor_threshold: 0.5,
  base: 0.75,
  per_factor: 0.05,
  /** Bonus +N to factorsFiring count for ELITE_POWER profile. */
  elite_bonus: 1,
} as const;

/**
 * STABILITY factor — dampens recent-form contributions when a player
 * doesn't have a meaningful season HR baseline.
 *
 *   stability = clamp(effective_season_hr / RAMP, FLOOR, 1.0)
 *
 * `effective_season_hr` lifts known-elite power hitters to a minimum so a
 * slow-start Aaron Judge (5 actual HRs in April) isn't penalized like a
 * fringe hitter (also 5 HRs, no track record).
 */
export const HEAT_SCORE_STABILITY = {
  /** Full stability credit at this many season HR. */
  ramp: 12,         // was 10 — tighter ramp so sub-12 hitters are clearly dampened
  /** Minimum stability factor regardless of season HR. */
  floor: 0.35,      // was 0.4
  /** Elite power hitters get treated as having at least this many season HR
   *  for stability + season-power floor purposes. */
  elite_min_season_hr: 15,
  /** Any player with ≥ this many season HR is automatically treated as elite
   *  (Power Floor + full stability), even when not in the curated list. */
  auto_elite_hr: 12,
} as const;

/**
 * Low-power cap. A non-elite hitter with very few season HRs can't earn a
 * top-10 ranking purely on a tiny recent uptick. They have to show an
 * extreme calendar-recent streak (≥ L7D_EXEMPTION HR in the calendar last
 * 7 days) to break the cap.
 *
 * Why hrs_l7d and not hrs_l3? `hrs_l3` is "HRs in the player's most recent
 * 3 distinct HR-dates" — for a fringe hitter who last homered weeks ago,
 * that metric can read as 2 even though they have no calendar-recent form.
 * Using hrs_l7d enforces the user's intent: real, current heat.
 *
 *   if (!isElitePower  AND  season_hr < SEASON_HR_MAX  AND  hrs_l7d < L7D_EXEMPTION)
 *   then  heat = min(heat, CAP)
 */
export const HEAT_SCORE_LOW_POWER_CAP = {
  /** Cap applies when season_hr is BELOW this value. */
  season_hr_max: 5,
  /** Calendar-7d HRs at or above this exempt the player from the cap. */
  l7d_exemption: 2,
  /** Maximum heat score for capped players.
   *  TUNING 2026-05-18: raised 30 → 34 (softer). Miss Pattern Analysis
   *  showed "Low season power" in ~54% of misses, so the cap was slightly
   *  too aggressive — low-power hitters with a real matchup edge were
   *  getting buried below the Top 50. A 4-point lift lets them surface a
   *  bit higher without a model rewrite. Revert to 30 if Top-10 stability
   *  degrades. */
  cap: 34,
} as const;

/** Cold-streak penalties — tunable so before/after softening is auditable.
 *  TUNING 2026-05-18: softened elite -10 → -8 and mid -5 → -4 after Miss
 *  Pattern Analysis flagged "Cold batter" in ~58% of misses. Penalties are
 *  kept (not removed) — just less punishing. Revert to {-10,-5} if cold
 *  power hitters start crowding the Top 10 with empty results. */
export const HEAT_SCORE_COLD_PENALTY = {
  /** Applied when a quiet hitter has season_hr ≥ auto_elite_hr. */
  elite: -8,
  /** Applied when a quiet hitter has season_hr ≥ 8 (but below elite). */
  mid: -4,
} as const;

/** Uncertainty penalty applied to a player whose lineup hasn't posted yet
 *  ("pending"). Light + uniform so it doesn't distort morning rankings —
 *  it only matters once SOME games confirm and others haven't. */
export const HEAT_SCORE_LINEUP_PENDING_PENALTY = -5;

export function stabilityFactor(season_hr: number, isElitePower = false): number {
  const effective = isElitePower
    ? Math.max(season_hr, HEAT_SCORE_STABILITY.elite_min_season_hr)
    : season_hr;
  return clamp(effective / HEAT_SCORE_STABILITY.ramp, HEAT_SCORE_STABILITY.floor, 1.0);
}

/**
 * ELITE_POWER_NAMES — curated set of names whose canonical players row
 * (full_name) should be treated as elite-power for the Heat Score model.
 *
 * Matching is case-insensitive on `players.full_name`. This list is the
 * default; pass `elitePowerIds` to computeHrTargets to override or extend.
 *
 * The MARKET-SANITY future hook is: once we ingest sportsbook HR odds,
 * the Power Floor will defer to odds for any player whose implied
 * probability is above a threshold; the curated list will remain as the
 * "odds-missing" fallback so elite sluggers never disappear.
 */
export const ELITE_POWER_NAMES: ReadonlySet<string> = new Set([
  'aaron judge',
  'shohei ohtani',
  'kyle schwarber',
  'pete alonso',
  'matt olson',
  'corey seager',
  'juan soto',
  'yordan alvarez',
  'mookie betts',
  'bryce harper',
  'vladimir guerrero jr.',
  'jose ramirez',
  'rafael devers',
  'fernando tatis jr.',
  'manny machado',
  'eugenio suarez',
  'austin riley',
  'marcell ozuna',
  'adolis garcia',
  'gunnar henderson',
  'ronald acuna jr.',
  'salvador perez',
  'cal raleigh',
  'william contreras',
  'mike trout',
  'paul goldschmidt',
  'freddie freeman',
  'rhys hoskins',
  'francisco lindor',
  'teoscar hernandez',
]);

/**
 * Future hook for sportsbook HR-prop odds. Not wired to any fetcher yet —
 * declared so the UI / model can be incrementally extended. When odds
 * are present, they override the curated Power Floor.
 */
export interface DailyHrOdds {
  player_id: number;
  game_date: string;
  bookmaker?: string;
  american_odds?: number;        // e.g. +350
  implied_probability?: number;  // 0..1
}

export interface HrTargetGame {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  venue_name: string | null;
  home_probable_pitcher_id: number | null;
  home_probable_pitcher_name: string | null;
  home_probable_pitcher_hand: string | null;
  away_probable_pitcher_id: number | null;
  away_probable_pitcher_name: string | null;
  away_probable_pitcher_hand: string | null;
  // Weather context (null until enrich:weather populates it).
  weather_condition?: string | null;
  weather_temp_f?: number | null;
  weather_wind_mph?: number | null;
  weather_wind_dir?: string | null;
  /** ISO timestamp of the most recent successful enrichWeather write.
   *  Surfaced in the UI as "Updated 6:14 PM" + the temporary debug line. */
  weather_updated_at?: string | null;

  // Lineups (null until enrich:lineups populates them). Drives the
  // confirmed-starter / not-starting / pending classification.
  home_lineup?: number[] | null;
  away_lineup?: number[] | null;
  lineups_confirmed?: boolean | null;
  /** Game status string ("Scheduled", "Postponed", "In Progress", ...). */
  game_status?: string | null;
}

/** Per-player availability classification derived from lineup data. */
export type LineupStatus = 'confirmed' | 'pending' | 'not_starting' | 'postponed';

/** Statuses that mean "no game will be played" — players from these games
 *  are hidden from HR Targets. Mirrors scripts/extractLineups.ts (kept
 *  inline so stats.ts has no cross-import into scripts/). */
const DEAD_GAME_RX = /postponed|cancel|suspended|delayed: rain/i;
export function isDeadGameStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return DEAD_GAME_RX.test(status);
}

/**
 * Light weather adjustment for the Heat Score. The user explicitly
 * asked to keep this gentle — it nudges, it never dominates. Bounded
 * to roughly [-3, +5].
 *
 *   warm temp     → small boost   (≥85°F +2, ≥75°F +1, ≤45°F -1)
 *   wind blowing OUT → small boost   (+1, +2 if ≥10 mph, +3 if ≥15 mph)
 *   wind blowing IN  → small penalty (-1, -2 if ≥10 mph, -3 if ≥15 mph)
 *   crosswind / calm → neutral
 *   dome / roof closed → neutral (indoors — weather is a non-factor)
 *   missing weather    → neutral
 *
 * `included` tells the UI whether weather actually moved the score, so
 * the expanded row can say "weather: neutral / not included" honestly.
 */
export interface WeatherAdjustment {
  delta: number;        // points added to heat (can be negative). Sum of temp_boost + wind_boost, clamped.
  included: boolean;    // false when dome / missing → score untouched
  label: string;        // human-readable summary for the adjustments list

  // ---- BROKEN-OUT COMPONENTS (UI transparency, audit task #166) ----
  /** Points contributed by the temperature reading alone (signed). */
  temp_boost: number;
  /** Points contributed by the wind reading alone (signed). 0 for crosswind. */
  wind_boost: number;
  /** True when the game is in a dome / closed roof. Distinct from
   *  "no data" so the UI can label it neutral instead of pending. */
  is_dome: boolean;
  /** Short human-readable temp note ("85°F warm", "Cold (45°F)", "—"). */
  temp_label: string;
  /** Short human-readable wind note ("Wind 12mph out", "Calm", "Crosswind"). */
  wind_label: string;
}

/**
 * Format weather for display, e.g.:
 *   "82°F • Wind 12 mph out to LF"
 *   "72°F • Wind 8 mph in from CF"
 *   "Roof Closed"          (dome — wind omitted)
 *   "68°F • Calm"
 * Returns null when there's nothing meaningful to show.
 */
export function formatWeatherLine(opts: {
  condition?: string | null;
  temp_f?: number | null;
  wind_mph?: number | null;
  wind_dir?: string | null;
}): string | null {
  const condition = opts.condition ?? null;
  const temp = opts.temp_f ?? null;
  const windMph = opts.wind_mph ?? null;
  const windDir = opts.wind_dir ?? null;

  const isDome = condition != null && /roof closed|dome|indoor/i.test(condition);
  if (isDome) {
    // Indoors — temp may still be reported, but wind is moot.
    return temp != null ? `${condition} • ${temp}°F` : condition;
  }

  const parts: string[] = [];
  if (temp != null) parts.push(`${temp}°F`);

  if (windMph != null && windDir) {
    if (/^calm$/i.test(windDir) || windMph === 0) {
      parts.push('Calm');
    } else {
      // Lower-case the direction phrase for the "out to LF" reading.
      parts.push(`Wind ${windMph} mph ${windDir.toLowerCase()}`);
    }
  } else if (windMph != null) {
    parts.push(`Wind ${windMph} mph`);
  }

  if (parts.length === 0) return condition; // last resort
  return parts.join(' • ');
}

export function computeWeatherAdjustment(opts: {
  condition?: string | null;
  temp_f?: number | null;
  wind_mph?: number | null;
  wind_dir?: string | null;
}): WeatherAdjustment {
  const condition = opts.condition ?? null;
  const temp = opts.temp_f ?? null;
  const windMph = opts.wind_mph ?? null;
  const windDir = (opts.wind_dir ?? '').toLowerCase();

  // Dome / roof closed → weather is not a factor. Neutral, not included.
  const isDome = condition != null && /roof closed|dome|indoor/i.test(condition);
  if (isDome) {
    return {
      delta: 0,
      included: false,
      label: 'Weather neutral — dome / roof closed',
      temp_boost: 0,
      wind_boost: 0,
      is_dome: true,
      temp_label: temp != null ? `${temp}°F (dome, neutral)` : 'Dome — neutral',
      wind_label: 'Dome — neutral',
    };
  }

  // No usable data at all → neutral, not included.
  if (temp == null && windMph == null) {
    return {
      delta: 0,
      included: false,
      label: 'Weather neutral — no data',
      temp_boost: 0,
      wind_boost: 0,
      is_dome: false,
      temp_label: 'No data',
      wind_label: 'No data',
    };
  }

  // ---- TEMPERATURE component ----
  let tempBoost = 0;
  let tempLabel = '—';
  if (temp != null) {
    if (temp >= 85) { tempBoost = 2; tempLabel = `${temp}°F warm`; }
    else if (temp >= 75) { tempBoost = 1; tempLabel = `${temp}°F mild`; }
    else if (temp <= 45) { tempBoost = -1; tempLabel = `${temp}°F cold`; }
    else { tempBoost = 0; tempLabel = `${temp}°F neutral`; }
  }

  // ---- WIND component (only OUT / IN matter; crosswind is neutral) ----
  let windBoost = 0;
  let windLabel = '—';
  if (windMph != null && windMph > 0 && windDir) {
    const windOut = windDir.includes('out');
    const windIn = windDir.includes('in from') || /\bin\b/.test(windDir);
    const mag = windMph >= 15 ? 3 : windMph >= 10 ? 2 : 1;
    if (windOut) { windBoost = mag; windLabel = `Wind ${windMph}mph out`; }
    else if (windIn) { windBoost = -mag; windLabel = `Wind ${windMph}mph in`; }
    else { windBoost = 0; windLabel = `Wind ${windMph}mph crosswind`; }
  } else if (windMph === 0 || /^calm/.test(windDir)) {
    windLabel = 'Calm';
  } else if (windMph != null) {
    windLabel = `Wind ${windMph}mph`;
  }

  // Clamp the combined delta so weather can never swing a ranking on its own.
  const rawDelta = tempBoost + windBoost;
  const delta = clamp(rawDelta, -3, 5);

  // Compose human-readable summary.
  const parts: string[] = [];
  if (temp != null && tempBoost !== 0) parts.push(`${tempLabel} (${tempBoost > 0 ? '+' : ''}${tempBoost})`);
  else if (temp != null) parts.push(tempLabel);
  if (windBoost !== 0) parts.push(`${windLabel} (${windBoost > 0 ? '+' : ''}${windBoost})`);
  else if (windLabel !== '—' && windLabel !== 'No data') parts.push(windLabel);

  return {
    delta,
    included: delta !== 0,
    label: delta === 0
      ? `Weather neutral — ${parts.join(', ') || 'no swing'}`
      : `Weather ${delta > 0 ? '+' : ''}${delta} — ${parts.join(', ')}`,
    temp_boost: tempBoost,
    wind_boost: windBoost,
    is_dome: false,
    temp_label: tempLabel,
    wind_label: windLabel,
  };
}

/**
 * Grouped score breakdown shown in the expandable matchup detail. These
 * are sums of the per-component contributions, grouped by the priority
 * categories the user reasons about (form / power / matchup / venue).
 */
export interface HrTargetBreakdown {
  season_power_score: number;    // season contribution
  recent_form_score: number;     // L3 + L5 + L7d contributions (post-stability)
  pitcher_score: number;         // pitcher contribution only
  handedness_score: number;      // handedness vs probable
  venue_score: number;           // park contribution
  weather_score: number;         // legacy weight-0 component contribution (always 0)
  /** Light weather adjustment applied to the final heat score (≈ -3..+5).
   *  0 when weather is missing or the game is in a dome. See
   *  computeWeatherAdjustment(). The `weather_included` flag on HrTarget
   *  says whether this actually moved the score. */
  weather_adjustment: number;
  /** Temperature component of weather_adjustment (signed). +2 for ≥85°F,
   *  +1 for ≥75°F, -1 for ≤45°F, 0 otherwise. Surfaced separately so the
   *  expanded row can show why the boost landed. */
  weather_temp_boost: number;
  /** Wind component of weather_adjustment (signed). +1/+2/+3 for "out" at
   *  <10/10-14/≥15 mph; mirror for "in". 0 for crosswind / calm / dome. */
  weather_wind_boost: number;
  /** Short human-readable temp note for the expanded UI ("85°F warm"). */
  weather_temp_label: string;
  /** Short human-readable wind note for the expanded UI ("Wind 12mph out"). */
  weather_wind_label: string;
  /** True when condition matches dome / roof closed / indoor. Distinct
   *  from "no data" so the UI labels neutral correctly. */
  weather_is_dome: boolean;
  /** Combined negative-weighting adjustment applied to this target.
   *  Sum of all penalties (≤ 0). Examples:
   *    - Cold-streak (elite slugger gone quiet for L5+L7d) → -10
   *    - Cold-streak (moderate power gone quiet) → -5
   *    - Facing dominant pitcher (K/9 ≥ 11 with 0-1 HR allowed L5 starts) → -8
   *    - Facing high-K pitcher (K/9 ≥ 11) with no HR boost → -4
   *  Adjustments list below contains the human-readable breakdown. */
  cold_penalty: number;
  /** Multiplier (0.35..1.0) applied to recent-form contributions when
   *  season HR baseline is low. Lower = stronger dampening. */
  stability_factor: number;
  /** How many of the 5 independent factors are firing strongly. Drives
   *  the completeness multiplier and contributes to the confidence label. */
  factors_firing: number;
  /** Multiplier applied for factor agreement (0.75..1.0). The user-
   *  facing "this score is broad-based vs single-factor" knob. */
  completeness_multiplier: number;
  /** Amount subtracted by the ceiling-compression step. 0 when raw ≤ 70.
   *  Positive value here = how many points were shaved off the top. */
  ceiling_compression: number;
  /** Heat score BEFORE Power Floor, Low-power cap, or cold/pitcher penalties. */
  raw_score: number;
  /** Human-readable list of adjustments applied between raw_score and final_heat_score.
   *  Positive delta = boost (Power Floor); negative delta = cap or penalty. */
  adjustments: { label: string; delta: number }[];
  final_heat_score: number;      // mirror of HrTarget.heat_score (post-adjustments)
}

/** Normalized 0..1 values per component, plus the points each contributed
 *  to the final heat score (= normalized * weight). */
export interface HrTargetSubscores {
  l3: number;
  l5: number;
  l7d: number;
  season: number;
  pitcher: number;
  park: number;
  hand: number;
  weather: number;
  contributions: {
    l3: number;
    l5: number;
    l7d: number;
    season: number;
    pitcher: number;
    park: number;
    hand: number;
    weather: number;
  };
}

/**
 * A compact, verified reason chip. Three tones:
 *   - 'good'    — positive signal (Hot last 7d, Park boost, Wind boost…)
 *   - 'bad'     — negative signal (Cold L5+L7d, Dominant pitcher, Wind in…)
 *   - 'neutral' — informational caveat (Data limited, Low confidence…)
 *
 * `label` is what the chip shows. `detail` is the longer numeric backup
 * that the expanded row reveals — it always cites the source value, so
 * the chip itself can stay short without losing accountability.
 */
export interface ReasonChip {
  label: string;
  tone: 'good' | 'bad' | 'neutral';
  /** Optional longer text — shown in the expanded detail tooltip / row. */
  detail?: string;
  /** Stable id so React keys are stable and CSS can target a kind if needed. */
  kind: string;
}

export interface HrTarget {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  venue_name: string | null;
  pitcher_id: number | null;
  pitcher_name: string;        // "TBD" when unknown
  pitcher_hand: string | null;
  batter_side: string | null;
  /** HRs in player's last 2 distinct HR-game-dates ≤ asOf (for "3 HR in last 2 games" reason). */
  hrs_l2: number;
  hrs_l3: number;
  hrs_l5: number;
  hrs_l7d: number;
  /** Length of consecutive-calendar-day HR streak ending at the player's most recent HR ≤ asOf. */
  hr_streak: number;
  season_hr: number;
  /** Per-pitcher-hand HRs this season (excludes rows with unknown pitcher_throws). */
  vs_lhp_season: number;
  vs_rhp_season: number;
  heat_score: number;          // rounded to 1 decimal
  subscores: HrTargetSubscores;
  /** Grouped score breakdown (post-stability) for the expandable detail. */
  breakdown: HrTargetBreakdown;
  /** Legacy: short sentences kept ONLY for snapshot back-compat (the
   *  Backtest page joins this string array). The HR Targets UI now reads
   *  `reason_chips` instead — see ReasonChip below. */
  reasons: string[];
  /** Verified, compact reason chips. Each chip is derived from a real
   *  measured fact (calendar-window HRs, pitcher-starts data, etc.) —
   *  never from "last N HR-games" sleight-of-hand which conflated
   *  "games played" with "games where this hitter homered". */
  reason_chips: ReasonChip[];

  // Pitcher / venue context, denormalized for display + reason text:
  pitcher_l14d_allowed: number;
  pitcher_l3_starts_allowed: number;
  pitcher_l5_starts_allowed: number;
  pitcher_season_allowed: number;
  /** How many starts we have on file for this pitcher. 0 = approximation from home_runs. */
  pitcher_starts_known: number;
  /** Recent K/9. undefined when starts data is too thin to compute. */
  pitcher_k_per_9: number | null;
  /** Recent BB/9. undefined when starts data is too thin to compute. */
  pitcher_bb_per_9: number | null;
  venue_l14d_hrs: number;
  /** 1-based rank of this venue in the league by L14d HRs. null if no venue. */
  venue_l14d_rank: number | null;
  /** Total venues with at least one HR — used to express rank context. */
  venue_total: number;
  /** True when the player is in the curated ELITE_POWER_NAMES set (or caller-supplied elitePowerIds). */
  is_elite_power: boolean;
  /** Confidence in this ranking, derived from data completeness +
   *  factor agreement. Drives the small badge next to Heat Score on
   *  /targets so the user can tell whether a high score is broad-based
   *  or built on thin data. */
  confidence: 'high' | 'medium' | 'low';

  // Weather context, denormalized for display in the expanded row.
  weather_condition: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  /** Freshness timestamp from games.weather_updated_at — drives the
   *  "Updated 6:14 PM" suffix on the WeatherLine. Null = never enriched. */
  weather_updated_at: string | null;
  /** True when weather actually moved the heat score (false = dome /
   *  missing data / net-zero swing). */
  weather_included: boolean;

  /** Lineup availability (task #176):
   *   'confirmed'    — player is in the posted batting order
   *   'pending'      — lineup not posted yet (allowed, small uncertainty penalty)
   *   'not_starting' — lineup posted, player NOT in it (bench/rest/injury)
   *   'postponed'    — game postponed / cancelled / suspended
   *  The HR Targets page hides not_starting + postponed from Top 10/50. */
  lineup_status: LineupStatus;
}

export interface HrTargetsBoard {
  game_pk: number;
  game_date: string;
  away_team: string;
  home_team: string;
  venue_name: string | null;
  /** Pitcher facing the AWAY team's batters (i.e., the HOME team's probable). */
  away_facing: { id: number | null; name: string; hand: string | null };
  /** Pitcher facing the HOME team's batters (i.e., the AWAY team's probable). */
  home_facing: { id: number | null; name: string; hand: string | null };
  away_targets: HrTarget[];
  home_targets: HrTarget[];
  // Weather context for the whole game (null until enrich:weather runs).
  weather_condition: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  /** Freshness timestamp from games.weather_updated_at. */
  weather_updated_at: string | null;
}

interface InternalAgg {
  player_id: number;
  name: string;
  team: string;
  batter_side: string | null;
  rows: HomeRunRowLite[];
  perDate: Map<string, number>;
  distinctDates: string[];
  vs_lhp: number;
  vs_rhp: number;
  known_hand_hrs: number;
}

type HomeRunRowLite = Pick<
  HomeRunRow,
  'player_id' | 'player_name' | 'team' | 'game_date' | 'batter_side' | 'pitcher_throws' | 'id'
>;

function aggregateByPlayerForTargets(rows: HomeRunRowLite[], anchor: string): Map<number, InternalAgg> {
  const out = new Map<number, InternalAgg>();
  for (const r of rows) {
    if (r.game_date > anchor) continue; // never use future data
    let a = out.get(r.player_id);
    if (!a) {
      a = {
        player_id: r.player_id,
        name: r.player_name,
        team: r.team,
        batter_side: r.batter_side ?? null,
        rows: [],
        perDate: new Map(),
        distinctDates: [],
        vs_lhp: 0,
        vs_rhp: 0,
        known_hand_hrs: 0,
      };
      out.set(r.player_id, a);
    }
    a.name = r.player_name;
    a.team = r.team;
    if (r.batter_side) a.batter_side = r.batter_side;
    a.rows.push(r);
    a.perDate.set(r.game_date, (a.perDate.get(r.game_date) ?? 0) + 1);
    if (r.pitcher_throws === 'L') { a.vs_lhp++; a.known_hand_hrs++; }
    else if (r.pitcher_throws === 'R') { a.vs_rhp++; a.known_hand_hrs++; }
  }
  for (const a of out.values()) {
    a.distinctDates = Array.from(a.perDate.keys()).sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
  }
  return out;
}

function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)); }
function round1(n: number) { return Math.round(n * 10) / 10; }
function round2(n: number) { return Math.round(n * 100) / 100; }

/**
 * Build specific, numeric reason strings — never generic.
 *
 * Returns 1–3 strings prioritized by how much they contributed to the heat
 * score. Examples produced:
 *   "5 HR last 5 games"
 *   "12 season HR"
 *   "5 HR vs RHP this season"
 *   "Venue top 5 in L14d HRs"
 *   "Pitcher allowed 3 HR last 3 starts"
 */
/**
 * Builds specific, numeric reason strings. Up to 4 per player, prioritized
 * by their contribution to the heat score so the strongest signals lead.
 *
 * Includes:
 *   - L2 / L3 / L5 / L7d streaks (most specific phrasing wins)
 *   - Multi-day consecutive-game streak ("HR in 3 straight games")
 *   - Season power milestone
 *   - Per-pitcher-hand season count vs the actual probable's hand
 *   - Pitcher recent HR-allowed (L3 starts → L14d fallback)
 *   - Park rank (top 5) or absolute L14d
 *   - Meta tag: "Hot streak + favorable matchup" when 2+ heavy signals stack
 */
/**
 * pickReasonChips — emits compact, *verified* chips for the UI.
 *
 * Strict rules (per user audit, task #161):
 *   - Recent-form chips ONLY fire from calendar-window measurements
 *     (hrs_l7d, hr_streak) — NEVER from "last N HR-games", which
 *     reported misleading text like "2 HR over last 2 HR games" for
 *     hitters whose most-recent HRs were a month apart.
 *   - Pitcher-weakness "L3/L5 starts" chips require real pitcher_starts
 *     data (starts_known ≥ 3). Without it, only the calendar-window
 *     L14d claim is allowed, and only if it's non-trivial.
 *   - If no chip would fire, we emit a single neutral "Data limited" chip
 *     rather than inventing prose.
 *
 * `pickReasons` is kept as a back-compat wrapper that joins chip labels
 * into the legacy string[] for snapshots and the Backtest page.
 */
function pickReasonChips(t: HrTarget): ReasonChip[] {
  const candidates: { weight: number; chip: ReasonChip }[] = [];
  const c = t.subscores.contributions;
  const havePitcherStarts = t.pitcher_starts_known >= 3;

  // ----- recent form: ONLY calendar-window facts -----
  // hrs_l7d is "HRs in the last 7 calendar days ≤ asOf" — game-log truth.
  if (t.hrs_l7d >= 3) {
    candidates.push({
      weight: 32,
      chip: { kind: 'hot7', label: 'Hot last 7d', tone: 'good', detail: `${t.hrs_l7d} HR in last 7 days` },
    });
  } else if (t.hrs_l7d === 2) {
    candidates.push({
      weight: 22,
      chip: { kind: 'hot7', label: 'Hot last 7d', tone: 'good', detail: `2 HR in last 7 days` },
    });
  }

  // Consecutive-calendar-day HR streak — a clean, easy-to-verify signal.
  if (t.hr_streak >= 3) {
    candidates.push({
      weight: 26,
      chip: { kind: 'streak', label: `${t.hr_streak}d HR streak`, tone: 'good', detail: `HR on ${t.hr_streak} consecutive calendar days` },
    });
  } else if (t.hr_streak === 2) {
    candidates.push({
      weight: 14,
      chip: { kind: 'streak', label: 'Back-to-back days', tone: 'good', detail: 'HR on 2 consecutive calendar days' },
    });
  }

  // ----- season power: short labels, value in detail -----
  if (t.season_hr >= 25) {
    candidates.push({ weight: c.season + 6, chip: { kind: 'power', label: 'Elite power', tone: 'good', detail: `${t.season_hr} season HR` } });
  } else if (t.season_hr >= 15) {
    candidates.push({ weight: c.season + 2, chip: { kind: 'power', label: 'Strong power', tone: 'good', detail: `${t.season_hr} season HR` } });
  } else if (t.season_hr >= 8 && c.season >= 1) {
    candidates.push({ weight: c.season, chip: { kind: 'power', label: 'Mid-tier power', tone: 'good', detail: `${t.season_hr} season HR` } });
  }

  // ----- handedness edge -----
  if (t.pitcher_hand === 'L' || t.pitcher_hand === 'R') {
    const vsCount = t.pitcher_hand === 'L' ? t.vs_lhp_season : t.vs_rhp_season;
    if (vsCount >= 3 && c.hand >= 1.5) {
      candidates.push({
        weight: c.hand + 1.5,
        chip: { kind: 'hand', label: `Good vs ${t.pitcher_hand}HP`, tone: 'good', detail: `${vsCount} HR vs ${t.pitcher_hand}HP this season` },
      });
    }
  }

  // ----- pitcher weakness — strict source rules -----
  if (havePitcherStarts && t.pitcher_l5_starts_allowed >= 4) {
    candidates.push({
      weight: c.pitcher + t.pitcher_l5_starts_allowed,
      chip: { kind: 'pitcher_weak', label: 'Weak HR pitcher', tone: 'good', detail: `Allowed ${t.pitcher_l5_starts_allowed} HR in last 5 starts` },
    });
  } else if (havePitcherStarts && t.pitcher_l3_starts_allowed >= 3) {
    candidates.push({
      weight: c.pitcher + t.pitcher_l3_starts_allowed,
      chip: { kind: 'pitcher_weak', label: 'Weak HR pitcher', tone: 'good', detail: `Allowed ${t.pitcher_l3_starts_allowed} HR in last 3 starts` },
    });
  } else if (t.pitcher_l14d_allowed >= 3) {
    candidates.push({
      weight: c.pitcher,
      chip: { kind: 'pitcher_weak', label: 'Weak HR pitcher', tone: 'good', detail: `Allowed ${t.pitcher_l14d_allowed} HR in last 14 days` },
    });
  }

  // Pitcher quality — NEGATIVE chips.
  if (t.pitcher_k_per_9 != null && havePitcherStarts) {
    if (t.pitcher_k_per_9 >= 11 && t.pitcher_l5_starts_allowed <= 1) {
      candidates.push({
        weight: 22,
        chip: { kind: 'pitcher_dominant', label: 'Dominant pitcher', tone: 'bad', detail: `K/9 ${t.pitcher_k_per_9.toFixed(1)}, ${t.pitcher_l5_starts_allowed} HR L5 starts` },
      });
    } else if (t.pitcher_k_per_9 >= 11) {
      candidates.push({
        weight: 14,
        chip: { kind: 'pitcher_highK', label: 'High-K pitcher', tone: 'bad', detail: `K/9 ${t.pitcher_k_per_9.toFixed(1)}` },
      });
    }
  }
  if (t.pitcher_bb_per_9 != null && havePitcherStarts && t.pitcher_bb_per_9 >= 4.5) {
    candidates.push({
      weight: 12,
      chip: { kind: 'pitcher_wild', label: 'Wild pitcher', tone: 'good', detail: `BB/9 ${t.pitcher_bb_per_9.toFixed(1)}` },
    });
  }

  // ----- park boost -----
  if (t.venue_l14d_rank != null && t.venue_l14d_rank <= 5 && t.venue_l14d_hrs >= 2) {
    candidates.push({
      weight: c.park + (6 - t.venue_l14d_rank),
      chip: { kind: 'park', label: 'Park boost', tone: 'good', detail: `Top ${t.venue_l14d_rank} in L14d HRs (${t.venue_l14d_hrs} HR L14d)` },
    });
  } else if (t.venue_l14d_hrs >= 4) {
    candidates.push({
      weight: c.park,
      chip: { kind: 'park', label: 'Park boost', tone: 'good', detail: `${t.venue_l14d_hrs} HR L14d at venue` },
    });
  }

  // ----- weather chips — only when actually included in heat score -----
  if (t.weather_included) {
    // Re-derive a short label from temp/wind for chip display. The
    // numeric adjustment is in the expanded breakdown row.
    const w = t.weather_wind_mph ?? 0;
    const dir = (t.weather_wind_dir ?? '').toLowerCase();
    const tempBoost = (t.weather_temp_f ?? 0) >= 85;
    const isOut = /out to/.test(dir);
    const isIn = /in from/.test(dir);
    if (isOut && w >= 10) {
      candidates.push({ weight: 10, chip: { kind: 'wind_out', label: 'Wind boost', tone: 'good', detail: `${w} mph ${dir}` } });
    } else if (isIn && w >= 10) {
      candidates.push({ weight: 10, chip: { kind: 'wind_in', label: 'Wind in', tone: 'bad', detail: `${w} mph ${dir}` } });
    }
    if (tempBoost) {
      candidates.push({ weight: 6, chip: { kind: 'warm', label: 'Warm', tone: 'good', detail: `${t.weather_temp_f}°F` } });
    }
  }

  // ----- cold-streak surface (NEGATIVE) -----
  // Calendar-window ONLY. We deliberately do NOT mix in hrs_l5 here, even
  // though the scoring penalty still does — hrs_l5 counts the player's
  // last 5 *HR-dates* (could be months old), so a hitter like Elly De La
  // Cruz with HRs in April had hrs_l5=2 and was incorrectly classified
  // as "not cold" despite a real 0-HR-in-7-days drought. The chip stays
  // honest by reading the calendar-window value only.
  if (t.hrs_l7d === 0 && t.season_hr >= HEAT_SCORE_STABILITY.auto_elite_hr) {
    candidates.push({
      weight: 18,
      chip: { kind: 'cold', label: 'Cold last 7d', tone: 'bad', detail: `0 HR last 7 days (${t.season_hr} season HR baseline)` },
    });
  } else if (t.hrs_l7d === 0 && t.season_hr >= 8) {
    candidates.push({
      weight: 10,
      chip: { kind: 'cold', label: 'Cold last 7d', tone: 'bad', detail: '0 HR in the last 7 calendar days' },
    });
  }

  // ----- LOW-CONFIDENCE NOTE -----
  if (t.confidence === 'low') {
    candidates.push({
      weight: 5,
      chip: { kind: 'low_conf', label: 'Low confidence', tone: 'neutral', detail: 'Limited sample or few factors agreeing' },
    });
  }

  // ----- DATA-LIMITED NOTE -----
  // Fires when we couldn't load pitcher-starts data for the probable.
  // The chip warns the user that pitcher-weakness chips are absent because
  // of missing inputs, not because the pitcher looks safe.
  if (!havePitcherStarts && t.pitcher_id != null && t.pitcher_name !== 'TBD') {
    candidates.push({
      weight: 3,
      chip: { kind: 'data_limited', label: 'Data limited', tone: 'neutral', detail: 'Pitcher start data unavailable — pitcher chips suppressed' },
    });
  }

  candidates.sort((a, b) => b.weight - a.weight);

  if (candidates.length === 0) {
    // STRICT honesty rule: when nothing verifiable applies, say so plainly.
    return [
      { kind: 'data_limited', label: 'Data limited', tone: 'neutral', detail: 'No verified signals for this matchup yet' },
    ];
  }

  const seen = new Set<string>();
  const out: ReasonChip[] = [];
  for (const c2 of candidates) {
    if (seen.has(c2.chip.kind)) continue;
    seen.add(c2.chip.kind);
    out.push(c2.chip);
    if (out.length === 5) break; // small cap so the chip row stays scannable on mobile
  }
  return out;
}

/** Back-compat — flatten chips into the legacy string[] format consumed
 *  by snapshot rows and the Backtest table. */
function pickReasons(t: HrTarget): string[] {
  return t.reason_chips.map((c) => (c.detail ? `${c.label} — ${c.detail}` : c.label));
}

/** Public so HrTargets.tsx can build the index and pass it in. */
export interface PitcherFormLite {
  pitcher_id: number;
  pitcher_throws: string | null;
  allowed_last_14_days: number;
  allowed_last_3_starts: number;
  /** Last 5 starts HR allowed. Only meaningful when sourced from pitcher_starts. */
  allowed_last_5_starts?: number;
  /** Season HR allowed. Only meaningful when sourced from pitcher_starts. */
  season_hr_allowed?: number;
  /** How many starts we have data for. 0 = approximation from home_runs. */
  starts_known?: number;
  /** Strikeouts per 9 innings across the starts we have on file.
   *  Only meaningful when sourced from pitcher_starts AND starts_known ≥ 3
   *  AND total innings_pitched ≥ 18 (≈3 full starts). undefined otherwise. */
  k_per_9?: number;
  /** Walks per 9 innings. Same caveats as k_per_9. */
  bb_per_9?: number;
}

interface VenueFormLite {
  venue_name: string;
  l14d: number;
  /** 1-based rank in L14d HRs across all venues (1 = most). */
  rank_l14d?: number;
  /** Total ranked venues (denominator for "top N of M" phrasing). */
  total_ranked?: number;
}

/**
 * Build a per-game targets board for each scheduled game. Hitters considered:
 * every player who has at least one HR in the season-to-date window AND whose
 * canonical team (already remapped via applyCanonicalTeams upstream) matches
 * one of the game's teams.
 */
export function computeHrTargets(
  rows: HomeRunRowLite[],
  asOf: string,
  games: HrTargetGame[],
  opts: {
    pitcherIndex?: ReadonlyMap<number, PitcherFormLite>;
    venueIndex?: ReadonlyMap<string, VenueFormLite>;
    limitPerTeam?: number;
    /**
     * Player IDs the caller has identified as elite power (Power Floor applies).
     * Typically built from the canonical `players` table by matching full_name
     * against ELITE_POWER_NAMES. Override-able for tests.
     */
    elitePowerIds?: ReadonlySet<number>;
  } = {},
): HrTargetsBoard[] {
  const limit = opts.limitPerTeam ?? 8;
  const pitcherIndex = opts.pitcherIndex ?? new Map<number, PitcherFormLite>();
  const venueIndex = opts.venueIndex ?? new Map<string, VenueFormLite>();
  const elitePowerIds = opts.elitePowerIds ?? new Set<number>();
  const byPlayer = aggregateByPlayerForTargets(rows, asOf);

  // Group candidate hitters by team for fast lookup
  const candidatesByTeam = new Map<string, InternalAgg[]>();
  for (const a of byPlayer.values()) {
    if (a.rows.length === 0) continue;
    let arr = candidatesByTeam.get(a.team);
    if (!arr) { arr = []; candidatesByTeam.set(a.team, arr); }
    arr.push(a);
  }

  const sevenStart = addDays(asOf, -6);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  function rankForTeam(
    team: string,
    opponent: string,
    venueName: string | null,
    pitcher: { id: number | null; name: string; hand: string | null },
    weather: {
      adjustment: WeatherAdjustment;
      condition: string | null;
      temp_f: number | null;
      wind_mph: number | null;
      wind_dir: string | null;
      updated_at: string | null;
    },
    lineup: {
      /** This team's posted batting order (player_ids), or [] when pending. */
      order: number[];
      /** True once the game's lineups are confirmed (both sides 9-man). */
      confirmed: boolean;
      /** Game postponed / cancelled / suspended. */
      dead: boolean;
    },
  ): HrTarget[] {
    const pool = candidatesByTeam.get(team) ?? [];

    // Per-pitcher form — prefer pitcher_starts data when present, else
    // fall back to the home_runs-based approximation.
    const pitcherForm = pitcher.id != null ? pitcherIndex.get(pitcher.id) ?? null : null;
    const pitcher_l14d = pitcherForm?.allowed_last_14_days ?? 0;
    const pitcher_l3_starts = pitcherForm?.allowed_last_3_starts ?? 0;
    const pitcher_l5_starts = pitcherForm?.allowed_last_5_starts ?? pitcher_l3_starts;
    const pitcher_season   = pitcherForm?.season_hr_allowed ?? 0;
    const pitcher_starts_known = pitcherForm?.starts_known ?? 0;
    // K/9 and BB/9 — only meaningful when we have real pitcher_starts data.
    // The home_runs approximation can't compute these (no IP / K / BB info).
    const pitcher_k_per_9  = pitcher_starts_known >= 3 ? pitcherForm?.k_per_9 ?? null : null;
    const pitcher_bb_per_9 = pitcher_starts_known >= 3 ? pitcherForm?.bb_per_9 ?? null : null;

    // Per-venue form — fallback 0
    const venueForm = venueName ? venueIndex.get(venueName) ?? null : null;
    const venue_l14d = venueForm?.l14d ?? 0;
    const venue_rank = venueForm?.rank_l14d ?? null;
    const venue_total = venueForm?.total_ranked ?? 0;

    const targets = pool.map<HrTarget>((a) => {
      // L2 / L3 / L5 (per-player most-recent distinct HR-dates ≤ asOf)
      const last2 = a.distinctDates.slice(0, 2);
      const last3 = a.distinctDates.slice(0, 3);
      const last5 = a.distinctDates.slice(0, 5);
      const sumDates = (ds: string[]) => ds.reduce((s, d) => s + (a.perDate.get(d) ?? 0), 0);
      const hrs_l2 = sumDates(last2);
      const hrs_l3 = sumDates(last3);
      const hrs_l5 = sumDates(last5);

      // L7d and season totals
      let hrs_l7d = 0;
      let season_hr = 0;
      for (const r of a.rows) {
        if (r.game_date >= sevenStart) hrs_l7d++;
        if (r.game_date >= yearStart) season_hr++;
      }

      // Consecutive-calendar-day HR streak ending at the most recent HR
      let hr_streak = 0;
      for (let i = 0; i < a.distinctDates.length; i++) {
        if (i === 0) {
          hr_streak = 1;
          continue;
        }
        if (daysBetween(a.distinctDates[i], a.distinctDates[i - 1]) === 1) {
          hr_streak++;
        } else {
          break;
        }
      }
      if (a.distinctDates.length === 0) hr_streak = 0;

      // ---- elite power detection ----
      // Elite players get a Power Floor: their season_power normalized
      // value can't drop below ELITE_SEASON_POWER_FLOOR, and their
      // stability factor uses an elevated effective season_hr.
      //
      // Two paths to "elite":
      //   1. Curated list (ELITE_POWER_NAMES → elitePowerIds) — for known
      //      sluggers whose current-season HR count hasn't caught up yet
      //   2. Auto-elite at season_hr ≥ 12 — guard rail so the model can
      //      always recognize a power profile from the data itself
      const isCuratedElite = elitePowerIds.has(a.player_id);
      const isAutoElite = season_hr >= HEAT_SCORE_STABILITY.auto_elite_hr;
      const isElitePower = isCuratedElite || isAutoElite;

      // ---- normalized 0..1 subscores ----
      const W = HEAT_SCORE_WEIGHTS;
      const SAT = HEAT_SCORE_SATURATION;
      const n_l3      = clamp(hrs_l3 / SAT.l3,           0, 1);
      const n_l5      = clamp(hrs_l5 / SAT.l5,           0, 1);
      const n_l7d     = clamp(hrs_l7d / SAT.l7d,         0, 1);
      // Season power: actual normalized, OR 0.7 floor for elite power hitters
      // when their current-season count hasn't caught up to their track record.
      const ELITE_SEASON_POWER_FLOOR = 0.7;
      const n_season_actual = clamp(season_hr / SAT.season, 0, 1);
      const n_season  = isElitePower
        ? Math.max(n_season_actual, ELITE_SEASON_POWER_FLOOR)
        : n_season_actual;
      const n_pitcher = clamp(pitcher_l14d / SAT.pitcher_l14d, 0, 1);
      const n_park    = clamp(venue_l14d / SAT.park_l14d,      0, 1);

      let raw_hand_edge = 0;
      if (pitcher.hand === 'L' || pitcher.hand === 'R') {
        const vs = pitcher.hand === 'L' ? a.vs_lhp : a.vs_rhp;
        const denom = a.known_hand_hrs || 0;
        if (denom > 0) raw_hand_edge = clamp((vs / denom) * SAT.hand, 0, SAT.hand);
      }
      const n_hand    = raw_hand_edge / SAT.hand; // 0..1
      const n_weather = 0; // placeholder until weather data is wired

      // ---- stability factor: dampens recent-form contributions when the
      //      player has a thin season HR baseline. Elite power hitters get
      //      a lifted effective_season_hr so a slow-start Judge isn't
      //      dampened the same way a true fringe hitter would be.
      const stab     = stabilityFactor(season_hr, isElitePower);
      const stab_raw = stabilityFactor(season_hr, false); // for raw-score comparison

      // ---- contributions (points) ----
      // Recent-form contributions get the stability dampener applied.
      const c_l3      = W.l3      * n_l3      * stab;
      const c_l5      = W.l5      * n_l5      * stab;
      const c_l7d     = W.l7d     * n_l7d     * stab;
      // Season power / matchup / venue / weather are NOT dampened.
      const c_season  = W.season  * n_season;
      const c_pitcher = W.pitcher * n_pitcher;
      const c_park    = W.park    * n_park;
      const c_hand    = W.hand    * n_hand;
      const c_weather = W.weather * n_weather;

      // ---- raw heat (no Power Floor, no cap) — for transparency ----
      // Shows the user what the score would be without elite adjustments
      // or the low-power cap. We use the same formula but with
      // un-floored season_power and un-elite stability.
      const heat_raw = (
        W.l3 * n_l3 * stab_raw +
        W.l5 * n_l5 * stab_raw +
        W.l7d * n_l7d * stab_raw +
        W.season * n_season_actual +
        c_pitcher + c_park + c_hand + c_weather
      );

      // ---- adjusted heat ----
      let heat = c_l3 + c_l5 + c_l7d + c_season + c_pitcher + c_park + c_hand + c_weather;
      const adjustments: { label: string; delta: number }[] = [];

      // Track Power Floor boost (combined season + stability lift)
      const powerFloorDelta = heat - heat_raw;
      if (isElitePower && powerFloorDelta > 0.05) {
        adjustments.push({
          label: isAutoElite && !isCuratedElite
            ? 'Power Floor (12+ season HR, auto)'
            : 'Power Floor (curated elite)',
          delta: round1(powerFloorDelta),
        });
      }

      // Low-power cap: non-elite player with sub-5 season HR and no
      // calendar-recent streak. Caps how high they can rank so a single
      // matchup edge doesn't put a fringe hitter into the Top 10.
      // hrs_l7d ≥ 2 (real 7-day streak) exempts.
      const C = HEAT_SCORE_LOW_POWER_CAP;
      const lowPowerCapEligible = !isElitePower
        && season_hr < C.season_hr_max
        && hrs_l7d < C.l7d_exemption;
      if (lowPowerCapEligible && heat > C.cap) {
        const before = heat;
        heat = C.cap;
        adjustments.push({
          label: `Low-power cap (≤${C.cap}; <${C.season_hr_max} season HR + <${C.l7d_exemption} HR L7d)`,
          delta: round1(heat - before),
        });
      }

      // ---- NEGATIVE WEIGHTING ----
      // Tracks penalties separately so the UI can show a single
      // `cold_penalty` summary and the operator can see each component
      // in `adjustments`. All deltas are ≤ 0.
      let cold_penalty = 0;

      // (a) Cold-streak penalty: power hitter has gone genuinely quiet
      //     by both rolling-game and calendar measures. We require BOTH
      //     hrs_l5 === 0 AND hrs_l7d === 0 so a single L5 stretch with
      //     a recent calendar HR doesn't trigger it.
      const isQuiet = hrs_l5 === 0 && hrs_l7d === 0;
      if (isQuiet && season_hr >= HEAT_SCORE_STABILITY.auto_elite_hr) {
        const penalty = HEAT_SCORE_COLD_PENALTY.elite;
        heat += penalty;
        cold_penalty += penalty;
        adjustments.push({
          label: `Cold streak — 0 HR L5 games + 0 HR L7 days (${season_hr} season HR)`,
          delta: penalty,
        });
      } else if (isQuiet && season_hr >= 8) {
        const penalty = HEAT_SCORE_COLD_PENALTY.mid;
        heat += penalty;
        cold_penalty += penalty;
        adjustments.push({
          label: `Cold streak — 0 HR L5 games + 0 HR L7 days (${season_hr} season HR)`,
          delta: penalty,
        });
      }

      // (b) Pitcher dominance penalty: facing a starter with elite
      //     strikeout rate AND a clean HR-allowed record across L5
      //     starts. Only fires when we have real pitcher_starts data
      //     so the K/9 number is trustworthy.
      if (pitcher_k_per_9 != null && pitcher_starts_known >= 3) {
        if (pitcher_k_per_9 >= 11 && pitcher_l5_starts <= 1) {
          const penalty = -8;
          heat += penalty;
          cold_penalty += penalty;
          adjustments.push({
            label: `Facing dominant pitcher (K/9 ${pitcher_k_per_9.toFixed(1)}, ${pitcher_l5_starts} HR L5 starts)`,
            delta: penalty,
          });
        } else if (pitcher_k_per_9 >= 11) {
          // High-K pitcher without the HR-suppression bonus → still a headwind
          const penalty = -4;
          heat += penalty;
          cold_penalty += penalty;
          adjustments.push({
            label: `Facing high-K pitcher (K/9 ${pitcher_k_per_9.toFixed(1)})`,
            delta: penalty,
          });
        }
      }

      // (c) Pitcher wildness boost: extreme BB/9 means lots of free
      //     baserunners and mistakes in the zone. Small positive nudge.
      if (pitcher_bb_per_9 != null && pitcher_starts_known >= 3 && pitcher_bb_per_9 >= 4.5) {
        const boost = +2;
        heat += boost;
        adjustments.push({
          label: `Wild pitcher (BB/9 ${pitcher_bb_per_9.toFixed(1)})`,
          delta: boost,
        });
      }

      // ---- COMPLETENESS MULTIPLIER ----
      // Count how many of the 5 independent factors are firing
      // meaningfully. Recent form is treated as one composite factor
      // using the weighted average of l3/l5/l7d normalized values, so
      // we don't triple-count it. Elite power profiles get a +1 bonus
      // to keep proven sluggers competitive when other factors are weak.
      const recentCombined = (n_l3 * W.l3 + n_l5 * W.l5 + n_l7d * W.l7d) / (W.l3 + W.l5 + W.l7d);
      const factorValues = [n_season, recentCombined, n_pitcher, n_hand, n_park];
      const CFG = HEAT_SCORE_COMPLETENESS;
      let factorsFiring = factorValues.filter((v) => v >= CFG.factor_threshold).length;
      if (isElitePower) factorsFiring += CFG.elite_bonus;
      // Cap factorsFiring at 5 for the multiplier so the elite bonus
      // doesn't inflate above 1.0 — it's a safety net, not a boost.
      const factorsForMultiplier = Math.min(factorsFiring, 5);
      const completenessMultiplier = clamp(
        CFG.base + factorsForMultiplier * CFG.per_factor,
        CFG.base,
        1.0,
      );
      const heatBeforeMultiplier = heat;
      heat = heat * completenessMultiplier;
      if (completenessMultiplier < 1.0) {
        adjustments.push({
          label: `Completeness ×${completenessMultiplier.toFixed(2)} (${factorsForMultiplier}/5 factors firing${isElitePower ? ', incl. elite-power bonus' : ''})`,
          delta: round1(heat - heatBeforeMultiplier),
        });
      }

      // ---- CEILING COMPRESSION ----
      // Above the soft cap, every point gets multiplied by `compression`,
      // yielding diminishing returns and making 80+ scores genuinely rare.
      const CEIL = HEAT_SCORE_CEILING;
      let ceilingCompressionDelta = 0;
      if (heat > CEIL.soft_cap) {
        const heatBeforeCompression = heat;
        heat = CEIL.soft_cap + (heat - CEIL.soft_cap) * CEIL.compression;
        ceilingCompressionDelta = round1(heat - heatBeforeCompression);
        adjustments.push({
          label: `Ceiling compression — diminishing returns above ${CEIL.soft_cap}`,
          delta: ceilingCompressionDelta,
        });
      }

      // ---- WEATHER ADJUSTMENT (light) ----
      // A small, bounded environmental nudge applied LAST so it never
      // swings a ranking on its own. Neutral (delta 0) when the game is
      // in a dome or weather data is missing.
      if (weather.adjustment.delta !== 0) {
        heat += weather.adjustment.delta;
        adjustments.push({
          label: weather.adjustment.label,
          delta: weather.adjustment.delta,
        });
      }

      // ---- LINEUP STATUS (task #176) ----
      // Classify the player's availability from the posted batting order.
      //   dead game            → 'postponed'
      //   order posted + in it → 'confirmed'
      //   order posted + absent→ 'not_starting'
      //   order not posted     → 'pending' (small uncertainty penalty)
      let lineup_status: LineupStatus;
      if (lineup.dead) {
        lineup_status = 'postponed';
      } else if (lineup.order.length >= 9) {
        lineup_status = lineup.order.includes(a.player_id) ? 'confirmed' : 'not_starting';
      } else {
        lineup_status = 'pending';
      }
      // Uncertainty penalty for pending lineups so confirmed starters edge
      // out players whose status is unknown. Small + uniform — in the early
      // morning when NO lineup is posted, every player gets it equally, so
      // relative ranking is unchanged; it only bites once SOME lineups
      // confirm. The page hides not_starting/postponed entirely, so no
      // score penalty is needed for those.
      if (lineup_status === 'pending') {
        const penalty = HEAT_SCORE_LINEUP_PENDING_PENALTY;
        heat += penalty;
        adjustments.push({ label: 'Lineup pending (uncertainty)', delta: penalty });
      }

      // Heat never goes below 0
      if (heat < 0) heat = 0;

      // ---- CONFIDENCE LABEL ----
      // Combine factor agreement (how many independent signals agree)
      // with data quality (do we have real pitcher_starts? meaningful
      // season sample?). Score 0-7, mapped to high/medium/low.
      let dataQualityScore = 0;
      if (pitcher_starts_known >= 3) dataQualityScore += 2;
      else if (pitcher_l14d > 0) dataQualityScore += 1;
      if (season_hr >= 12) dataQualityScore += 2;
      else if (season_hr >= 6) dataQualityScore += 1;
      if (venue_l14d > 0) dataQualityScore += 1;
      const confidenceScore = factorsFiring + dataQualityScore; // 0..10
      const confidence: 'high' | 'medium' | 'low' =
        confidenceScore >= 6 ? 'high' :
        confidenceScore >= 3 ? 'medium' :
        'low';

      const subscores: HrTargetSubscores = {
        l3: round2(n_l3),
        l5: round2(n_l5),
        l7d: round2(n_l7d),
        season: round2(n_season),
        pitcher: round2(n_pitcher),
        park: round2(n_park),
        hand: round2(n_hand),
        weather: round2(n_weather),
        contributions: {
          l3: round1(c_l3),
          l5: round1(c_l5),
          l7d: round1(c_l7d),
          season: round1(c_season),
          pitcher: round1(c_pitcher),
          park: round1(c_park),
          hand: round1(c_hand),
          weather: round1(c_weather),
        },
      };

      const breakdown: HrTargetBreakdown = {
        season_power_score: round1(c_season),
        recent_form_score: round1(c_l3 + c_l5 + c_l7d),
        pitcher_score: round1(c_pitcher),
        handedness_score: round1(c_hand),
        venue_score: round1(c_park),
        weather_score: round1(c_weather),
        weather_adjustment: round1(weather.adjustment.delta),
        weather_temp_boost: weather.adjustment.temp_boost,
        weather_wind_boost: weather.adjustment.wind_boost,
        weather_temp_label: weather.adjustment.temp_label,
        weather_wind_label: weather.adjustment.wind_label,
        weather_is_dome: weather.adjustment.is_dome,
        cold_penalty: round1(cold_penalty),
        stability_factor: round2(stab),
        factors_firing: factorsForMultiplier,
        completeness_multiplier: round2(completenessMultiplier),
        ceiling_compression: round1(Math.abs(ceilingCompressionDelta)),
        raw_score: round1(heat_raw),
        adjustments,
        final_heat_score: round1(heat),
      };

      const target: HrTarget = {
        player_id: a.player_id,
        player_name: a.name,
        team,
        opponent,
        venue_name: venueName,
        pitcher_id: pitcher.id,
        pitcher_name: pitcher.name,
        pitcher_hand: pitcher.hand,
        batter_side: a.batter_side,
        hrs_l2,
        hrs_l3,
        hrs_l5,
        hrs_l7d,
        hr_streak,
        season_hr,
        vs_lhp_season: a.vs_lhp,
        vs_rhp_season: a.vs_rhp,
        heat_score: round1(heat),
        subscores,
        breakdown,
        // Filled below from pickReasonChips() / pickReasons() so the
        // chip pass sees all the other fields already populated.
        reasons: [],
        reason_chips: [],
        pitcher_l14d_allowed: pitcher_l14d,
        pitcher_l3_starts_allowed: pitcher_l3_starts,
        pitcher_l5_starts_allowed: pitcher_l5_starts,
        pitcher_season_allowed: pitcher_season,
        pitcher_starts_known: pitcher_starts_known,
        pitcher_k_per_9,
        pitcher_bb_per_9,
        venue_l14d_hrs: venue_l14d,
        venue_l14d_rank: venue_rank,
        venue_total,
        is_elite_power: isElitePower,
        confidence,
        weather_condition: weather.condition,
        weather_temp_f: weather.temp_f,
        weather_wind_mph: weather.wind_mph,
        weather_wind_dir: weather.wind_dir,
        weather_updated_at: weather.updated_at,
        weather_included: weather.adjustment.included,
        lineup_status,
      };
      target.reason_chips = pickReasonChips(target);
      target.reasons = pickReasons(target);
      return target;
    });

    targets.sort(
      (x, y) =>
        y.heat_score - x.heat_score ||
        y.season_hr - x.season_hr ||
        x.player_name.localeCompare(y.player_name),
    );
    return targets.slice(0, limit);
  }

  return games.map<HrTargetsBoard>((g) => {
    const homeFacing = {
      id: g.away_probable_pitcher_id,
      name: g.away_probable_pitcher_name ?? 'TBD',
      hand: g.away_probable_pitcher_hand ?? (g.away_probable_pitcher_id != null ? pitcherIndex.get(g.away_probable_pitcher_id)?.pitcher_throws ?? null : null),
    };
    const awayFacing = {
      id: g.home_probable_pitcher_id,
      name: g.home_probable_pitcher_name ?? 'TBD',
      hand: g.home_probable_pitcher_hand ?? (g.home_probable_pitcher_id != null ? pitcherIndex.get(g.home_probable_pitcher_id)?.pitcher_throws ?? null : null),
    };

    // Weather is per-game — compute the light adjustment once and share
    // it across both teams' targets. Optional fields on HrTargetGame
    // default to null so games without weather data stay fully neutral.
    const weatherCtx = {
      adjustment: computeWeatherAdjustment({
        condition: g.weather_condition ?? null,
        temp_f: g.weather_temp_f ?? null,
        wind_mph: g.weather_wind_mph ?? null,
        wind_dir: g.weather_wind_dir ?? null,
      }),
      condition: g.weather_condition ?? null,
      temp_f: g.weather_temp_f ?? null,
      wind_mph: g.weather_wind_mph ?? null,
      wind_dir: g.weather_wind_dir ?? null,
      updated_at: g.weather_updated_at ?? null,
    };

    // Per-game lineup context. `dead` hides postponed/cancelled games.
    const deadGame = isDeadGameStatus(g.game_status ?? null);
    const homeOrder = g.home_lineup ?? [];
    const awayOrder = g.away_lineup ?? [];
    const lineupsConfirmed = !!g.lineups_confirmed;
    const homeLineupCtx = { order: homeOrder, confirmed: lineupsConfirmed, dead: deadGame };
    const awayLineupCtx = { order: awayOrder, confirmed: lineupsConfirmed, dead: deadGame };

    return {
      game_pk: g.game_pk,
      game_date: g.game_date,
      away_team: g.away_team,
      home_team: g.home_team,
      venue_name: g.venue_name,
      away_facing: awayFacing,
      home_facing: homeFacing,
      away_targets: rankForTeam(g.away_team, g.home_team, g.venue_name, awayFacing, weatherCtx, awayLineupCtx),
      home_targets: rankForTeam(g.home_team, g.away_team, g.venue_name, homeFacing, weatherCtx, homeLineupCtx),
      weather_condition: weatherCtx.condition,
      weather_temp_f: weatherCtx.temp_f,
      weather_wind_mph: weatherCtx.wind_mph,
      weather_wind_dir: weatherCtx.wind_dir,
      weather_updated_at: weatherCtx.updated_at,
    };
  });
}

// ---------- filtering helpers ----------

export function applyFilters(
  rows: HomeRunRow[],
  opts: { team?: string; search?: string },
): HomeRunRow[] {
  const team = opts.team?.trim() ?? '';
  const search = opts.search?.trim().toLowerCase() ?? '';
  if (!team && !search) return rows;
  return rows.filter((r) => {
    if (team && r.team !== team) return false;
    if (search && !r.player_name.toLowerCase().includes(search)) return false;
    return true;
  });
}

// =====================================================================
// Backtest performance + miss analysis (task #166)
// =====================================================================

/** A single (rank_cutoff → hits / expected / lift) row. */
export interface HitRateBucket {
  /** Cutoff size (10, 25, 50, etc). */
  topN: number;
  /** Snapshot players in the top-N. May be < topN on days with few games. */
  ranked: number;
  /** Of those, how many had ≥1 HR on the date. */
  hits: number;
  /** hits / ranked. 0 when ranked = 0. */
  hit_rate: number;
  /** Expected hits in top-N if we picked players at random from the MLB-wide
   *  hitter pool (lineups across all games). This is the TRUE random baseline.
   *  = topN × (hr_hitters_total / league_hitters_estimated). */
  expected_random_hits_league: number;
  /** (hits / expected_random_hits_league) - 1. Positive = model beat random.
   *  null when expected is 0 (no HRs hit / no games). */
  lift_vs_league: number | null;
  /** Diagnostic-only: expected if we picked at random WITHIN the model's
   *  pre-filtered pool. Naturally lower lift because the pool's HR rate
   *  is already elevated. Kept for transparency, NOT the headline number. */
  expected_random_hits_pool: number;
  /** (hits / expected_random_hits_pool) - 1. Same caveats as above. */
  lift_vs_pool: number | null;
}

export interface BacktestPerformance {
  date: string;
  /** Total distinct hitters who appeared in the snapshot ranking. */
  ranked_players: number;
  /** Total distinct HR-hitters on the date (from home_runs). */
  hr_hitters_total: number;
  /** Total HRs on the date (one player can hit multiple). */
  total_hrs: number;
  /** Estimated total MLB hitters who appeared in any game on the date
   *  (= games_today × 18 starting-lineup slots). Conservative — doesn't
   *  count pinch hitters. The TRUE-random baseline divides by this. */
  league_hitters_estimated: number;
  /** Number of games used in the league estimate. */
  games_today: number;
  /** MLB-wide HR rate: hr_hitters_total / league_hitters_estimated.
   *  This is the headline "random baseline" — what a coin flip across
   *  all MLB hitters today would produce. */
  league_base_rate: number;
  /** Model-pool HR rate: hr_hitters_total / ranked_players. Naturally
   *  HIGHER than league_base_rate because the model already curated the
   *  pool down to power hitters. Shown for transparency, NOT as the
   *  baseline for lift. */
  pool_base_rate: number;
  /** One row per cutoff (10/25/50 by default). */
  buckets: HitRateBucket[];
}

/** A snapshot-shaped row (subset of HrTargetSnapshotRow that we need). */
export interface SnapshotPick {
  rank: number;
  player_id: number;
  player_name: string;
}

/** A HR row (subset). */
export interface ActualHrPick {
  player_id: number;
  player_name: string;
}

/** Starting-lineup slots per MLB game (9 batters × 2 teams, DH universal
 *  in 2026). Excludes pinch hitters / defensive replacements — a small
 *  underestimate that the user can override via `hittersPerGame`. */
export const DEFAULT_HITTERS_PER_GAME = 18;

/**
 * Compute hit-rate buckets with TWO baselines:
 *
 *   1. LEAGUE-WIDE (headline) — what a random pick from all MLB hitters
 *      today would produce. Denominator = games_today × 18.
 *   2. MODEL-POOL (diagnostic) — what a random pick from the model's
 *      curated pool would produce. Denominator = ranked_players. This
 *      always understates the model's edge because the pool already
 *      filters to power hitters.
 *
 * The user explicitly asked for the league-wide baseline as the "lift vs
 * random" headline. Both are surfaced so the UI can show both rates and
 * the note about why the pool rate is naturally higher.
 */
export function computeBacktestPerformance(
  date: string,
  snapshot: SnapshotPick[],
  actualHrs: ActualHrPick[],
  cutoffs: number[] = [10, 25, 50],
  opts: { gamesToday?: number; hittersPerGame?: number } = {},
): BacktestPerformance {
  const hittersPerGame = opts.hittersPerGame ?? DEFAULT_HITTERS_PER_GAME;
  const gamesToday = opts.gamesToday ?? 0;

  // Set of player_ids who hit ≥1 HR on the date.
  const hrPlayerIds = new Set<number>();
  for (const h of actualHrs) hrPlayerIds.add(h.player_id);

  // Snapshot sorted by rank ascending (defensive).
  const ranked = snapshot.slice().sort((a, b) => a.rank - b.rank);
  const ranked_players = ranked.length;
  const hr_hitters_total = hrPlayerIds.size;

  // ---- BASELINES ----
  const league_hitters_estimated = Math.max(gamesToday * hittersPerGame, 1);
  const league_base_rate = hr_hitters_total / league_hitters_estimated;

  const pool_denominator = Math.max(ranked_players, 1);
  const pool_base_rate = hr_hitters_total / pool_denominator;

  const buckets: HitRateBucket[] = cutoffs.map((topN) => {
    const slice = ranked.slice(0, topN);
    const sliceSize = slice.length;
    let hits = 0;
    for (const p of slice) if (hrPlayerIds.has(p.player_id)) hits++;

    const expectedLeague = topN * league_base_rate;
    const liftLeague = expectedLeague > 0 ? hits / expectedLeague - 1 : null;

    const expectedPool = topN * pool_base_rate;
    const liftPool = expectedPool > 0 ? hits / expectedPool - 1 : null;

    return {
      topN,
      ranked: sliceSize,
      hits,
      hit_rate: sliceSize > 0 ? hits / sliceSize : 0,
      expected_random_hits_league: expectedLeague,
      lift_vs_league: liftLeague,
      expected_random_hits_pool: expectedPool,
      lift_vs_pool: liftPool,
    };
  });

  return {
    date,
    ranked_players,
    hr_hitters_total,
    total_hrs: actualHrs.length,
    league_hitters_estimated,
    games_today: gamesToday,
    league_base_rate,
    pool_base_rate,
    buckets,
  };
}

/**
 * Miss analysis — players who homered on the date but ranked OUTSIDE
 * the given cutoff (default 50). For each, surface every signal we had
 * on file so the user can see what the model "passed on".
 *
 * Caller provides the live HrTarget computation for the same date so we
 * can read the rich signal block (weather/pitcher/park/recent form/etc.)
 * not just the snapshot rank.
 */
export interface MissRow {
  player_id: number;
  player_name: string;
  team: string | null;
  opponent: string | null;
  /** Rank in the snapshot. null = wasn't even in the snapshot. */
  snapshot_rank: number | null;
  /** Live HrTarget if we have one for this player today. null = no matchup found. */
  live_target: HrTarget | null;
  /** Convenience flags pulled off live_target for quick scanning. */
  signals: {
    season_hr: number;
    hrs_l7d: number;
    hr_streak: number;
    heat_score: number | null;
    is_elite_power: boolean | null;
    pitcher_l14d_allowed: number | null;
    venue_l14d_rank: number | null;
    weather_included: boolean | null;
    weather_temp_boost: number | null;
    weather_wind_boost: number | null;
  };
}

export function computeMissAnalysis(
  actualHrs: ActualHrPick[],
  snapshot: SnapshotPick[],
  liveTargets: HrTarget[],
  opts: { cutoff?: number } = {},
): MissRow[] {
  const cutoff = opts.cutoff ?? 50;
  const rankByPlayer = new Map<number, number>();
  for (const s of snapshot) rankByPlayer.set(s.player_id, s.rank);
  const liveByPlayer = new Map<number, HrTarget>();
  for (const t of liveTargets) liveByPlayer.set(t.player_id, t);

  // De-dup actual HRs by player_id (one row per player even if multi-HR game).
  const seen = new Set<number>();
  const out: MissRow[] = [];
  for (const h of actualHrs) {
    if (seen.has(h.player_id)) continue;
    seen.add(h.player_id);

    const snap = rankByPlayer.get(h.player_id) ?? null;
    if (snap != null && snap <= cutoff) continue; // not a miss — we ranked them

    const live = liveByPlayer.get(h.player_id) ?? null;
    out.push({
      player_id: h.player_id,
      player_name: h.player_name,
      team: live?.team ?? null,
      opponent: live?.opponent ?? null,
      snapshot_rank: snap,
      live_target: live,
      signals: {
        season_hr: live?.season_hr ?? 0,
        hrs_l7d: live?.hrs_l7d ?? 0,
        hr_streak: live?.hr_streak ?? 0,
        heat_score: live?.heat_score ?? null,
        is_elite_power: live?.is_elite_power ?? null,
        pitcher_l14d_allowed: live?.pitcher_l14d_allowed ?? null,
        venue_l14d_rank: live?.venue_l14d_rank ?? null,
        weather_included: live?.weather_included ?? null,
        weather_temp_boost: live?.breakdown.weather_temp_boost ?? null,
        weather_wind_boost: live?.breakdown.weather_wind_boost ?? null,
      },
    });
  }

  // Sort: players who got the FURTHEST snubbed first (high rank or null first).
  out.sort((a, b) => {
    const ra = a.snapshot_rank ?? 9999;
    const rb = b.snapshot_rank ?? 9999;
    return rb - ra;
  });
  return out;
}

// ---------------------------------------------------------------------
// Miss-row diagnostic chips (task #168)
// ---------------------------------------------------------------------
//
// Why this lives here instead of in the Backtest page: the chip rules
// are pure and easy to unit test. The page assembles a context bundle
// of game-day data (weather, opposing pitcher, odds snapshot) and calls
// this helper per miss row. Each chip carries a tone so the UI can
// color-code without a translation layer.
//
// Tones:
//   'good'    — a strong signal the model SHOULD have used (model missed)
//   'bad'     — a justifying penalty the model applied (model was right
//               by its own rules — this is the type of miss you accept)
//   'neutral' — informational context (raw outcome, pool position)
//
// Chips capped at 6 per row so the column stays scannable on mobile.

export interface MissChipContext {
  /** All HRs from a chosen anchor date back to season start, used to
   *  compute L7d / L14d / season HR per player as of the snapshot's
   *  asOf. Pass HRs with game_date ≤ (date - 1) for honest pre-game view. */
  seasonHrsByPlayer: Map<number, { game_date: string }[]>;
  /** game_pk → game-day context (weather, opposing pitcher, venue). */
  gameByPk: Map<number, {
    home_team: string;
    away_team: string;
    venue_name: string | null;
    venue_l14d_rank?: number | null;
    venue_total_ranked?: number | null;
    weather_condition: string | null;
    weather_temp_f: number | null;
    weather_wind_mph: number | null;
    weather_wind_dir: string | null;
    /** The pitcher the MISS hitter would have faced (opposite team). */
    opposing_pitcher_id: number | null;
    opposing_pitcher_name: string | null;
    opposing_pitcher_hand: string | null;
  }>;
  /** Pitcher HR-allowed lookup. Phase 1 uses the home_runs-derived L14d count. */
  pitcherL14dAllowed: Map<number, number>;
  /** player_id → batter side ('L' | 'R' | 'S' | null) from the players catalog. */
  batterSideById: Map<number, string | null>;
  /** Morning odds snapshot per player_id (if we captured one this date). */
  morningOddsByPlayer: Map<number, { american_odds: number; implied_prob: number }>;
  /** Current / latest odds snapshot per player_id. */
  latestOddsByPlayer: Map<number, { american_odds: number; implied_prob: number }>;
  /** The miss hitter's actual HRs on the date — drives Multi-HR / Distance / Hard Hit chips. */
  hrsOnDateByPlayer: Map<number, { distance: number | null; exit_velocity: number | null }[]>;
  /** Anchor date for L7d / L14d windows (typically the backtest target date). */
  date: string;
}

export interface MissChip {
  label: string;
  tone: 'good' | 'bad' | 'neutral';
  kind: string;
  detail?: string;
}

const ROOF_RX_MISS = /roof closed|dome|indoor/i;
const MAX_CHIPS_PER_ROW = 6;

export function computeMissChips(missRow: MissRow, ctx: MissChipContext): MissChip[] {
  const chips: { weight: number; chip: MissChip }[] = [];
  const date = ctx.date;
  const hrs = ctx.seasonHrsByPlayer.get(missRow.player_id) ?? [];
  const sevenStart = addDays(date, -7);
  const fourteenStart = addDays(date, -14);

  // Pre-snapshot windows: only count HRs ≤ date - 1 (don't include today's HR
  // in "recent form"; that would be circular for a backtest of what the model knew).
  const dayBefore = addDays(date, -1);
  const priorHrs = hrs.filter((h) => h.game_date <= dayBefore);
  const hrs_l7d = priorHrs.filter((h) => h.game_date >= sevenStart).length;
  const hrs_l14d = priorHrs.filter((h) => h.game_date >= fourteenStart).length;
  const season_hr = priorHrs.length;

  // Today's actual HRs for this player (could be multi-HR, distance, EV).
  const dayHrs = ctx.hrsOnDateByPlayer.get(missRow.player_id) ?? [];

  // ---- POOL POSITION (always at least one chip in this bucket) ----
  if (missRow.snapshot_rank == null) {
    chips.push({ weight: 100, chip: { kind: 'not_in_pool', label: 'Not in Model Pool', tone: 'neutral', detail: 'Player did not appear in the snapshot at all' } });
  } else if (missRow.snapshot_rank > 100) {
    chips.push({ weight: 95, chip: { kind: 'buried', label: `Buried #${missRow.snapshot_rank}`, tone: 'neutral', detail: 'Ranked deep in the pool' } });
  } else {
    chips.push({ weight: 80, chip: { kind: 'outside_top50', label: `Rank #${missRow.snapshot_rank}`, tone: 'neutral', detail: 'Just outside Top 50' } });
  }

  // ---- POWER TIER ----
  if (season_hr >= 15) {
    chips.push({ weight: 75, chip: { kind: 'big_power', label: 'Big power', tone: 'good', detail: `${season_hr} HR season` } });
  } else if (season_hr >= 8) {
    chips.push({ weight: 50, chip: { kind: 'mid_power', label: 'Mid power', tone: 'good', detail: `${season_hr} HR season` } });
  } else if (season_hr <= 4) {
    chips.push({ weight: 30, chip: { kind: 'low_power', label: 'Low season power', tone: 'bad', detail: `${season_hr} HR season — model justified passing` } });
  }

  // ---- RECENT FORM ----
  if (hrs_l7d >= 2) {
    chips.push({ weight: 70, chip: { kind: 'hot_l7d', label: 'Hot last 7d', tone: 'good', detail: `${hrs_l7d} HR in last 7 days before today` } });
  } else if (hrs_l14d >= 3) {
    chips.push({ weight: 55, chip: { kind: 'hot_l14d', label: 'Hot last 14d', tone: 'good', detail: `${hrs_l14d} HR in last 14 days before today` } });
  } else if (hrs_l7d === 0 && hrs_l14d <= 1) {
    chips.push({ weight: 60, chip: { kind: 'cold_batter', label: 'Cold batter', tone: 'bad', detail: `${hrs_l7d} HR L7d, ${hrs_l14d} HR L14d — model justified passing` } });
  } else if (hrs_l14d === 0) {
    chips.push({ weight: 65, chip: { kind: 'boom_bust', label: 'Boom/Bust', tone: 'neutral', detail: 'First HR in 14+ days — unpredictable spike' } });
  }

  // ---- GAME-DAY CONTEXT ----
  // Find the actual game from any HR row for the player today.
  const gamePk = dayHrs.length > 0 ? undefined : undefined; // we don't have game_pk on dayHrs here
  // Caller can pass game_pk via ctx if needed; for now scan gameByPk for the team match.
  let game = null as ReturnType<MissChipContext['gameByPk']['get']> | null;
  if (missRow.team) {
    for (const g of ctx.gameByPk.values()) {
      if (g.home_team === missRow.team || g.away_team === missRow.team) { game = g; break; }
    }
  }

  if (game) {
    // ---- WEATHER ----
    const cond = game.weather_condition ?? null;
    const isDome = cond != null && ROOF_RX_MISS.test(cond);
    const windDir = (game.weather_wind_dir ?? '').toLowerCase();
    const windMph = game.weather_wind_mph ?? 0;
    if (isDome) {
      chips.push({ weight: 35, chip: { kind: 'dome', label: 'Dome neutral', tone: 'neutral', detail: 'Indoors — weather not a factor' } });
    } else if (windMph >= 10 && windDir.includes('out')) {
      chips.push({ weight: 78, chip: { kind: 'wind_out', label: 'Wind Out', tone: 'good', detail: `${windMph}mph ${windDir} — favored HRs` } });
    } else if (windMph >= 10 && (windDir.includes('in from') || /\bin\b/.test(windDir))) {
      chips.push({ weight: 45, chip: { kind: 'wind_in', label: 'Wind In', tone: 'bad', detail: `${windMph}mph ${windDir} — suppressed HRs` } });
    }
    if (game.weather_temp_f != null && game.weather_temp_f >= 85) {
      chips.push({ weight: 40, chip: { kind: 'warm', label: 'Warm', tone: 'good', detail: `${game.weather_temp_f}°F` } });
    } else if (game.weather_temp_f != null && game.weather_temp_f <= 50) {
      chips.push({ weight: 25, chip: { kind: 'cold_weather', label: 'Cold weather', tone: 'bad', detail: `${game.weather_temp_f}°F` } });
    }

    // ---- PITCHER ----
    const opp_pitcher_id = game.opposing_pitcher_id;
    const opp_pitcher_hand = game.opposing_pitcher_hand;
    const allowed = opp_pitcher_id != null ? ctx.pitcherL14dAllowed.get(opp_pitcher_id) ?? 0 : 0;
    if (allowed >= 3) {
      chips.push({ weight: 85, chip: { kind: 'hr_pitcher', label: 'HR Pitcher', tone: 'good', detail: `Pitcher allowed ${allowed} HR in L14d — strong miss signal` } });
    }
    const bat_side = ctx.batterSideById.get(missRow.player_id) ?? null;
    if (bat_side && opp_pitcher_hand && bat_side === opp_pitcher_hand) {
      chips.push({ weight: 50, chip: { kind: 'reverse_split', label: 'Reverse Split', tone: 'neutral', detail: `${bat_side}HB vs ${opp_pitcher_hand}HP — same-side, model penalized` } });
    }

    // ---- PARK ----
    if (game.venue_l14d_rank != null && game.venue_l14d_rank <= 5) {
      chips.push({ weight: 70, chip: { kind: 'power_park', label: 'Power park', tone: 'good', detail: `Top ${game.venue_l14d_rank} venue in L14d HRs` } });
    } else if (game.venue_l14d_rank != null && game.venue_total_ranked != null && game.venue_l14d_rank >= game.venue_total_ranked - 4) {
      chips.push({ weight: 30, chip: { kind: 'pitchers_park', label: 'Pitcher park', tone: 'bad', detail: `Bottom-${game.venue_total_ranked - game.venue_l14d_rank + 1} venue in L14d HRs — model justified discounting` } });
    }
  } else {
    chips.push({ weight: 20, chip: { kind: 'no_game_ctx', label: 'No game context', tone: 'neutral', detail: 'Could not match player to a game on this date' } });
  }

  // ---- ODDS ----
  const morn = ctx.morningOddsByPlayer.get(missRow.player_id) ?? null;
  const latest = ctx.latestOddsByPlayer.get(missRow.player_id) ?? null;
  if (morn && latest) {
    const delta = latest.implied_prob - morn.implied_prob;
    if (delta >= 0.02) {
      chips.push({ weight: 90, chip: { kind: 'odds_steam', label: 'Odds Steam', tone: 'good', detail: `Market shortened ${(delta * 100).toFixed(1)}% from morning — sharp money agreed` } });
    } else if (delta <= -0.02) {
      chips.push({ weight: 30, chip: { kind: 'odds_drift', label: 'Odds Drift', tone: 'bad', detail: `Market drifted ${(Math.abs(delta) * 100).toFixed(1)}% — public faded` } });
    }
  }
  if (morn && morn.implied_prob <= 0.05) {
    chips.push({ weight: 25, chip: { kind: 'longshot', label: 'Long shot', tone: 'neutral', detail: `Morning implied ${(morn.implied_prob * 100).toFixed(1)}% — book agreed with model` } });
  }

  // ---- OUTCOME chips (informational, always last) ----
  if (dayHrs.length >= 2) {
    chips.push({ weight: 60, chip: { kind: 'multi_hr', label: `Multi HR (${dayHrs.length})`, tone: 'neutral', detail: 'Multiple HRs this game' } });
  }
  const maxDist = dayHrs.reduce((m, h) => Math.max(m, h.distance ?? 0), 0);
  if (maxDist >= 430) {
    chips.push({ weight: 20, chip: { kind: 'long_hr', label: `${Math.round(maxDist)} ft`, tone: 'neutral', detail: 'Long HR — raw power was there' } });
  }
  const maxEv = dayHrs.reduce((m, h) => Math.max(m, h.exit_velocity ?? 0), 0);
  if (maxEv >= 108) {
    chips.push({ weight: 20, chip: { kind: 'hard_hit', label: `${maxEv.toFixed(0)} mph EV`, tone: 'neutral', detail: 'Elite exit velocity on this HR' } });
  }

  // Sort by weight desc, de-dup by kind, cap.
  chips.sort((a, b) => b.weight - a.weight);
  const seen = new Set<string>();
  const out: MissChip[] = [];
  for (const c of chips) {
    if (seen.has(c.chip.kind)) continue;
    seen.add(c.chip.kind);
    out.push(c.chip);
    if (out.length >= MAX_CHIPS_PER_ROW) break;
  }
  return out;
}

// =====================================================================
// Task #174 (A) — Miss Pattern Analysis (aggregate / learning layer)
// =====================================================================
//
// Feeds on the per-miss chips computed by computeMissChips across MANY
// days. Answers: "which traits recur among the HR hitters the model
// ranks outside the Top 50?" High-frequency chips = patterns the current
// Heat Score systematically undervalues. This is a LEARNING tool — it
// does not change scoring.

export interface MissPatternRow {
  kind: string;
  label: string;
  tone: 'good' | 'bad' | 'neutral';
  /** How many misses carried this chip. */
  count: number;
  /** count / total_misses, 0..1. */
  frequency: number;
}

export interface MissPatternSummary {
  /** Total distinct (player, date) misses analyzed. */
  total_misses: number;
  /** Days covered. */
  days_covered: number;
  /** Chip-frequency rows, sorted by count desc. Only 'good'-toned chips
   *  are "model undervalued real edge" — those are the actionable ones,
   *  but we surface all tones so the user sees the full distribution. */
  patterns: MissPatternRow[];
  /** Players who were missed on MULTIPLE days — the strongest signal that
   *  the model has a blind spot for a specific profile. */
  repeat_offenders: { player_id: number; player_name: string; miss_days: number }[];
}

/** One day's worth of miss data fed into the aggregator. */
export interface DailyMissInput {
  date: string;
  misses: { player_id: number; player_name: string; chips: MissChip[] }[];
}

export function computeMissPatterns(days: DailyMissInput[]): MissPatternSummary {
  const chipCounts = new Map<string, { label: string; tone: 'good' | 'bad' | 'neutral'; count: number }>();
  const missDaysByPlayer = new Map<number, { name: string; days: Set<string> }>();
  let totalMisses = 0;

  for (const day of days) {
    for (const m of day.misses) {
      totalMisses++;
      // Track repeat offenders.
      let rec = missDaysByPlayer.get(m.player_id);
      if (!rec) { rec = { name: m.player_name, days: new Set() }; missDaysByPlayer.set(m.player_id, rec); }
      rec.days.add(day.date);
      // Count each chip once per miss.
      const seenKinds = new Set<string>();
      for (const c of m.chips) {
        if (seenKinds.has(c.kind)) continue;
        seenKinds.add(c.kind);
        const cur = chipCounts.get(c.kind) ?? { label: c.label, tone: c.tone, count: 0 };
        cur.count += 1;
        // Keep a representative label (labels can vary, e.g. "Buried #80");
        // prefer the shortest stable label for the kind.
        if (c.label.length < cur.label.length) cur.label = c.label;
        cur.tone = c.tone;
        chipCounts.set(c.kind, cur);
      }
    }
  }

  const patterns: MissPatternRow[] = Array.from(chipCounts.entries())
    .map(([kind, v]) => ({
      kind,
      label: v.label,
      tone: v.tone,
      count: v.count,
      frequency: totalMisses > 0 ? v.count / totalMisses : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const repeat_offenders = Array.from(missDaysByPlayer.entries())
    .map(([player_id, v]) => ({ player_id, player_name: v.name, miss_days: v.days.size }))
    .filter((r) => r.miss_days >= 2)
    .sort((a, b) => b.miss_days - a.miss_days)
    .slice(0, 15);

  return {
    total_misses: totalMisses,
    days_covered: days.length,
    patterns,
    repeat_offenders,
  };
}

// =====================================================================
// Task #174 (B) — Sleeper / Chaos / Boom-Bust discovery layer
// =====================================================================
//
// FORWARD-looking. Surfaces players OUTSIDE the core Top N whose profile
// carries volatility/upside the Heat Score underweights. Strictly
// separate from the main rankings — the core stays stable; this is a
// "go fishing here" layer. No scoring weights change.

export type SleeperCategory = 'sleeper' | 'boom_bust' | 'longshot' | 'weather';

export interface SleeperCandidate {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  /** Heat Score from the main model (unchanged). */
  heat_score: number;
  /** 1-based rank in the main board (so the user sees how buried they are). */
  heat_rank: number;
  category: SleeperCategory;
  /** 0..100 upside metric — rewards the volatility signals the Heat Score
   *  underweights. Distinct from heat_score; never feeds back into it. */
  upside_score: number;
  /** Why they surfaced. */
  tags: ReasonChip[];
  /** Book implied probability if odds were available, else null. */
  implied_prob: number | null;
  american_odds: number | null;
}

export interface SleeperBoard {
  sleepers: SleeperCandidate[];
  boomBust: SleeperCandidate[];
  longshots: SleeperCandidate[];
  weatherPlays: SleeperCandidate[];
}

export interface SleeperOddsLite {
  implied_prob: number;
  american_odds: number;
}

/**
 * Build the sleeper board from the FULL ranked target list for a date.
 *
 * @param ranked   all HrTargets for the date, sorted by heat_score desc
 * @param oddsByPlayer  player_id → latest odds (optional; enables longshots)
 * @param opts.coreSize  players ranked <= this are the "stable core" and are
 *                       EXCLUDED from the sleeper board (default 15)
 */
export function computeSleepers(
  ranked: HrTarget[],
  oddsByPlayer: Map<number, SleeperOddsLite>,
  opts: { coreSize?: number; perCategory?: number } = {},
): SleeperBoard {
  const coreSize = opts.coreSize ?? 15;
  const perCategory = opts.perCategory ?? 5;

  // Sort defensively, assign 1-based rank.
  const sorted = ranked.slice().sort((a, b) => b.heat_score - a.heat_score);
  const candidates: SleeperCandidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const rank = i + 1;
    if (rank <= coreSize) continue; // core stays stable — never a "sleeper"

    const odds = oddsByPlayer.get(t.player_id) ?? null;
    const tags: ReasonChip[] = [];
    let upside = 0;

    // --- WIND OUT (weather-enhanced) ---
    const windOut = (t.weather_wind_mph ?? 0) >= 10 && /out/.test((t.weather_wind_dir ?? '').toLowerCase());
    if (windOut) {
      upside += 16;
      tags.push({ kind: 'wind_out', label: 'Wind Out', tone: 'good', detail: `${t.weather_wind_mph}mph ${t.weather_wind_dir}` });
    }
    const warm = (t.weather_temp_f ?? 0) >= 85;
    if (warm) {
      upside += 5;
      tags.push({ kind: 'warm', label: 'Warm', tone: 'good', detail: `${t.weather_temp_f}°F` });
    }

    // --- HR PITCHER ---
    const hrPitcher = t.pitcher_l14d_allowed >= 3 || (t.pitcher_starts_known >= 3 && t.pitcher_l5_starts_allowed >= 4);
    if (hrPitcher) {
      upside += 20;
      tags.push({ kind: 'hr_pitcher', label: 'HR Pitcher', tone: 'good', detail: `Allowed ${Math.max(t.pitcher_l14d_allowed, t.pitcher_l5_starts_allowed)} HR recently` });
    }

    // --- PLATOON EDGE (opposite-hand advantage with a real sample) ---
    if (t.pitcher_hand === 'L' || t.pitcher_hand === 'R') {
      const opp = t.batter_side && t.batter_side !== t.pitcher_hand; // L vs R or R vs L
      const vsHand = t.pitcher_hand === 'L' ? t.vs_lhp_season : t.vs_rhp_season;
      if (opp && vsHand >= 3) {
        upside += 12;
        tags.push({ kind: 'platoon', label: 'Platoon Edge', tone: 'good', detail: `${t.batter_side}HB vs ${t.pitcher_hand}HP, ${vsHand} HR vs hand` });
      }
    }

    // --- POWER PARK ---
    if (t.venue_l14d_rank != null && t.venue_l14d_rank <= 5) {
      upside += 8;
      tags.push({ kind: 'power_park', label: 'Power Park', tone: 'good', detail: `Top ${t.venue_l14d_rank} venue L14d` });
    }

    // --- IMPROVING / HOT CONTACT (low season power but heating up) ---
    const improving = t.season_hr <= 8 && t.hrs_l7d >= 2;
    if (improving) {
      upside += 12;
      tags.push({ kind: 'hot_contact', label: 'Hot Contact', tone: 'good', detail: `${t.hrs_l7d} HR L7d on ${t.season_hr} season — heating up` });
    }

    // --- VOLATILE POWER (elite power gone cold = boom/bust ceiling) ---
    const volatile = t.is_elite_power && t.hrs_l7d === 0;
    if (volatile) {
      upside += 14;
      tags.push({ kind: 'volatile_power', label: 'Volatile Power', tone: 'neutral', detail: `Elite power (${t.season_hr} HR) but 0 HR L7d — high ceiling, low floor` });
    }

    // --- LONG ODDS value (book has them +500..+900 ≈ implied 10–17%) ---
    let isLongshot = false;
    if (odds) {
      const ip = odds.implied_prob;
      if (ip >= 0.10 && ip <= 0.17) {
        isLongshot = true;
        upside += 10;
        tags.push({ kind: 'long_odds', label: 'Long Odds', tone: 'good', detail: `${odds.american_odds > 0 ? '+' : ''}${odds.american_odds} (${(ip * 100).toFixed(0)}% implied)` });
      }
    }

    if (tags.length === 0) continue; // no upside signal → not a sleeper

    // ---- CATEGORIZE (single primary bucket, priority order) ----
    let category: SleeperCategory;
    if (volatile) {
      category = 'boom_bust';
      tags.push({ kind: 'boom_bust', label: 'Boom/Bust', tone: 'neutral', detail: 'High variance — feast or famine' });
    } else if (isLongshot) {
      category = 'longshot';
    } else if (windOut) {
      category = 'weather';
    } else {
      category = 'sleeper';
    }

    candidates.push({
      player_id: t.player_id,
      player_name: t.player_name,
      team: t.team,
      opponent: t.opponent,
      heat_score: t.heat_score,
      heat_rank: rank,
      category,
      upside_score: Math.min(100, Math.round(upside)),
      tags: tags.slice(0, 5),
      implied_prob: odds?.implied_prob ?? null,
      american_odds: odds?.american_odds ?? null,
    });
  }

  const byCat = (cat: SleeperCategory) =>
    candidates
      .filter((c) => c.category === cat)
      .sort((a, b) => b.upside_score - a.upside_score)
      .slice(0, perCategory);

  return {
    sleepers: byCat('sleeper'),
    boomBust: byCat('boom_bust'),
    longshots: byCat('longshot'),
    weatherPlays: byCat('weather'),
  };
}

// =====================================================================
// COLD BATTER REBOUND — discovery card for the Sleeper / Chaos area
// =====================================================================
//
// Surfaces hitters whose Cold Batter penalty is firing but who ALSO carry
// real upside signal (HR pitcher, power park, wind out, warm weather,
// platoon edge, mid power, elite power). These are players the Heat Score
// may be over-penalizing on recent form — the rebound score quantifies
// "how much upside is sitting under the cold drag."
//
// STRICT honesty rules (same as the sleeper layer):
//   • Read-only over the already-ranked HrTarget list. Does NOT mutate
//     heat_score, rank, or anything that feeds back into the core board.
//   • Filtered AFTER lineup_status filtering — postponed / not_starting
//     players never surface here either.
//   • Status display only — the user opens it as a discovery list. Nothing
//     here pushes a player into the Top 10.

export interface ColdReboundCandidate {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  /** Current Heat Score and 1-based rank in the main board so the user
   *  sees how buried the cold penalty has the player. */
  heat_score: number;
  heat_rank: number;
  /** Cold drag the model applied (always negative). The rebound score
   *  adds the absolute value back so over-penalization is visible. */
  cold_penalty: number;
  /** Sum of upside components — see computeColdBatterRebound below. */
  upside_total: number;
  /** Final rebound score = upside_total + |cold_penalty|. Higher = more
   *  signal sitting under the cold drag. */
  rebound_score: number;
  /** Reason chips: Cold Batter (bad) + each upside signal that fires. */
  tags: ReasonChip[];
  /** Book implied probability + American odds if available. */
  implied_prob: number | null;
  american_odds: number | null;
}

/**
 * Build the Cold Batter Rebound board.
 *
 * Detection criteria — player must satisfy BOTH:
 *   1) Cold Batter penalty active: hrs_l7d === 0 AND season_hr ≥ 8
 *      (mirrors the Cold chip threshold in pickReasonChips). The actual
 *      cold penalty applied is -8 (elite ≥ 12 season HR) or -4 (mid ≥ 8).
 *   2) At least ONE upside signal: HR Pitcher, Power Park, Wind Out,
 *      Warm Weather, Platoon Edge, Mid Power, or Elite Power.
 *
 * Rebound score weights (kept consistent with the sleeper layer):
 *   HR Pitcher        +20
 *   Wind Out          +14
 *   Platoon Edge      +10
 *   Power Park        +10
 *   Warm Weather      + 5
 *   Power Rating       0–20  (elite=+20, strong=+14, mid=+8, else 0)
 *   − Cold Penalty   +4 or +8 (the abs() of the model's cold drag,
 *                              added back so over-penalization is visible)
 *
 * Returns the top N (default 5) candidates sorted by rebound score desc.
 *
 * IMPORTANT: this is read-only over `ranked`. It never mutates the input
 * objects, and consumers must NOT feed this back into the core board.
 */
export function computeColdBatterRebound(
  ranked: HrTarget[],
  oddsByPlayer: Map<number, SleeperOddsLite>,
  opts: { topN?: number } = {},
): ColdReboundCandidate[] {
  const topN = opts.topN ?? 5;

  // Defensively sort by heat_score so the heat_rank we attach is correct
  // even if the caller passed an unsorted list.
  const sorted = ranked.slice().sort((a, b) => b.heat_score - a.heat_score);
  const out: ColdReboundCandidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const heatRank = i + 1;

    // -------- 1) Cold Batter penalty must be active --------
    const isCold = t.hrs_l7d === 0 && t.season_hr >= 8;
    if (!isCold) continue;
    const isEliteCold = t.season_hr >= HEAT_SCORE_STABILITY.auto_elite_hr;
    const coldPenalty = isEliteCold ? HEAT_SCORE_COLD_PENALTY.elite : HEAT_SCORE_COLD_PENALTY.mid;

    // -------- 2) Collect upside signals --------
    const tags: ReasonChip[] = [
      { kind: 'cold', label: 'Cold Batter', tone: 'bad', detail: `0 HR last 7d on ${t.season_hr} season HR` },
    ];
    let upside = 0;

    // HR Pitcher
    const havePitcherStarts = t.pitcher_starts_known >= 3;
    const hrPitcher =
      t.pitcher_l14d_allowed >= 3 ||
      (havePitcherStarts && t.pitcher_l5_starts_allowed >= 4);
    if (hrPitcher) {
      upside += 20;
      tags.push({
        kind: 'hr_pitcher',
        label: 'HR Pitcher',
        tone: 'good',
        detail: `Allowed ${Math.max(t.pitcher_l14d_allowed, t.pitcher_l5_starts_allowed)} HR recently`,
      });
    }

    // Wind Out (10+ mph, "out to" direction)
    const windMph = t.weather_wind_mph ?? 0;
    const windDir = (t.weather_wind_dir ?? '').toLowerCase();
    const windOut = windMph >= 10 && /out/.test(windDir);
    if (windOut) {
      upside += 14;
      tags.push({
        kind: 'wind_out',
        label: 'Wind Out',
        tone: 'good',
        detail: `${windMph}mph ${t.weather_wind_dir}`,
      });
    }

    // Warm Weather
    const warm = (t.weather_temp_f ?? 0) >= 85;
    if (warm) {
      upside += 5;
      tags.push({
        kind: 'warm',
        label: 'Warm',
        tone: 'good',
        detail: `${t.weather_temp_f}°F`,
      });
    }

    // Platoon Edge (opposite-hand with a real season sample)
    let platoonEdge = false;
    if (t.pitcher_hand === 'L' || t.pitcher_hand === 'R') {
      const oppHand = t.batter_side && t.batter_side !== t.pitcher_hand;
      const vsHand = t.pitcher_hand === 'L' ? t.vs_lhp_season : t.vs_rhp_season;
      if (oppHand && vsHand >= 3) {
        platoonEdge = true;
        upside += 10;
        tags.push({
          kind: 'platoon',
          label: 'Platoon Edge',
          tone: 'good',
          detail: `${t.batter_side}HB vs ${t.pitcher_hand}HP, ${vsHand} HR vs hand`,
        });
      }
    }

    // Power Park
    const powerPark = t.venue_l14d_rank != null && t.venue_l14d_rank <= 5;
    if (powerPark) {
      upside += 10;
      tags.push({
        kind: 'power_park',
        label: 'Power Park',
        tone: 'good',
        detail: `Top ${t.venue_l14d_rank} venue L14d`,
      });
    }

    // Power Rating — Elite / Strong / Mid (gradient on season_hr / elite list)
    let powerTag: ReasonChip | null = null;
    if (t.is_elite_power || t.season_hr >= 25) {
      upside += 20;
      powerTag = { kind: 'power', label: 'Elite Power', tone: 'good', detail: `${t.season_hr} season HR` };
    } else if (t.season_hr >= 15) {
      upside += 14;
      powerTag = { kind: 'power', label: 'Strong Power', tone: 'good', detail: `${t.season_hr} season HR` };
    } else if (t.season_hr >= 8) {
      upside += 8;
      powerTag = { kind: 'power', label: 'Mid Power', tone: 'good', detail: `${t.season_hr} season HR` };
    }
    if (powerTag) tags.push(powerTag);

    // -------- 3) Require ≥ 1 upside signal --------
    // tags[0] is always the Cold Batter chip, so we need at least 2.
    if (tags.length < 2) continue;
    if (upside === 0) continue;

    // -------- 4) Rebound score: upside + |cold drag| --------
    const reboundScore = upside - coldPenalty; // coldPenalty is negative → adds magnitude

    const odds = oddsByPlayer.get(t.player_id) ?? null;
    out.push({
      player_id: t.player_id,
      player_name: t.player_name,
      team: t.team,
      opponent: t.opponent,
      heat_score: t.heat_score,
      heat_rank: heatRank,
      cold_penalty: coldPenalty,
      upside_total: upside,
      rebound_score: Number(reboundScore.toFixed(1)),
      // Cap at 7 chips — Cold (always first) + all 6 possible upside
      // signals (HR Pitcher, Wind Out, Warm, Platoon, Power Park, Power).
      tags: tags.slice(0, 7),
      implied_prob: odds?.implied_prob ?? null,
      american_odds: odds?.american_odds ?? null,
    });
  }

  return out
    .sort((a, b) => b.rebound_score - a.rebound_score)
    .slice(0, topN);
}

// =====================================================================
// Consensus Picks + Market Disagreement (controlled-tuning request)
// =====================================================================
//
// We DO NOT merge sportsbook odds into the Heat Score. Instead, Consensus
// is a SEPARATE ranking that blends the two independent signals:
//   - model_prob   (sigmoid of Heat Score — what our model thinks)
//   - implied_prob (the book's price — what the market thinks)
//   - confidence   (our data-completeness tier — a light multiplier)
//
// A high consensus score means BOTH the model and the books like the
// player. Disagreement labels flag where they diverge — the value /
// sleeper / overpriced-favorite signals.

export type MarketDisagreement = 'consensus' | 'model_loves' | 'books_love';

/** Classify model-vs-market divergence. `model_loves` = model thinks the
 *  player is materially MORE likely to homer than the book's price implies
 *  (a potential value/sleeper). `books_love` = the book prices the player
 *  much higher than the model (a potential overpriced favorite). */
export function classifyMarketDisagreement(
  modelProb: number | null | undefined,
  impliedProb: number | null | undefined,
  opts: { threshold?: number } = {},
): MarketDisagreement {
  const th = opts.threshold ?? 0.06; // 6 percentage points
  if (modelProb == null || impliedProb == null) return 'consensus';
  const edge = modelProb - impliedProb;
  if (edge >= th) return 'model_loves';
  if (edge <= -th) return 'books_love';
  return 'consensus';
}

/** Human label + tone for a disagreement state. */
export function marketDisagreementLabel(d: MarketDisagreement): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  switch (d) {
    case 'model_loves': return { label: 'MODEL LOVES / BOOKS LOW', tone: 'good' };
    case 'books_love':  return { label: 'BOOKS LOVE / MODEL LOW', tone: 'bad' };
    default:            return { label: 'Consensus', tone: 'neutral' };
  }
}

/**
 * Blended consensus probability (0..1). Average of the model and market
 * probabilities, lightly scaled by confidence so thin-data rows don't
 * top the list on a fluky model number. NOT fed back into Heat Score.
 */
export function consensusScore(
  modelProb: number | null | undefined,
  impliedProb: number | null | undefined,
  confidence: 'high' | 'medium' | 'low' | null | undefined,
): number {
  if (modelProb == null || impliedProb == null) return 0;
  const confFactor = confidence === 'high' ? 1.0 : confidence === 'low' ? 0.9 : 0.95;
  return ((modelProb + impliedProb) / 2) * confFactor;
}

// =====================================================================
// Certified Sleeper / Smart Money board (task #177)
// =====================================================================
//
// A CURATED subsection of the Sleeper layer — the "serious sleeper card"
// area. Far stricter than the chaos/longshot lists: only confirmed
// starters with medium+ confidence and STACKED positive signals (≥2,
// with ≥1 strong) survive, and players in bad matchup/weather spots are
// rejected. Prefers odds value but doesn't require it.
//
// This never feeds back into Heat Score. It's a filter + presentation
// layer on top of the existing model output.

/** Local sigmoid (mirrors oddsMath.heatScoreToModelProb) so this module
 *  stays self-contained and doesn't cross-import. Keep in sync. */
function heatToModelProbLocal(heat: number | null | undefined): number {
  if (heat == null || !Number.isFinite(heat)) return 0.005;
  const floor = 0.005, ceiling = 0.30, midpoint = 55, slope = 10;
  const s = 1 / (1 + Math.exp(-((heat - midpoint) / slope)));
  return floor + (ceiling - floor) * s;
}

export type CertifiedMarketSignal = 'model_loves' | 'books_love' | 'consensus' | 'quiet_value';

export interface CertifiedSleeper {
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  heat_score: number;
  heat_rank: number;
  confidence: 'high' | 'medium' | 'low';
  upside_score: number;
  /** Why it qualified — Wind Out, HR Pitcher, Odds Value, etc. */
  tags: ReasonChip[];
  /** Market-vs-model read for the badge. */
  market_signal: CertifiedMarketSignal;
  /** One-line plain-English summary for the card. */
  explanation: string;
  implied_prob: number | null;
  american_odds: number | null;
  model_prob: number | null;
}

export function computeCertifiedSleepers(
  ranked: HrTarget[],
  oddsByPlayer: Map<number, SleeperOddsLite>,
  opts: { max?: number } = {},
): CertifiedSleeper[] {
  const max = opts.max ?? 6;
  const sorted = ranked.slice().sort((a, b) => b.heat_score - a.heat_score);

  const out: { weight: number; pick: CertifiedSleeper }[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const rank = i + 1;

    // ---- HARD GATES ----
    // 1. Must be a confirmed starter (no pending/not-starting/postponed).
    if (t.lineup_status !== 'confirmed') continue;
    // 2. Medium or high confidence only.
    if (t.confidence === 'low') continue;

    const odds = oddsByPlayer.get(t.player_id) ?? null;
    const tags: ReasonChip[] = [];
    let upside = 0;
    let strongSignals = 0;

    // ---- DISQUALIFIERS (bad matchup / weather) ----
    const windDir = (t.weather_wind_dir ?? '').toLowerCase();
    const windMph = t.weather_wind_mph ?? 0;
    const strongWindIn = windMph >= 10 && (windDir.includes('in from') || /\bin\b/.test(windDir));
    if (strongWindIn) continue; // wind blowing in hard — reject
    const dominantPitcher =
      t.pitcher_k_per_9 != null && t.pitcher_starts_known >= 3 &&
      t.pitcher_k_per_9 >= 11 && t.pitcher_l5_starts_allowed <= 1;
    if (dominantPitcher) continue; // ace shutting down HRs — reject
    // Volatile cold-elite belongs in Boom/Bust, not the "trustworthy" board.
    if (t.is_elite_power && t.hrs_l7d === 0) continue;

    // ---- POSITIVE SIGNALS (stacking) ----
    const windOut = windMph >= 10 && windDir.includes('out');
    if (windOut) { upside += 16; strongSignals++; tags.push({ kind: 'wind_out', label: 'Wind Out', tone: 'good', detail: `${windMph}mph ${t.weather_wind_dir}` }); }
    if ((t.weather_temp_f ?? 0) >= 85) { upside += 5; tags.push({ kind: 'warm', label: 'Warm Weather', tone: 'good', detail: `${t.weather_temp_f}°F` }); }

    const hrPitcher = t.pitcher_l14d_allowed >= 3 || (t.pitcher_starts_known >= 3 && t.pitcher_l5_starts_allowed >= 4);
    if (hrPitcher) { upside += 20; strongSignals++; tags.push({ kind: 'hr_pitcher', label: 'HR Pitcher', tone: 'good', detail: `Allowed ${Math.max(t.pitcher_l14d_allowed, t.pitcher_l5_starts_allowed)} HR recently` }); }

    if (t.pitcher_hand === 'L' || t.pitcher_hand === 'R') {
      const oppHand = t.batter_side && t.batter_side !== t.pitcher_hand;
      const vsHand = t.pitcher_hand === 'L' ? t.vs_lhp_season : t.vs_rhp_season;
      if (oppHand && vsHand >= 3) { upside += 12; tags.push({ kind: 'platoon', label: 'Platoon Edge', tone: 'good', detail: `${t.batter_side}HB vs ${t.pitcher_hand}HP, ${vsHand} HR vs hand` }); }
    }
    if (t.venue_l14d_rank != null && t.venue_l14d_rank <= 5) { upside += 8; tags.push({ kind: 'power_park', label: 'Power Park', tone: 'good', detail: `Top ${t.venue_l14d_rank} venue L14d` }); }
    if (t.season_hr <= 8 && t.hrs_l7d >= 2) { upside += 12; tags.push({ kind: 'hot_contact', label: 'Hot Contact', tone: 'good', detail: `${t.hrs_l7d} HR L7d on ${t.season_hr} season` }); }
    if (t.hrs_l7d >= 2 && t.season_hr >= 12) { upside += 10; strongSignals++; tags.push({ kind: 'hot7', label: 'Hot last 7d', tone: 'good', detail: `${t.hrs_l7d} HR L7d` }); }

    // ---- ODDS-DERIVED SIGNALS ----
    const model_prob = heatToModelProbLocal(t.heat_score);
    let market_signal: CertifiedMarketSignal = 'quiet_value';
    if (odds) {
      const ip = odds.implied_prob;
      const edge = model_prob - ip;
      if (ip >= 0.10 && ip <= 0.17) { upside += 10; tags.push({ kind: 'odds_value', label: 'Odds Value', tone: 'good', detail: `${odds.american_odds > 0 ? '+' : ''}${odds.american_odds} (${(ip * 100).toFixed(0)}% implied)` }); }
      if (edge >= 0.06) { upside += 14; strongSignals++; tags.push({ kind: 'strong_ev', label: 'Strong EV', tone: 'good', detail: `Model ${(model_prob * 100).toFixed(0)}% vs book ${(ip * 100).toFixed(0)}%` }); market_signal = 'model_loves'; }
      else if (edge <= -0.06) market_signal = 'books_love';
      else market_signal = 'consensus';
      // Market-disagreement chip when model & books diverge.
      if (market_signal === 'model_loves') tags.push({ kind: 'market_disagree', label: 'Market Disagreement', tone: 'good', detail: 'Model materially higher than the book price' });
    }

    // ---- CERTIFICATION RULES ----
    // ≥2 distinct positive signals AND ≥1 strong signal (no single weak factor).
    if (tags.length < 2) continue;
    if (strongSignals < 1) continue;

    // Composite ranking weight — confidence + odds edge + upside.
    const confBonus = t.confidence === 'high' ? 10 : 5;
    const evBonus = market_signal === 'model_loves' ? 12 : 0;
    const weight = upside + confBonus + evBonus;

    out.push({
      weight,
      pick: {
        player_id: t.player_id,
        player_name: t.player_name,
        team: t.team,
        opponent: t.opponent,
        heat_score: t.heat_score,
        heat_rank: rank,
        confidence: t.confidence,
        upside_score: Math.min(100, Math.round(upside)),
        tags: tags.slice(0, 5),
        market_signal,
        explanation: buildCertifiedExplanation(tags, t.confidence, market_signal),
        implied_prob: odds?.implied_prob ?? null,
        american_odds: odds?.american_odds ?? null,
        model_prob,
      },
    });
  }

  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, max).map((x) => x.pick);
}

/** Plain-English one-liner for a certified card. */
function buildCertifiedExplanation(
  tags: ReasonChip[],
  confidence: 'high' | 'medium' | 'low',
  market: CertifiedMarketSignal,
): string {
  const n = tags.length;
  const hasOdds = tags.some((t) => t.kind === 'odds_value' || t.kind === 'strong_ev');
  const oddsPhrase = market === 'model_loves'
    ? 'plus a model edge over the book price'
    : hasOdds
    ? 'with some odds value'
    : market === 'quiet_value'
    ? 'with the market quiet (no posted line)'
    : 'priced in line with the market';
  return `${n} favorable signal${n === 1 ? '' : 's'} stacked on a confirmed lineup, ${confidence} confidence, ${oddsPhrase}.`;
}

/** Badge label + tone for a certified pick's market signal. */
export function certifiedMarketLabel(s: CertifiedMarketSignal): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  switch (s) {
    case 'model_loves': return { label: 'MODEL LOVES / BOOKS LOW', tone: 'good' };
    case 'books_love':  return { label: 'BOOKS LOVE / MODEL LOW', tone: 'bad' };
    case 'consensus':   return { label: 'Consensus Pick', tone: 'neutral' };
    case 'quiet_value': return { label: 'Quiet Value', tone: 'neutral' };
  }
}

// =====================================================================
// Top 10 flat-bet simulation (task #178)
// =====================================================================
//
// "If you blindly bet the model's saved Top 10 every day at a flat +200,
//  would you be ahead?" Pure aggregation over saved snapshots + actual
//  HRs. Standardized +200 (win = +$2, loss = -$1, $1 stake each) — NOT
//  real sportsbook pricing. No bet sizing, no chase logic.

export interface FlatBetPeriod {
  /** Total Top-10 bets placed in the period (≤10 per day). */
  bets: number;
  wins: number;
  losses: number;
  /** wins×2 − losses×1, in dollars at $1 stake. */
  net: number;
  /** net / total_risk (total_risk = bets × $1). 0 when no bets. */
  roi: number;
  /** Distinct game-dates that contributed (had a snapshot + results). */
  days: number;
}

export interface FlatBetSim {
  today: FlatBetPeriod;
  mtd: FlatBetPeriod;
  ytd: FlatBetPeriod;
}

const FLAT_WIN_PROFIT = 2;  // +200 → $2 per $1
const FLAT_LOSS = 1;

function emptyPeriod(): FlatBetPeriod {
  return { bets: 0, wins: 0, losses: 0, net: 0, roi: 0, days: 0 };
}

/**
 * @param date            the as-of date (YYYY-MM-DD); "today" period = this date
 * @param top10ByDate     date → player_ids ranked in the saved Top 10
 * @param hrPlayersByDate date → set of player_ids who homered that date
 */
export function computeFlatBetSim(
  date: string,
  top10ByDate: Map<string, number[]>,
  hrPlayersByDate: Map<string, Set<number>>,
): FlatBetSim {
  const monthStart = `${date.slice(0, 7)}-01`;
  const yearStart = `${date.slice(0, 4)}-01-01`;

  const today = emptyPeriod();
  const mtd = emptyPeriod();
  const ytd = emptyPeriod();

  for (const [d, ids] of top10ByDate) {
    // Only count dates up to and including the as-of date.
    if (d > date) continue;
    const hrSet = hrPlayersByDate.get(d) ?? new Set<number>();
    let wins = 0;
    for (const id of ids) if (hrSet.has(id)) wins++;
    const bets = ids.length;
    const losses = bets - wins;
    const net = wins * FLAT_WIN_PROFIT - losses * FLAT_LOSS;

    const add = (p: FlatBetPeriod) => {
      p.bets += bets; p.wins += wins; p.losses += losses; p.net += net; p.days += 1;
    };
    if (d >= yearStart) add(ytd);
    if (d >= monthStart) add(mtd);
    if (d === date) add(today);
  }

  for (const p of [today, mtd, ytd]) {
    p.roi = p.bets > 0 ? p.net / p.bets : 0;
  }
  return { today, mtd, ytd };
}

// =============================================================================
//  Reverse-Engineering Analysis (task #179)
// -----------------------------------------------------------------------------
//  Take the last 14 days of saved snapshots + actual HR results and back out:
//    1) per-signal hit rate (present vs absent), lift vs baseline, sample size
//    2) most predictive positive / negative signals
//    3) pair + selected triple combinations that outperform individuals
//    4) "Top 10 Optimizer" — directional + grid-searched weight nudges
//
//  STRICT honesty rules:
//    • Signals are detected from the saved snapshot.reason text (the same
//      chip labels the user already sees). No re-derivation from raw fields —
//      that risks drift from what the model actually told the user that day.
//    • The grid optimizer perturbs the SAVED heat_score by Δ_signal × signal
//      and re-ranks. It is a sensitivity approximation, NOT a full re-run of
//      computeHrTargets — the panel UI must say so. Useful for direction +
//      magnitude, not for replacing weights blindly.
//    • Recommendations are SURFACED ONLY. Nothing in this module mutates
//      HEAT_SCORE_WEIGHTS or any other knob.
// =============================================================================

/** Stable identifiers for every signal we analyze. */
export type SignalKey =
  | 'hr_pitcher'        // Weak HR pitcher
  | 'power_park'        // Park boost
  | 'wind_out'          // Wind boost (favorable)
  | 'wind_in'           // Wind in (unfavorable)
  | 'warm_weather'      // Warm (≥85°F)
  | 'hot_l7d'           // Hot last 7d
  | 'hr_streak'         // back-to-back days OR multi-day streak
  | 'platoon_edge'      // Good vs LHP/RHP
  | 'elite_power'       // Elite power (≥25 season HR)
  | 'mid_power'         // Mid-tier power (≥8 season HR)
  | 'low_season_power'  // derived: no power chip present at all
  | 'cold_batter'       // Cold last 7d
  | 'pitcher_dominant'; // Dominant pitcher (negative)

const SIGNAL_LABELS: Record<SignalKey, string> = {
  hr_pitcher: 'HR Pitcher',
  power_park: 'Power Park',
  wind_out: 'Wind Out',
  wind_in: 'Wind In',
  warm_weather: 'Warm Weather',
  hot_l7d: 'Hot Last 7d',
  hr_streak: 'HR Streak',
  platoon_edge: 'Platoon Edge',
  elite_power: 'Elite Power',
  mid_power: 'Mid Power',
  low_season_power: 'Low Season Power',
  cold_batter: 'Cold Batter',
  pitcher_dominant: 'Dominant Pitcher',
};

/** Conventional polarity used for ranking/sorting. */
const SIGNAL_POLARITY: Record<SignalKey, 'positive' | 'negative'> = {
  hr_pitcher: 'positive',
  power_park: 'positive',
  wind_out: 'positive',
  wind_in: 'negative',
  warm_weather: 'positive',
  hot_l7d: 'positive',
  hr_streak: 'positive',
  platoon_edge: 'positive',
  elite_power: 'positive',
  mid_power: 'positive',
  low_season_power: 'negative',
  cold_batter: 'negative',
  pitcher_dominant: 'negative',
};

/**
 * Decode the set of signals present for a snapshot row from its `reason`
 * text. The snapshotter joins reason chips with ' · ' and each chip is
 * "Label — detail". We substring-match by chip label, identical to what
 * pickReasonChips() emits in src/lib/stats.ts.
 *
 * `low_season_power` is *derived* — it fires when no power chip is present
 * at all (the player is in the snapshot but had no Elite/Strong/Mid power
 * signal that day).
 */
export function parseSignalsFromReason(reason: string | null): Set<SignalKey> {
  const set = new Set<SignalKey>();
  if (!reason) {
    set.add('low_season_power');
    return set;
  }
  if (/Weak HR pitcher/i.test(reason)) set.add('hr_pitcher');
  if (/Park boost/i.test(reason)) set.add('power_park');
  if (/Wind boost/i.test(reason)) set.add('wind_out');
  if (/Wind in/i.test(reason)) set.add('wind_in');
  // "Warm" needs anchoring so it doesn't catch e.g. "Warming" in future chips.
  if (/(^|\s|·)Warm( |—|·|$)/i.test(reason)) set.add('warm_weather');
  if (/Hot last 7d/i.test(reason)) set.add('hot_l7d');
  if (/HR streak|Back-to-back days/i.test(reason)) set.add('hr_streak');
  if (/Good vs [LR]HP/i.test(reason)) set.add('platoon_edge');
  if (/Elite power/i.test(reason)) set.add('elite_power');
  if (/Mid-tier power/i.test(reason)) set.add('mid_power');
  if (/Cold last 7d/i.test(reason)) set.add('cold_batter');
  if (/Dominant pitcher/i.test(reason)) set.add('pitcher_dominant');
  // Derived: no power chip → low season power
  const hasAnyPower =
    /Elite power|Strong power|Mid-tier power/i.test(reason);
  if (!hasAnyPower) set.add('low_season_power');
  return set;
}

/** Minimal snapshot row shape for reverse analysis — keeps the function
 *  importable into both the browser bundle and any tsx test script. */
export interface RevAnalysisSnapshotRow {
  target_date: string;
  player_id: number;
  /** Display name — optional so analysis-only callers can omit. Required
   *  for the Simulated Top-10 section to render names instead of IDs. */
  player_name?: string;
  team?: string;
  rank: number;
  heat_score: number;
  reason: string | null;
}

/** Per-signal hit rate + lift. */
export interface RevSignalRow {
  key: SignalKey;
  label: string;
  polarity: 'positive' | 'negative';
  /** Players the signal was present on, across the window. */
  present_n: number;
  present_hits: number;
  present_rate: number;
  absent_n: number;
  absent_hits: number;
  absent_rate: number;
  /** present_rate / baseline_rate. 1.0 = neutral, >1 predictive +, <1 predictive −. */
  lift: number;
  /** present_rate − absent_rate, in absolute terms. */
  delta: number;
  sample_quality: 'high' | 'medium' | 'low';
}

/** Combination of 2+ signals analyzed jointly. */
export interface RevComboRow {
  keys: SignalKey[];
  labels: string[];
  present_n: number;
  present_hits: number;
  present_rate: number;
  lift: number;
  /** Lift of each individual signal in this combo for comparison. */
  individual_lifts: number[];
  /** True iff combo lift exceeds the max individual lift by ≥ 10%. */
  outperforms_individual: boolean;
  sample_quality: 'high' | 'medium' | 'low';
}

/** Tunable knob the directional optimizer can suggest moving. Always read
 *  in the panel as a hint — the code never auto-applies. */
export type OptimizerKnob =
  | 'WEIGHTS.pitcher'
  | 'WEIGHTS.park'
  | 'WEIGHTS.l7d'
  | 'WEIGHTS.hand'
  | 'COLD_PENALTY.elite'
  | 'COLD_PENALTY.mid'
  | 'LOW_POWER_CAP.cap';

export interface RevDirectional {
  knob: OptimizerKnob;
  /** The signal whose performance drives this recommendation. */
  driver_signal: SignalKey;
  current_value: number;
  suggested_value: number;
  direction: 'increase' | 'decrease' | 'hold';
  /** "Magnitude" of the change as a percentage of the current value. */
  magnitude_pct: number;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

export interface RevGridChange {
  knob: OptimizerKnob;
  signal: SignalKey;
  delta: number;
}

export interface RevGridResult {
  baseline_top10_hit_rate: number;
  best_top10_hit_rate: number;
  estimated_lift: number;
  /** Empty when no perturbation beats baseline by ≥ 1 percentage point. */
  changes: RevGridChange[];
  /** Number of dated buckets contributing to the grid search. */
  days: number;
  note: string;
}

export interface ReverseAnalysisResult {
  window_days: number;
  total_player_days: number;
  total_hr_player_days: number;
  baseline_rate: number;
  signals: RevSignalRow[];
  top_positive: RevSignalRow[];
  top_negative: RevSignalRow[];
  pair_combos: RevComboRow[];
  triple_combos: RevComboRow[];
  directional: RevDirectional[];
  grid: RevGridResult;
}

function sampleQuality(n: number): 'high' | 'medium' | 'low' {
  if (n >= 100) return 'high';
  if (n >= 30) return 'medium';
  return 'low';
}

function signalRow(
  key: SignalKey,
  present_n: number,
  present_hits: number,
  absent_n: number,
  absent_hits: number,
  baseline: number,
): RevSignalRow {
  const present_rate = present_n > 0 ? present_hits / present_n : 0;
  const absent_rate = absent_n > 0 ? absent_hits / absent_n : 0;
  const lift = baseline > 0 ? present_rate / baseline : 0;
  return {
    key,
    label: SIGNAL_LABELS[key],
    polarity: SIGNAL_POLARITY[key],
    present_n,
    present_hits,
    present_rate,
    absent_n,
    absent_hits,
    absent_rate,
    lift,
    delta: present_rate - absent_rate,
    sample_quality: sampleQuality(present_n),
  };
}

function comboRow(
  keys: SignalKey[],
  presentRows: { hit: boolean }[],
  baseline: number,
  signalLiftByKey: Map<SignalKey, number>,
): RevComboRow {
  const present_n = presentRows.length;
  const present_hits = presentRows.reduce((s, r) => s + (r.hit ? 1 : 0), 0);
  const present_rate = present_n > 0 ? present_hits / present_n : 0;
  const lift = baseline > 0 ? present_rate / baseline : 0;
  const individual_lifts = keys.map((k) => signalLiftByKey.get(k) ?? 0);
  const maxIndividual = individual_lifts.length > 0 ? Math.max(...individual_lifts) : 0;
  return {
    keys,
    labels: keys.map((k) => SIGNAL_LABELS[k]),
    present_n,
    present_hits,
    present_rate,
    lift,
    individual_lifts,
    outperforms_individual: lift >= maxIndividual * 1.1 && lift > 1,
    sample_quality: sampleQuality(present_n),
  };
}

/** Build a per-knob directional recommendation from one signal's lift. */
function directionalFor(opts: {
  knob: OptimizerKnob;
  driver: SignalKey;
  current: number;
  signalRow: RevSignalRow | undefined;
  /** Inverted means "this knob is a PENALTY; lift<1 should INCREASE penalty
   *  magnitude". For positive-weight knobs, lift>1 means INCREASE weight. */
  inverted?: boolean;
  capPct?: number; // cap suggested change at ±capPct% of |current|
}): RevDirectional {
  const sig = opts.signalRow;
  const capPct = opts.capPct ?? 0.5;
  const fallback: RevDirectional = {
    knob: opts.knob,
    driver_signal: opts.driver,
    current_value: opts.current,
    suggested_value: opts.current,
    direction: 'hold',
    magnitude_pct: 0,
    confidence: 'low',
    rationale: 'Insufficient signal sample to recommend a change.',
  };
  if (!sig || sig.present_n < 20) return fallback;
  const lift = sig.lift;
  // Map lift → magnitude scale. Neutral band 0.85–1.15 → no change.
  const NEUTRAL_LO = 0.85;
  const NEUTRAL_HI = 1.15;
  if (lift >= NEUTRAL_LO && lift <= NEUTRAL_HI) {
    return {
      ...fallback,
      confidence: sig.sample_quality,
      rationale: `Lift ${lift.toFixed(2)} is within the neutral band [${NEUTRAL_LO}, ${NEUTRAL_HI}] — current weight looks well-calibrated.`,
    };
  }
  // Suggested fractional change scales with log-lift, clamped.
  const rawPct = Math.max(-capPct, Math.min(capPct, Math.log(Math.max(0.2, lift))));
  let direction: 'increase' | 'decrease' = lift > 1 ? 'increase' : 'decrease';
  if (opts.inverted) direction = lift > 1 ? 'decrease' : 'increase';
  const abs = Math.abs(opts.current);
  // "increase" always means "increase MAGNITUDE of this knob's effect" —
  // so for negative penalty knobs we move further negative, not toward 0.
  const magnitudeSign = Math.sign(opts.current) || 1;
  const moveDir = direction === 'increase' ? 1 : -1;
  // Always move at least ±10% of magnitude when outside the neutral band.
  const stepPct = Math.max(0.1, Math.abs(rawPct));
  const suggested = opts.current + moveDir * magnitudeSign * stepPct * abs;
  return {
    knob: opts.knob,
    driver_signal: opts.driver,
    current_value: opts.current,
    suggested_value: Number(suggested.toFixed(2)),
    direction,
    magnitude_pct: Number((stepPct * 100).toFixed(0)),
    confidence: sig.sample_quality,
    rationale: `Signal lift = ${lift.toFixed(2)} on n=${sig.present_n}. ` +
      `Players with "${SIGNAL_LABELS[opts.driver]}" homered ${(sig.present_rate * 100).toFixed(1)}% ` +
      `vs ${(sig.absent_rate * 100).toFixed(1)}% without (baseline ${(opts.signalRow?.lift && (sig.present_rate / sig.lift)) ? '' : ''}).`,
  };
}

/**
 * Grid-search a small set of per-signal heat-score perturbations and pick
 * the combination that maximizes Top-10 hit rate over the window.
 *
 * NOTE: this is a sensitivity approximation. We add Δ_signal directly to
 * the saved heat_score whenever the signal is present, then re-rank per
 * date. We do NOT recompute the full scoring pipeline (saturation, ceiling
 * compression, completeness multiplier). Use this for direction only —
 * not as a finished proposal.
 */
function gridSearch(
  byDate: Map<string, { player_id: number; heat_score: number; signals: Set<SignalKey>; hit: boolean }[]>,
): RevGridResult {
  // Knobs we perturb. (knob, signal, sign).
  // sign=+1 means "Δ raises score when signal present" (reward signal).
  // sign=−1 means "Δ lowers score when signal present" (penalty signal).
  const perturbations: { knob: OptimizerKnob; signal: SignalKey; sign: 1 | -1 }[] = [
    { knob: 'WEIGHTS.pitcher', signal: 'hr_pitcher', sign: 1 },
    { knob: 'WEIGHTS.park', signal: 'power_park', sign: 1 },
    { knob: 'WEIGHTS.l7d', signal: 'hot_l7d', sign: 1 },
    { knob: 'COLD_PENALTY.elite', signal: 'cold_batter', sign: -1 },
  ];
  const STEPS = [0, 2, 4]; // small steps keep the search honest

  const days = byDate.size;
  if (days === 0) {
    return {
      baseline_top10_hit_rate: 0,
      best_top10_hit_rate: 0,
      estimated_lift: 0,
      changes: [],
      days: 0,
      note: 'No snapshot/HR data in window — grid skipped.',
    };
  }

  const score = (deltas: number[]): { hits: number; bets: number } => {
    let hits = 0;
    let bets = 0;
    for (const rows of byDate.values()) {
      // Modify each player's score, re-rank, take top 10.
      const modified = rows.map((r) => {
        let s = r.heat_score;
        for (let i = 0; i < perturbations.length; i++) {
          const p = perturbations[i];
          if (r.signals.has(p.signal)) s += p.sign * deltas[i];
        }
        return { id: r.player_id, score: s, hit: r.hit };
      });
      modified.sort((a, b) => b.score - a.score);
      const top10 = modified.slice(0, 10);
      for (const t of top10) {
        bets++;
        if (t.hit) hits++;
      }
    }
    return { hits, bets };
  };

  const baseline = score([0, 0, 0, 0]);
  const baselineRate = baseline.bets > 0 ? baseline.hits / baseline.bets : 0;

  let best = baselineRate;
  let bestDeltas = [0, 0, 0, 0];
  // 3^4 = 81 evals.
  for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const d of STEPS) {
    if (a === 0 && b === 0 && c === 0 && d === 0) continue;
    const { hits, bets } = score([a, b, c, d]);
    const rate = bets > 0 ? hits / bets : 0;
    if (rate > best) {
      best = rate;
      bestDeltas = [a, b, c, d];
    }
  }

  const changes: RevGridChange[] = [];
  // Only surface changes when best beats baseline by ≥ 1 pct point.
  const beatsBaseline = best - baselineRate >= 0.01;
  if (beatsBaseline) {
    for (let i = 0; i < perturbations.length; i++) {
      if (bestDeltas[i] !== 0) {
        // Show the sign as it applies to the KNOB, not the score.
        const knobDelta = perturbations[i].sign * bestDeltas[i];
        changes.push({
          knob: perturbations[i].knob,
          signal: perturbations[i].signal,
          delta: knobDelta,
        });
      }
    }
  }

  return {
    baseline_top10_hit_rate: baselineRate,
    best_top10_hit_rate: best,
    estimated_lift: best - baselineRate,
    changes,
    days,
    note: beatsBaseline
      ? 'Sensitivity grid — Δ added directly to saved heat_score, then re-ranked. Not a full re-score.'
      : 'No perturbation in the search beat baseline by ≥1 pct pt. Current weights look well-calibrated for this window.',
  };
}

/**
 * @param snapshots     all snapshot rows in the window (any rank)
 * @param hrPlayersByDate game_date → set of player_ids who homered that date
 * @param weights       current HEAT_SCORE_WEIGHTS (passed so the panel can
 *                      surface "current value" honestly without re-importing)
 */
export function computeReverseAnalysis(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  weights: {
    pitcher: number;
    park: number;
    l7d: number;
    hand: number;
    coldElite: number;
    coldMid: number;
    lowPowerCap: number;
  },
): ReverseAnalysisResult {
  // ----- 1) Build the per-player-day signal/hit dataset.
  type Row = { date: string; player_id: number; heat_score: number; signals: Set<SignalKey>; hit: boolean };
  const rows: Row[] = [];
  const byDate = new Map<string, Row[]>();
  let totalHits = 0;

  for (const snap of snapshots) {
    const hrSet = hrPlayersByDate.get(snap.target_date) ?? new Set<number>();
    const hit = hrSet.has(snap.player_id);
    const signals = parseSignalsFromReason(snap.reason);
    const row: Row = {
      date: snap.target_date,
      player_id: snap.player_id,
      heat_score: snap.heat_score,
      signals,
      hit,
    };
    rows.push(row);
    if (hit) totalHits++;
    const arr = byDate.get(snap.target_date);
    if (arr) arr.push(row); else byDate.set(snap.target_date, [row]);
  }

  const totalN = rows.length;
  const baseline = totalN > 0 ? totalHits / totalN : 0;

  // ----- 2) Per-signal stats.
  const allSignals: SignalKey[] = [
    'hr_pitcher', 'power_park', 'wind_out', 'wind_in', 'warm_weather',
    'hot_l7d', 'hr_streak', 'platoon_edge', 'elite_power', 'mid_power',
    'low_season_power', 'cold_batter', 'pitcher_dominant',
  ];
  const signalRows: RevSignalRow[] = [];
  const signalLiftByKey = new Map<SignalKey, number>();
  for (const k of allSignals) {
    let pn = 0, ph = 0, an = 0, ah = 0;
    for (const r of rows) {
      if (r.signals.has(k)) { pn++; if (r.hit) ph++; }
      else { an++; if (r.hit) ah++; }
    }
    const sr = signalRow(k, pn, ph, an, ah, baseline);
    signalRows.push(sr);
    signalLiftByKey.set(k, sr.lift);
  }

  // Rank by lift, ignoring signals with present_n < 20.
  const ranked = signalRows.filter((s) => s.present_n >= 20).slice().sort((a, b) => b.lift - a.lift);
  const top_positive = ranked.filter((s) => s.lift > 1).slice(0, 5);
  const top_negative = ranked.filter((s) => s.lift < 1).slice().reverse().slice(0, 5);

  // ----- 3) Pair + triple combos.
  // Pairs: user-explicit + top combinations from highest-lift signals.
  const explicitPairs: SignalKey[][] = [
    ['hr_pitcher', 'power_park'],
    ['wind_out', 'platoon_edge'],
    ['hot_l7d', 'hr_pitcher'],
    ['elite_power', 'warm_weather'],
  ];
  const explicitTriples: SignalKey[][] = [
    ['hr_pitcher', 'power_park', 'hot_l7d'],
    ['elite_power', 'hr_pitcher', 'wind_out'],
    ['hot_l7d', 'platoon_edge', 'power_park'],
    ['elite_power', 'warm_weather', 'power_park'],
  ];

  // Auto-generated pairs from top 6 by lift (positive only, n≥20).
  const topPosKeys = ranked.filter((s) => s.lift > 1).slice(0, 6).map((s) => s.key);
  const autoPairs: SignalKey[][] = [];
  for (let i = 0; i < topPosKeys.length; i++) {
    for (let j = i + 1; j < topPosKeys.length; j++) {
      autoPairs.push([topPosKeys[i], topPosKeys[j]]);
    }
  }
  // Dedup pairs (treating order-agnostic).
  const seenPair = new Set<string>();
  const pairKey = (ks: SignalKey[]) => [...ks].sort().join('|');
  const pairsToTry: SignalKey[][] = [];
  for (const p of [...explicitPairs, ...autoPairs]) {
    const k = pairKey(p);
    if (seenPair.has(k)) continue;
    seenPair.add(k);
    pairsToTry.push(p);
  }

  const evalCombo = (keys: SignalKey[]): RevComboRow => {
    const matching = rows.filter((r) => keys.every((k) => r.signals.has(k)));
    return comboRow(keys, matching.map((r) => ({ hit: r.hit })), baseline, signalLiftByKey);
  };

  const pair_combos = pairsToTry
    .map(evalCombo)
    .filter((c) => c.present_n >= 10)            // require minimum support
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 8);

  const triple_combos = explicitTriples
    .map(evalCombo)
    .filter((c) => c.present_n >= 5)
    .sort((a, b) => b.lift - a.lift);

  // ----- 4) Directional optimizer.
  const findSig = (k: SignalKey) => signalRows.find((s) => s.key === k);
  const directional: RevDirectional[] = [
    directionalFor({ knob: 'WEIGHTS.pitcher', driver: 'hr_pitcher', current: weights.pitcher, signalRow: findSig('hr_pitcher') }),
    directionalFor({ knob: 'WEIGHTS.park', driver: 'power_park', current: weights.park, signalRow: findSig('power_park') }),
    directionalFor({ knob: 'WEIGHTS.l7d', driver: 'hot_l7d', current: weights.l7d, signalRow: findSig('hot_l7d') }),
    directionalFor({ knob: 'WEIGHTS.hand', driver: 'platoon_edge', current: weights.hand, signalRow: findSig('platoon_edge') }),
    // Penalty knobs are inverted — lift < 1 on cold means the penalty is
    // EARNED (i.e., increase magnitude, i.e., MORE NEGATIVE value).
    directionalFor({ knob: 'COLD_PENALTY.elite', driver: 'cold_batter', current: weights.coldElite, signalRow: findSig('cold_batter'), inverted: true, capPct: 0.5 }),
    directionalFor({ knob: 'COLD_PENALTY.mid', driver: 'cold_batter', current: weights.coldMid, signalRow: findSig('cold_batter'), inverted: true, capPct: 0.5 }),
    directionalFor({ knob: 'LOW_POWER_CAP.cap', driver: 'low_season_power', current: weights.lowPowerCap, signalRow: findSig('low_season_power'), inverted: true, capPct: 0.3 }),
  ];

  // ----- 5) Grid optimizer (sensitivity).
  const grid = gridSearch(byDate);

  return {
    window_days: byDate.size,
    total_player_days: totalN,
    total_hr_player_days: totalHits,
    baseline_rate: baseline,
    signals: signalRows,
    top_positive,
    top_negative,
    pair_combos,
    triple_combos,
    directional,
    grid,
  };
}

/** Convenience getter so the UI can pass current knobs without duplicating
 *  literal constants. Kept here so the analysis call site is one-liner. */
export function currentReverseAnalysisWeights(): {
  pitcher: number; park: number; l7d: number; hand: number;
  coldElite: number; coldMid: number; lowPowerCap: number;
} {
  return {
    pitcher: HEAT_SCORE_WEIGHTS.pitcher,
    park: HEAT_SCORE_WEIGHTS.park,
    l7d: HEAT_SCORE_WEIGHTS.l7d,
    hand: HEAT_SCORE_WEIGHTS.hand,
    coldElite: HEAT_SCORE_COLD_PENALTY.elite,
    coldMid: HEAT_SCORE_COLD_PENALTY.mid,
    lowPowerCap: HEAT_SCORE_LOW_POWER_CAP.cap,
  };
}

// =============================================================================
//  Actionable Model Changes + Simulated Top-10 (follow-up to task #179)
// -----------------------------------------------------------------------------
//  The reverse-analysis tab surfaces correlations — these helpers promote
//  the strongest patterns into concrete *test candidates* with a
//  before/after simulation, so the user can decide whether to apply them.
//
//  STRICT honesty rules (same as the analysis layer):
//    • Rules are SURFACED ONLY. Nothing here mutates HEAT_SCORE_WEIGHTS,
//      HEAT_SCORE_COLD_PENALTY, or any other scoring knob.
//    • Status defaults to "Test candidate" unless the sample and lift are
//      both strong. Small-sample combos are surfaced as "Monitor" only.
//    • The simulated Top-10 is a sensitivity sim: each candidate rule adds
//      a fixed Δ to heat_score when its signals match, then re-ranks per
//      date. Saturation / ceiling compression / completeness multipliers
//      are NOT re-applied (same caveat as the grid optimizer).
// =============================================================================

/** A concrete, surfaced change the model could try — each rule maps to a
 *  delta that gets added to heat_score whenever its signals all fire. */
export interface ActionableRule {
  /** Stable id ("combo:hr_pitcher+power_park"). Used as React key + sim ref. */
  id: string;
  kind: 'combo_bonus' | 'weight_change' | 'penalty_change';
  /** Human-readable rule, e.g., "Cold Batter + HR Pitcher → +4". */
  rule_text: string;
  /** Signals that must all be present to apply the delta. */
  signals: SignalKey[];
  /** Score adjustment applied when all signals match. Positive = boost,
   *  negative = penalty. Always small (≤ ±8) to limit overfitting risk. */
  delta: number;
  /** Tight numeric finding string — "21.9% hit rate, 1.49x lift, n=32". */
  finding: string;
  /** Plain-English why ("Cold penalty may be too harsh when pitcher allows HR damage"). */
  why: string;
  /** "+X% Top-10 hit rate over the window" — only filled after simulation. */
  expected_impact: string;
  overfitting_risk: 'low' | 'medium' | 'high';
  status: 'apply_now' | 'test_candidate' | 'monitor';
  /** Priority used for sorting in the UI. Higher = more important. */
  priority: number;
}

/** Per-day side-by-side actual vs simulated Top-10. */
export interface SimulatedTop10Day {
  date: string;
  actual: SimulatedTop10Row[];
  simulated: SimulatedTop10Row[];
  actual_hits: number;
  simulated_hits: number;
  /** simulated_hits − actual_hits; +/−. */
  delta_hits: number;
}

export interface SimulatedTop10Row {
  rank: number;
  player_id: number;
  player_name: string;
  team: string;
  heat_score: number;
  /** heat_score + Σ(rule.delta where rule matched). Equal to heat_score in actual. */
  modified_score: number;
  /** Rule ids that fired on this row. */
  rules_applied: string[];
  hit: boolean;
  /** True iff this player was in BOTH the actual and simulated Top-10
   *  for the date (helps the UI highlight the diff). */
  in_both: boolean;
}

export interface SimulatedTop10Result {
  /** Subset of the rules actually used to build the simulation (filtered
   *  to "apply_now" + "test_candidate" by default). */
  rules_applied: ActionableRule[];
  days: SimulatedTop10Day[];
  /** Totals across the window. */
  actual_total_hits: number;
  simulated_total_hits: number;
  actual_top10_rate: number;
  simulated_top10_rate: number;
  /** simulated − actual, in absolute terms. */
  delta: number;
  /** Days included (== days.length). */
  days_counted: number;
  note: string;
}

/**
 * Plain-English rationale for a combo. Hand-crafted for a few patterns the
 * user is most likely to see; falls back to a generic polarity-aware string.
 */
function comboRationale(keys: SignalKey[]): string {
  const k = keys.slice().sort().join('|');
  // Hand-crafted entries — easy to extend as patterns emerge.
  const map: Record<string, string> = {
    'cold_batter|hr_pitcher':
      'Cold penalty may be too harsh when the pitcher allows HR damage — the matchup edge appears to claw back what the cold-streak penalty over-corrects.',
    'hr_pitcher|power_park':
      'Park-induced HR ceiling and weak pitching context are largely independent — when they stack, both factors amplify.',
    'hot_l7d|hr_pitcher':
      'Hot streak hitters punish weak pitching at an outsized rate. Current model rewards each separately but does not credit the stack.',
    'elite_power|warm_weather':
      'Elite power profile + warm weather is a classic stacking pattern — the model treats them additively but the joint lift exceeds that.',
    'platoon_edge|wind_out':
      'Platoon edge plus a wind-out park boost is a multiplicative HR-environment combo not currently captured by either knob.',
    'hot_l7d|power_park':
      'Recent form + park boost — current weights treat them independently, but they appear to stack meaningfully.',
    'elite_power|hr_pitcher':
      'Top-of-card sluggers vs weak pitching — already a strong signal individually, but joint cases over-perform the sum.',
    'cold_batter|low_season_power':
      'When cold AND low-season-power both fire, the model already heavily discounts — verify this is not over-counting before increasing the penalty.',
  };
  if (map[k]) return map[k];
  // Generic fallback by polarity composition.
  const polarities = keys.map((s) => SIGNAL_POLARITY[s]);
  const allPositive = polarities.every((p) => p === 'positive');
  const allNegative = polarities.every((p) => p === 'negative');
  const labels = keys.map((s) => SIGNAL_LABELS[s]).join(' + ');
  if (allPositive) return `Joint occurrence of ${labels} outperforms the sum of individual lifts — model currently treats these factors independently.`;
  if (allNegative) return `${labels} co-occurring suggests the current penalty stack may be insufficient — confirm before increasing magnitudes.`;
  return `Mixed-polarity combo (${labels}) — joint lift suggests one signal is moderating the other in a way the current model misses.`;
}

/** Score a combo's "promotability" so we can sort actionable rules by
 *  practical importance (lift weighted by log(sample size)). */
function comboPriority(lift: number, n: number): number {
  return (lift - 1) * Math.log(Math.max(2, n));
}

function riskFor(n: number): 'low' | 'medium' | 'high' {
  if (n >= 100) return 'low';
  if (n >= 30) return 'medium';
  return 'high';
}

function statusFor(lift: number, n: number, outperforms: boolean): 'apply_now' | 'test_candidate' | 'monitor' {
  if (lift >= 1.5 && n >= 50 && outperforms) return 'apply_now';
  if (lift >= 1.3 && n >= 15) return 'test_candidate';
  return 'monitor';
}

/** Map lift magnitude to a small bounded delta. Capped so a single rule
 *  cannot dominate the score — the UI also displays the delta plainly. */
function deltaForCombo(lift: number, polarities: ('positive' | 'negative')[]): number {
  const allNegative = polarities.every((p) => p === 'negative');
  // Positive (or mixed) combos get bonuses. Pure-negative combos get penalty deltas.
  if (allNegative) {
    if (lift <= 0.5) return -7;
    if (lift <= 0.7) return -5;
    if (lift <= 0.85) return -3;
    return 0;
  }
  if (lift >= 2.0) return 7;
  if (lift >= 1.7) return 5;
  if (lift >= 1.5) return 4;
  if (lift >= 1.3) return 3;
  return 2;
}

/**
 * Promote the strongest combos + directional recs into actionable rule
 * cards. Combos rank above raw individual weight changes — the user
 * explicitly asked for that ordering.
 *
 * Combos are filtered to lift ≥ 1.15 AND n ≥ 10 before promotion. Below
 * that they remain in the combo table but aren't surfaced as rules.
 */
export function computeActionableChanges(
  analysis: ReverseAnalysisResult,
): ActionableRule[] {
  const rules: ActionableRule[] = [];

  // ----- 1) Combo rules (priority).
  const allCombos = [...analysis.pair_combos, ...analysis.triple_combos];
  for (const c of allCombos) {
    if (c.present_n < 10) continue;
    if (c.lift < 1.15 && c.lift > 0.85) continue; // skip neutral combos

    const polarities = c.keys.map((k) => SIGNAL_POLARITY[k]);
    const delta = deltaForCombo(c.lift, polarities);
    if (delta === 0) continue;

    const id = `combo:${c.keys.slice().sort().join('+')}`;
    const ruleText = `${c.labels.join(' + ')} → ${delta >= 0 ? '+' : ''}${delta}`;
    const finding = `${(c.present_rate * 100).toFixed(1)}% hit rate, ${c.lift.toFixed(2)}× lift, n=${c.present_n}`;
    const why = comboRationale(c.keys);
    const status = statusFor(c.lift, c.present_n, c.outperforms_individual);
    const risk = riskFor(c.present_n);

    rules.push({
      id,
      kind: 'combo_bonus',
      rule_text: ruleText,
      signals: c.keys.slice(),
      delta,
      finding,
      why,
      expected_impact: '', // filled by simulation
      overfitting_risk: risk,
      status,
      priority: comboPriority(c.lift, c.present_n) + 100, // combos rank above weights
    });
  }

  // ----- 2) Individual weight/penalty changes (lower priority).
  for (const d of analysis.directional) {
    if (d.direction === 'hold') continue;
    const sig = analysis.signals.find((s) => s.key === d.driver_signal);
    if (!sig || sig.present_n < 20) continue;

    const id = `knob:${d.knob}`;
    const ruleText = `${d.knob}: ${d.current_value} → ${d.suggested_value}`;
    const finding = `Driver "${SIGNAL_LABELS[d.driver_signal]}" lift=${sig.lift.toFixed(2)}× on n=${sig.present_n}`;
    const kind = d.knob.startsWith('COLD_PENALTY') || d.knob.startsWith('LOW_POWER_CAP')
      ? 'penalty_change'
      : 'weight_change';
    const status: ActionableRule['status'] =
      d.confidence === 'high' ? 'test_candidate'
      : d.confidence === 'medium' ? 'monitor'
      : 'monitor';

    rules.push({
      id,
      kind,
      rule_text: ruleText,
      signals: [d.driver_signal],
      delta: d.suggested_value - d.current_value,
      finding,
      why: d.rationale,
      expected_impact: '',
      overfitting_risk: sig.present_n >= 100 ? 'low' : sig.present_n >= 30 ? 'medium' : 'high',
      status,
      priority: Math.abs(d.suggested_value - d.current_value),
    });
  }

  return rules.sort((a, b) => b.priority - a.priority);
}

/**
 * Simulate Top-10 under a set of candidate rules.
 *
 * For each date in the window:
 *   1. Take all snapshot rows (heat_score, signals).
 *   2. The "actual" Top-10 is the original rank ≤ 10 set.
 *   3. The "simulated" Top-10 re-ranks by heat_score + Σ(rule.delta) for
 *      every rule whose signals all match.
 *   4. Counts how many of each Top-10 actually homered.
 *
 * Returns side-by-side rows + totals so the UI can highlight the diff.
 */
export function simulateTop10WithRules(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  rules: ActionableRule[],
): SimulatedTop10Result {
  // Filter to rules that should be tested. "monitor" rules are surfaced in
  // the UI but excluded from the sim so we don't bias the simulated curve
  // by under-evidence noise.
  const sim_rules = rules.filter((r) => r.status === 'apply_now' || r.status === 'test_candidate');

  // Group snapshot rows by date.
  type Row = {
    player_id: number;
    player_name: string;
    team: string;
    heat_score: number;
    signals: Set<SignalKey>;
    rank: number;
    hit: boolean;
  };
  const byDate = new Map<string, Row[]>();
  for (const snap of snapshots) {
    const hrSet = hrPlayersByDate.get(snap.target_date) ?? new Set<number>();
    const r: Row = {
      player_id: snap.player_id,
      player_name: snap.player_name ?? `#${snap.player_id}`,
      team: snap.team ?? '',
      heat_score: snap.heat_score,
      signals: parseSignalsFromReason(snap.reason),
      rank: snap.rank,
      hit: hrSet.has(snap.player_id),
    };
    const arr = byDate.get(snap.target_date);
    if (arr) arr.push(r); else byDate.set(snap.target_date, [r]);
  }

  const days: SimulatedTop10Day[] = [];
  let actual_total = 0;
  let sim_total = 0;
  let actual_top_slots = 0;
  let sim_top_slots = 0;

  // Date-sorted, ascending — useful for chart/timeline rendering.
  const sortedDates = Array.from(byDate.keys()).sort();
  for (const date of sortedDates) {
    const rows = byDate.get(date)!;
    // Actual top-10 from saved rank.
    const actualSorted = rows.slice().sort((a, b) => a.rank - b.rank);
    const actualTop10 = actualSorted.slice(0, 10);

    // Simulated: compute modified score per row, then re-rank.
    const simulated = rows.map((r) => {
      const applied: string[] = [];
      let modified = r.heat_score;
      for (const rule of sim_rules) {
        if (rule.signals.every((s) => r.signals.has(s))) {
          modified += rule.delta;
          applied.push(rule.id);
        }
      }
      return { row: r, modified, applied };
    });
    simulated.sort((a, b) => b.modified - a.modified);
    const simulatedTop10 = simulated.slice(0, 10);

    const actualIds = new Set(actualTop10.map((r) => r.player_id));
    const simIds = new Set(simulatedTop10.map((s) => s.row.player_id));

    const actualRows: SimulatedTop10Row[] = actualTop10.map((r, i) => ({
      rank: i + 1,
      player_id: r.player_id,
      player_name: r.player_name,
      team: r.team,
      heat_score: r.heat_score,
      modified_score: r.heat_score,
      rules_applied: [],
      hit: r.hit,
      in_both: simIds.has(r.player_id),
    }));
    const simRows: SimulatedTop10Row[] = simulatedTop10.map((s, i) => ({
      rank: i + 1,
      player_id: s.row.player_id,
      player_name: s.row.player_name,
      team: s.row.team,
      heat_score: s.row.heat_score,
      modified_score: s.modified,
      rules_applied: s.applied,
      hit: s.row.hit,
      in_both: actualIds.has(s.row.player_id),
    }));

    const actualHits = actualRows.reduce((sum, r) => sum + (r.hit ? 1 : 0), 0);
    const simHits = simRows.reduce((sum, r) => sum + (r.hit ? 1 : 0), 0);

    days.push({
      date,
      actual: actualRows,
      simulated: simRows,
      actual_hits: actualHits,
      simulated_hits: simHits,
      delta_hits: simHits - actualHits,
    });
    actual_total += actualHits;
    sim_total += simHits;
    actual_top_slots += actualRows.length;
    sim_top_slots += simRows.length;
  }

  const actualRate = actual_top_slots > 0 ? actual_total / actual_top_slots : 0;
  const simRate = sim_top_slots > 0 ? sim_total / sim_top_slots : 0;

  return {
    rules_applied: sim_rules,
    days,
    actual_total_hits: actual_total,
    simulated_total_hits: sim_total,
    actual_top10_rate: actualRate,
    simulated_top10_rate: simRate,
    delta: simRate - actualRate,
    days_counted: days.length,
    note: sim_rules.length === 0
      ? 'No rules qualified for testing — simulated curve matches actual.'
      : `Sensitivity sim: Δ added directly to saved heat_score on rule matches, then re-ranked. Full pipeline not re-applied.`,
  };
}

/**
 * Convenience wrapper — promote rules + back-fill expected_impact from the
 * simulation, in one pass. This is the function the UI calls.
 *
 * After computing the sim, we estimate each rule's individual contribution
 * to the Top-10 hit-rate lift by running a leave-one-out sim (each rule
 * removed, observe Top-10 hit-rate drop). For small rule sets this is
 * cheap (n_rules × days × snapshots/day re-rank).
 */
export function buildActionableModelChanges(
  analysis: ReverseAnalysisResult,
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
): { rules: ActionableRule[]; simulation: SimulatedTop10Result } {
  const rules = computeActionableChanges(analysis);
  const full = simulateTop10WithRules(snapshots, hrPlayersByDate, rules);

  // Leave-one-out attribution for expected_impact.
  for (const r of rules) {
    if (r.status === 'monitor') {
      r.expected_impact = 'Not tested — sample too small.';
      continue;
    }
    const subset = rules.filter((other) => other.id !== r.id);
    const minus = simulateTop10WithRules(snapshots, hrPlayersByDate, subset);
    const contribution = full.simulated_top10_rate - minus.simulated_top10_rate;
    if (contribution >= 0.005) {
      r.expected_impact = `+${(contribution * 100).toFixed(1)} pct pt Top-10 hit rate`;
    } else if (contribution <= -0.005) {
      r.expected_impact = `${(contribution * 100).toFixed(1)} pct pt Top-10 hit rate (HURTS — revisit)`;
    } else {
      r.expected_impact = 'Negligible (<0.5 pct pt) — keep as monitor.';
    }
  }

  return { rules, simulation: full };
}

// =============================================================================
//  Best Reconstructed Top 10 — hindsight optimization (task #194)
// -----------------------------------------------------------------------------
//  For each date in the window, search a small space of single-signal Δs and
//  combo bonuses to find the rule set that would have placed the most actual
//  HR hitters into the Top 10. Aggregate across dates to surface RECURRING
//  rules (selected on multiple days) — those are repeatable patterns rather
//  than one-day overfits.
//
//  STRICT honesty rules:
//    • This is HINDSIGHT. Each day uses its own actual HR results to score
//      candidate rule sets. Nothing here is appropriate as a live prediction.
//    • The greedy search is a tractability compromise, not exhaustive. We
//      surface the cross-window recurrence summary precisely because no
//      single day's reconstructed rules should be trusted — only patterns
//      that repeat.
//    • SURFACED ONLY. The panel never mutates HEAT_SCORE_WEIGHTS or any
//      scoring knob. The user reads the patterns and applies by hand.
// =============================================================================

/** One concrete rule selected by the per-day reconstruction. */
export interface ReconstructedRule {
  /** Stable id ("sig:hr_pitcher" or "combo:cold_batter+hr_pitcher"). */
  id: string;
  kind: 'single' | 'combo';
  /** Signals that must ALL fire for the rule to apply. */
  signals: SignalKey[];
  /** Score adjustment added when the rule applies. */
  delta: number;
  /** Human-readable: "+4 HR Pitcher" or "+3 Cold Batter + HR Pitcher". */
  text: string;
}

/** Side-by-side per-date reconstruction output. */
export interface ReconstructedDay {
  date: string;
  /** Hit rate of the saved-snapshot Top 10. */
  current_hits: number;
  current_rate: number;
  /** Hit rate after applying the best rule set found by the greedy search. */
  reconstructed_hits: number;
  reconstructed_rate: number;
  /** Rule set the search converged on (≤ MAX_RULES_PER_DAY). */
  rules: ReconstructedRule[];
  /** Snapshot of the original Top 10 with hit flags. */
  current_top10: SimulatedTop10Row[];
  /** Snapshot of the reconstructed Top 10 with modified scores + matched rules. */
  reconstructed_top10: SimulatedTop10Row[];
  /** Players who entered the Top 10 via reconstruction. Sorted by new rank asc. */
  added: { player_id: number; player_name: string; team: string; new_rank: number; hit: boolean }[];
  /** Players pushed out of the Top 10 by reconstruction. Sorted by original rank asc. */
  removed: { player_id: number; player_name: string; team: string; old_rank: number; hit: boolean }[];
}

/** Cross-window aggregator output: a rule that repeatedly improves Top 10. */
export interface RecurringRule {
  id: string;
  text_template: string;            // "HR Pitcher" or "Cold Batter + HR Pitcher"
  kind: 'single' | 'combo';
  signals: SignalKey[];
  /** Days the rule was selected. */
  days_selected: number;
  /** Total days analyzed (== ReconstructionResult.days_counted). */
  total_days: number;
  /** Average Δ across the days it was selected (positive or negative). */
  avg_delta: number;
  /** Average Top-10 hit-rate gain on those days when this rule was applied. */
  avg_lift_pct_pts: number;
  /** Score used to sort: days_selected × avg_lift × log scale. */
  score: number;
}

export interface ReconstructionResult {
  days: ReconstructedDay[];
  /** Sum of current_hits across all days. */
  total_current_hits: number;
  total_reconstructed_hits: number;
  /** Weighted hit rates across the window. */
  current_top10_rate: number;
  reconstructed_top10_rate: number;
  /** Pct-pt improvement over the window. */
  estimated_improvement: number;
  /** Recurring rules, sorted by score desc. */
  recurring: RecurringRule[];
  /** Days included (== days.length). */
  days_counted: number;
  /** Fine print for the UI. */
  note: string;
}

const RECONSTRUCT_MAX_RULES_PER_DAY = 5;

/**
 * Candidate rule pool searched per day. Single-signal Δs and a curated set
 * of pair-combo bonuses. The user's example explicitly included:
 *   +4 HR Pitcher, +3 Cold Batter + HR Pitcher, +3 Mid Power, -2 Hot L7d.
 * The single-signal Δ set covers the first three; the combo pool covers the
 * stack patterns surfaced by the actionable layer.
 */
function reconstructionCandidates(): ReconstructedRule[] {
  const singles: SignalKey[] = [
    'hr_pitcher', 'power_park', 'wind_out', 'warm_weather',
    'hot_l7d', 'platoon_edge', 'elite_power', 'mid_power',
    'cold_batter', 'pitcher_dominant',
  ];
  const combos: SignalKey[][] = [
    ['cold_batter', 'hr_pitcher'],
    ['hr_pitcher', 'power_park'],
    ['hot_l7d', 'hr_pitcher'],
    ['elite_power', 'warm_weather'],
    ['wind_out', 'platoon_edge'],
    ['hot_l7d', 'power_park'],
    ['elite_power', 'hr_pitcher'],
  ];
  const deltas = [-4, -2, 2, 4];
  const comboDeltas = [2, 3, 4];

  const out: ReconstructedRule[] = [];
  for (const sig of singles) {
    for (const d of deltas) {
      out.push({
        id: `sig:${sig}@${d}`,
        kind: 'single',
        signals: [sig],
        delta: d,
        text: `${d > 0 ? '+' : ''}${d} ${SIGNAL_LABELS[sig]}`,
      });
    }
  }
  for (const c of combos) {
    for (const d of comboDeltas) {
      const sorted = c.slice().sort();
      out.push({
        id: `combo:${sorted.join('+')}@${d}`,
        kind: 'combo',
        signals: sorted,
        delta: d,
        text: `+${d} ${c.map((s) => SIGNAL_LABELS[s]).join(' + ')}`,
      });
    }
  }
  return out;
}

type ReconRow = {
  player_id: number;
  player_name: string;
  team: string;
  heat_score: number;
  signals: Set<SignalKey>;
  hit: boolean;
  original_rank: number;
};

/** Re-rank rows under a rule set, return the top 10 ids and hit count. */
function scoreUnderRules(rows: ReconRow[], rules: ReconstructedRule[]): {
  top10: { row: ReconRow; modified: number; applied: string[] }[];
  hits: number;
} {
  const scored = rows.map((r) => {
    const applied: string[] = [];
    let modified = r.heat_score;
    for (const rule of rules) {
      if (rule.signals.every((s) => r.signals.has(s))) {
        modified += rule.delta;
        applied.push(rule.id);
      }
    }
    return { row: r, modified, applied };
  });
  scored.sort((a, b) => b.modified - a.modified);
  const top10 = scored.slice(0, 10);
  let hits = 0;
  for (const t of top10) if (t.row.hit) hits++;
  return { top10, hits };
}

/** Greedy beam search: at each step, try every candidate not yet in the
 *  rule set, keep the one that improves hit-count the most. Stop when
 *  nothing improves or MAX_RULES_PER_DAY reached. Ties broken by
 *  smaller |Δ| (prefer subtler rules). */
function reconstructDay(
  date: string,
  rows: ReconRow[],
  candidates: ReconstructedRule[],
): ReconstructedDay {
  // Baseline: the saved Top 10 (by original_rank).
  const baselineSorted = rows.slice().sort((a, b) => a.original_rank - b.original_rank);
  const baselineTop10 = baselineSorted.slice(0, 10);
  const baselineHits = baselineTop10.reduce((s, r) => s + (r.hit ? 1 : 0), 0);

  let bestRules: ReconstructedRule[] = [];
  let bestHits = baselineHits;
  let improved = true;

  while (improved && bestRules.length < RECONSTRUCT_MAX_RULES_PER_DAY) {
    improved = false;
    let bestCandidate: ReconstructedRule | null = null;
    let bestCandidateHits = bestHits;
    let bestCandidateDelta = Infinity;
    const usedIds = new Set(bestRules.map((r) => r.id));
    // Also skip candidates whose signals match an already-selected rule
    // with the OPPOSITE sign — those just cancel out and waste rule slots.
    const usedSignatures = new Set(bestRules.map((r) => `${r.kind}:${r.signals.slice().sort().join('+')}`));
    for (const cand of candidates) {
      if (usedIds.has(cand.id)) continue;
      const sig = `${cand.kind}:${cand.signals.slice().sort().join('+')}`;
      if (usedSignatures.has(sig)) continue; // already have a rule on this signal
      const trial = bestRules.concat([cand]);
      const { hits } = scoreUnderRules(rows, trial);
      if (hits > bestCandidateHits || (hits === bestCandidateHits && Math.abs(cand.delta) < bestCandidateDelta)) {
        bestCandidateHits = hits;
        bestCandidate = cand;
        bestCandidateDelta = Math.abs(cand.delta);
      }
    }
    if (bestCandidate && bestCandidateHits > bestHits) {
      bestRules.push(bestCandidate);
      bestHits = bestCandidateHits;
      improved = true;
    }
  }

  // Build the side-by-side output rows.
  const current = scoreUnderRules(rows, []);   // identity (no rules) for the snapshot view
  const reconstructed = scoreUnderRules(rows, bestRules);

  const currentTop10Rows: SimulatedTop10Row[] = baselineTop10.map((r, i) => ({
    rank: i + 1,
    player_id: r.player_id,
    player_name: r.player_name,
    team: r.team,
    heat_score: r.heat_score,
    modified_score: r.heat_score,
    rules_applied: [],
    hit: r.hit,
    in_both: reconstructed.top10.some((s) => s.row.player_id === r.player_id),
  }));
  const reconstructedTop10Rows: SimulatedTop10Row[] = reconstructed.top10.map((s, i) => ({
    rank: i + 1,
    player_id: s.row.player_id,
    player_name: s.row.player_name,
    team: s.row.team,
    heat_score: s.row.heat_score,
    modified_score: s.modified,
    rules_applied: s.applied,
    hit: s.row.hit,
    in_both: baselineTop10.some((r) => r.player_id === s.row.player_id),
  }));

  const baselineIds = new Set(baselineTop10.map((r) => r.player_id));
  const reconIds = new Set(reconstructed.top10.map((s) => s.row.player_id));
  const added: ReconstructedDay['added'] = [];
  const removed: ReconstructedDay['removed'] = [];
  reconstructed.top10.forEach((s, i) => {
    if (!baselineIds.has(s.row.player_id)) {
      added.push({
        player_id: s.row.player_id,
        player_name: s.row.player_name,
        team: s.row.team,
        new_rank: i + 1,
        hit: s.row.hit,
      });
    }
  });
  baselineTop10.forEach((r, i) => {
    if (!reconIds.has(r.player_id)) {
      removed.push({
        player_id: r.player_id,
        player_name: r.player_name,
        team: r.team,
        old_rank: i + 1,
        hit: r.hit,
      });
    }
  });

  return {
    date,
    current_hits: baselineHits,
    current_rate: baselineHits / 10,
    reconstructed_hits: bestHits,
    reconstructed_rate: bestHits / 10,
    rules: bestRules,
    current_top10: currentTop10Rows,
    reconstructed_top10: reconstructedTop10Rows,
    added,
    removed,
  };
}

/**
 * Reconstruct each day in the window, then surface RECURRING rules — those
 * the search selected on multiple days. Recurring rules are the only ones
 * the user should consider acting on: a rule selected on a single day is
 * almost certainly a fit to that day's specific HR distribution.
 *
 * @param snapshots  all snapshot rows in the window (any rank)
 * @param hrPlayersByDate game_date → set of player_ids who homered
 */
export function reconstructBestTop10(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
): ReconstructionResult {
  const candidates = reconstructionCandidates();

  // Group snapshot rows by date and pre-parse signals once per row.
  const byDate = new Map<string, ReconRow[]>();
  for (const snap of snapshots) {
    const hrSet = hrPlayersByDate.get(snap.target_date) ?? new Set<number>();
    const row: ReconRow = {
      player_id: snap.player_id,
      player_name: snap.player_name ?? `#${snap.player_id}`,
      team: snap.team ?? '',
      heat_score: snap.heat_score,
      signals: parseSignalsFromReason(snap.reason),
      hit: hrSet.has(snap.player_id),
      original_rank: snap.rank,
    };
    const arr = byDate.get(snap.target_date);
    if (arr) arr.push(row); else byDate.set(snap.target_date, [row]);
  }

  // Per-day reconstruction.
  const sortedDates = Array.from(byDate.keys()).sort();
  const days: ReconstructedDay[] = [];
  for (const date of sortedDates) {
    const rows = byDate.get(date)!;
    if (rows.length < 10) continue; // not enough rows to fill a Top 10
    days.push(reconstructDay(date, rows, candidates));
  }

  // Cross-day rule aggregation. Group by "structural id" — kind + signals,
  // ignoring the specific Δ — so e.g. "+2 HR Pitcher" and "+4 HR Pitcher"
  // both contribute to the "HR Pitcher" recurring entry.
  type AccumKey = string;
  const accum = new Map<AccumKey, {
    id: string;
    text_template: string;
    kind: 'single' | 'combo';
    signals: SignalKey[];
    days_selected: number;
    delta_sum: number;
    lift_pct_pts_sum: number;
  }>();
  for (const day of days) {
    const lift = day.reconstructed_rate - day.current_rate;
    for (const rule of day.rules) {
      const key = `${rule.kind}:${rule.signals.slice().sort().join('+')}`;
      let entry = accum.get(key);
      if (!entry) {
        entry = {
          id: key,
          text_template: rule.signals.map((s) => SIGNAL_LABELS[s]).join(' + '),
          kind: rule.kind,
          signals: rule.signals.slice(),
          days_selected: 0,
          delta_sum: 0,
          lift_pct_pts_sum: 0,
        };
        accum.set(key, entry);
      }
      entry.days_selected += 1;
      entry.delta_sum += rule.delta;
      entry.lift_pct_pts_sum += lift * 100;
    }
  }
  const recurring: RecurringRule[] = Array.from(accum.values()).map((e) => {
    const avgDelta = e.days_selected > 0 ? e.delta_sum / e.days_selected : 0;
    const avgLift = e.days_selected > 0 ? e.lift_pct_pts_sum / e.days_selected : 0;
    return {
      id: e.id,
      text_template: e.text_template,
      kind: e.kind,
      signals: e.signals,
      days_selected: e.days_selected,
      total_days: days.length,
      avg_delta: Number(avgDelta.toFixed(2)),
      avg_lift_pct_pts: Number(avgLift.toFixed(1)),
      // Score: days_selected dominates, but reward magnitude too.
      score: e.days_selected * Math.max(0.5, avgLift),
    };
  }).sort((a, b) => b.score - a.score);

  const totalCurrent = days.reduce((s, d) => s + d.current_hits, 0);
  const totalRecon = days.reduce((s, d) => s + d.reconstructed_hits, 0);
  const slots = days.length * 10;
  return {
    days,
    total_current_hits: totalCurrent,
    total_reconstructed_hits: totalRecon,
    current_top10_rate: slots > 0 ? totalCurrent / slots : 0,
    reconstructed_top10_rate: slots > 0 ? totalRecon / slots : 0,
    estimated_improvement: slots > 0 ? (totalRecon - totalCurrent) / slots : 0,
    recurring,
    days_counted: days.length,
    note: 'Hindsight reconstruction — each day uses its own actual HR results to score rule sets. Do NOT use any single day as a live prediction. Look for RECURRING rules below.',
  };
}

// =============================================================================
//  Adaptive Top 10 + Confidence Tiers (task #200)
// -----------------------------------------------------------------------------
//  Two separate but complementary views:
//
//  ADAPTIVE TOP 10 — apply ONLY the rules the reconstruction picked on
//  multiple days (≥ MIN_RECURRENCE_DAYS) using their averaged Δ. This is
//  the closest thing to a forward-applicable rule set the system can
//  produce: a single rule selected on one day is overfit; rules that
//  repeated across 2+ days have at least some cross-day validation.
//  Re-ranks every day in the window under those rules, side-by-side with
//  the saved-snapshot Top 10.
//
//  CONFIDENCE TIERS — bucket every player-day in the window by heat_score
//  band (A ≥ 60, B 45-60, C 30-45) and compute hit rates per tier over
//  rolling 7d and 14d windows. The diagnosis answers the user's real
//  question: does the model's edge come from RANKING players correctly
//  (rates monotonically decline A → B → C) or from BUCKETING them into
//  profitable probability bands (rates compressed or non-monotone)?
//
//  STRICT honesty rules:
//    • SURFACED ONLY. The panel never mutates HEAT_SCORE_WEIGHTS.
//    • The "adaptive" name is precise: it adapts to recurring historical
//      patterns. It is NOT a live prediction tool — it's a backtest of
//      "would applying patterns that repeated over the last 14 days have
//      improved our Top 10?"
// =============================================================================

/** Minimum number of days a rule must have been selected by the
 *  reconstruction to be eligible for the Adaptive Top 10. Selected on
 *  one day = overfit; ≥2 days = at least one cross-validation. */
const ADAPTIVE_MIN_RECURRENCE_DAYS = 2;

/** Heat-score band edges. Calibrated for the typical 30-80 model output
 *  range (most player-days land between 35 and 65). Tier A is the model's
 *  "confident" picks; Tier C is the bottom of the ranked pool. */
const TIER_BANDS: { tier: 'A' | 'B' | 'C'; min: number; max: number }[] = [
  { tier: 'A', min: 60, max: Infinity },
  { tier: 'B', min: 45, max: 60 },
  { tier: 'C', min: 30, max: 45 },
];

/** Per-day side-by-side core vs adaptive Top 10. */
export interface AdaptiveTop10Day {
  date: string;
  core_top10: SimulatedTop10Row[];
  adaptive_top10: SimulatedTop10Row[];
  core_hits: number;
  adaptive_hits: number;
  /** adaptive − core. Positive = adaptive improved. */
  net_delta: number;
  added: { player_id: number; player_name: string; team: string; new_rank: number; hit: boolean }[];
  removed: { player_id: number; player_name: string; team: string; old_rank: number; hit: boolean }[];
}

export interface AdaptiveTop10Result {
  days: AdaptiveTop10Day[];
  /** Recurring rules that were applied (≥ ADAPTIVE_MIN_RECURRENCE_DAYS). */
  rules_used: RecurringRule[];
  /** All recurring rules that DIDN'T qualify — surfaced as "monitor" only. */
  rules_dropped: RecurringRule[];
  total_core_hits: number;
  total_adaptive_hits: number;
  core_rate: number;
  adaptive_rate: number;
  /** adaptive − core, in absolute pct-pt. */
  net_gain: number;
  days_counted: number;
  note: string;
}

/** Heat-score bucket with rolling-window hit rates. */
export interface ConfidenceTier {
  tier: 'A' | 'B' | 'C';
  label: string;        // "Heat ≥ 60" etc., for the UI
  min_heat: number;
  max_heat: number;
  /** Rolling 7-day stats: how many player-days fell in this tier, how many homered. */
  player_days_l7d: number;
  hits_l7d: number;
  rate_l7d: number;
  /** Rolling 14-day stats. */
  player_days_l14d: number;
  hits_l14d: number;
  rate_l14d: number;
}

export interface ConfidenceTiersResult {
  tiers: ConfidenceTier[];
  /** True iff Tier A rate > Tier B rate > Tier C rate over the 14d window. */
  monotone_14d: boolean;
  monotone_7d: boolean;
  /**
   *   'ranking_edge'   — A clearly > B > C (model ranks players well).
   *   'bucketing_edge' — Rates are flat or non-monotone (edge is in the
   *                      tier definition more than the specific rank).
   *   'mixed'          — Some monotonicity but not clean.
   *   'insufficient_data' — Sample size too small.
   */
  diagnosis: 'ranking_edge' | 'bucketing_edge' | 'mixed' | 'insufficient_data';
  /** Plain-English explanation of the diagnosis. */
  rationale: string;
  /** Effective window anchor (the "as-of" date), and the rolling-window endpoints. */
  anchor: string;
  l7d_from: string;
  l14d_from: string;
}

/**
 * Apply only the rules that the reconstruction picked on multiple days
 * (≥ ADAPTIVE_MIN_RECURRENCE_DAYS), using each rule's averaged Δ. Re-rank
 * every day in the window and compare to the saved-snapshot Top 10.
 *
 * NOTE: this is a sensitivity sim — Δ is added directly to heat_score,
 * the full pipeline isn't re-applied. See the existing simulate / grid
 * notes elsewhere in this module.
 */
export function applyRecurringRules(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  reconRecurring: RecurringRule[],
): AdaptiveTop10Result {
  const rulesUsed = reconRecurring.filter((r) => r.days_selected >= ADAPTIVE_MIN_RECURRENCE_DAYS);
  const rulesDropped = reconRecurring.filter((r) => r.days_selected < ADAPTIVE_MIN_RECURRENCE_DAYS);

  // Group snapshot rows by date and pre-parse signals once.
  type Row = {
    player_id: number;
    player_name: string;
    team: string;
    heat_score: number;
    signals: Set<SignalKey>;
    hit: boolean;
    rank: number;
  };
  const byDate = new Map<string, Row[]>();
  for (const snap of snapshots) {
    const hrSet = hrPlayersByDate.get(snap.target_date) ?? new Set<number>();
    const r: Row = {
      player_id: snap.player_id,
      player_name: snap.player_name ?? `#${snap.player_id}`,
      team: snap.team ?? '',
      heat_score: snap.heat_score,
      signals: parseSignalsFromReason(snap.reason),
      hit: hrSet.has(snap.player_id),
      rank: snap.rank,
    };
    const arr = byDate.get(snap.target_date);
    if (arr) arr.push(r); else byDate.set(snap.target_date, [r]);
  }

  const days: AdaptiveTop10Day[] = [];
  let totalCore = 0;
  let totalAdaptive = 0;

  const sortedDates = Array.from(byDate.keys()).sort();
  for (const date of sortedDates) {
    const rows = byDate.get(date)!;
    if (rows.length < 10) continue;

    // Core: saved Top 10 (by original rank).
    const coreSorted = rows.slice().sort((a, b) => a.rank - b.rank);
    const coreTop10 = coreSorted.slice(0, 10);
    const coreHits = coreTop10.reduce((s, r) => s + (r.hit ? 1 : 0), 0);

    // Adaptive: apply recurring rules with their averaged Δ.
    const adapted = rows.map((r) => {
      let modified = r.heat_score;
      const applied: string[] = [];
      for (const rule of rulesUsed) {
        if (rule.signals.every((s) => r.signals.has(s))) {
          modified += rule.avg_delta;
          applied.push(rule.id);
        }
      }
      return { row: r, modified, applied };
    });
    adapted.sort((a, b) => b.modified - a.modified);
    const adaptiveTop10 = adapted.slice(0, 10);
    const adaptiveHits = adaptiveTop10.reduce((s, a) => s + (a.row.hit ? 1 : 0), 0);

    const coreIds = new Set(coreTop10.map((r) => r.player_id));
    const adaptIds = new Set(adaptiveTop10.map((a) => a.row.player_id));

    const coreRows: SimulatedTop10Row[] = coreTop10.map((r, i) => ({
      rank: i + 1,
      player_id: r.player_id,
      player_name: r.player_name,
      team: r.team,
      heat_score: r.heat_score,
      modified_score: r.heat_score,
      rules_applied: [],
      hit: r.hit,
      in_both: adaptIds.has(r.player_id),
    }));
    const adaptiveRows: SimulatedTop10Row[] = adaptiveTop10.map((a, i) => ({
      rank: i + 1,
      player_id: a.row.player_id,
      player_name: a.row.player_name,
      team: a.row.team,
      heat_score: a.row.heat_score,
      modified_score: a.modified,
      rules_applied: a.applied,
      hit: a.row.hit,
      in_both: coreIds.has(a.row.player_id),
    }));

    const added: AdaptiveTop10Day['added'] = [];
    const removed: AdaptiveTop10Day['removed'] = [];
    adaptiveTop10.forEach((a, i) => {
      if (!coreIds.has(a.row.player_id)) {
        added.push({
          player_id: a.row.player_id,
          player_name: a.row.player_name,
          team: a.row.team,
          new_rank: i + 1,
          hit: a.row.hit,
        });
      }
    });
    coreTop10.forEach((r, i) => {
      if (!adaptIds.has(r.player_id)) {
        removed.push({
          player_id: r.player_id,
          player_name: r.player_name,
          team: r.team,
          old_rank: i + 1,
          hit: r.hit,
        });
      }
    });

    days.push({
      date,
      core_top10: coreRows,
      adaptive_top10: adaptiveRows,
      core_hits: coreHits,
      adaptive_hits: adaptiveHits,
      net_delta: adaptiveHits - coreHits,
      added,
      removed,
    });
    totalCore += coreHits;
    totalAdaptive += adaptiveHits;
  }

  const slots = days.length * 10;
  return {
    days,
    rules_used: rulesUsed,
    rules_dropped: rulesDropped,
    total_core_hits: totalCore,
    total_adaptive_hits: totalAdaptive,
    core_rate: slots > 0 ? totalCore / slots : 0,
    adaptive_rate: slots > 0 ? totalAdaptive / slots : 0,
    net_gain: slots > 0 ? (totalAdaptive - totalCore) / slots : 0,
    days_counted: days.length,
    note: rulesUsed.length === 0
      ? 'No rules met the recurrence threshold (≥ 2 days). Adaptive Top 10 equals Core Top 10. Wait for more data before drawing conclusions.'
      : `Applied ${rulesUsed.length} recurring rule(s) with averaged Δ. Sensitivity sim — Δ added to saved heat_score, full pipeline not re-applied.`,
  };
}

/**
 * Bucket every player-day in the window by heat_score band, compute hit
 * rates over rolling 7d and 14d windows ending at `anchor`. Diagnose
 * whether the model's edge comes from ranking accuracy (clear A → B → C
 * decline) or from the bucket definition itself (flat / inverted rates).
 *
 * @param snapshots       all snapshot rows in the window (14d)
 * @param hrPlayersByDate game_date → set of player_ids who homered
 * @param anchor          right-edge date of the rolling windows (YYYY-MM-DD)
 */
export function computeConfidenceTiers(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  anchor: string,
): ConfidenceTiersResult {
  // Rolling windows are inclusive of anchor.
  const l7dFrom = addDays(anchor, -6);
  const l14dFrom = addDays(anchor, -13);

  // Per-tier counters across the two windows.
  const tierStats = TIER_BANDS.map((b) => ({
    ...b,
    label: b.max === Infinity ? `Heat ≥ ${b.min}` : `${b.min} ≤ Heat < ${b.max}`,
    player_days_l7d: 0, hits_l7d: 0,
    player_days_l14d: 0, hits_l14d: 0,
  }));

  for (const snap of snapshots) {
    const date = snap.target_date;
    if (date > anchor) continue;          // never use future data
    if (date < l14dFrom) continue;        // outside the largest window

    const tier = tierStats.find((t) => snap.heat_score >= t.min && snap.heat_score < t.max);
    if (!tier) continue;                  // below band C (heat < 30) — irrelevant

    const hrSet = hrPlayersByDate.get(date) ?? new Set<number>();
    const homered = hrSet.has(snap.player_id);

    tier.player_days_l14d += 1;
    if (homered) tier.hits_l14d += 1;
    if (date >= l7dFrom) {
      tier.player_days_l7d += 1;
      if (homered) tier.hits_l7d += 1;
    }
  }

  const tiers: ConfidenceTier[] = tierStats.map((t) => ({
    tier: t.tier,
    label: t.label,
    min_heat: t.min,
    max_heat: t.max,
    player_days_l7d: t.player_days_l7d,
    hits_l7d: t.hits_l7d,
    rate_l7d: t.player_days_l7d > 0 ? t.hits_l7d / t.player_days_l7d : 0,
    player_days_l14d: t.player_days_l14d,
    hits_l14d: t.hits_l14d,
    rate_l14d: t.player_days_l14d > 0 ? t.hits_l14d / t.player_days_l14d : 0,
  }));

  // Monotonicity checks (sort by tier — A first, then B, then C).
  const byTier = (t: 'A' | 'B' | 'C') => tiers.find((x) => x.tier === t)!;
  const A = byTier('A'), B = byTier('B'), C = byTier('C');
  const monotone14 = A.rate_l14d > B.rate_l14d && B.rate_l14d > C.rate_l14d;
  const monotone7 = A.rate_l7d > B.rate_l7d && B.rate_l7d > C.rate_l7d;

  // Diagnosis. Use the larger 14d window for stability.
  const totalDays14 = A.player_days_l14d + B.player_days_l14d + C.player_days_l14d;
  let diagnosis: ConfidenceTiersResult['diagnosis'];
  let rationale: string;
  if (totalDays14 < 50) {
    diagnosis = 'insufficient_data';
    rationale = `Only ${totalDays14} player-days in the 14d window. Need ≥ 50 to make a meaningful call.`;
  } else if (A.rate_l14d >= B.rate_l14d * 1.3 && B.rate_l14d >= C.rate_l14d * 1.15) {
    diagnosis = 'ranking_edge';
    rationale = `Tier A homers at ${(A.rate_l14d * 100).toFixed(1)}% vs B's ${(B.rate_l14d * 100).toFixed(1)}% vs C's ${(C.rate_l14d * 100).toFixed(1)}% — clean monotone decline. Heat Score is meaningfully ranking players within the pool.`;
  } else if (Math.abs(A.rate_l14d - B.rate_l14d) < 0.02 && Math.abs(B.rate_l14d - C.rate_l14d) < 0.02) {
    diagnosis = 'bucketing_edge';
    rationale = `Tier rates are nearly flat (A: ${(A.rate_l14d * 100).toFixed(1)}%, B: ${(B.rate_l14d * 100).toFixed(1)}%, C: ${(C.rate_l14d * 100).toFixed(1)}%). Heat Score is not discriminating well between buckets — the model's edge is the bucket DEFINITION, not the ranking inside it.`;
  } else if (monotone14) {
    diagnosis = 'mixed';
    rationale = `Rates decline A → B → C but only modestly. Some ranking signal exists but the gap between tiers is small; treat individual ranks within a tier as roughly fungible.`;
  } else {
    diagnosis = 'mixed';
    rationale = `Rates are non-monotone (A: ${(A.rate_l14d * 100).toFixed(1)}%, B: ${(B.rate_l14d * 100).toFixed(1)}%, C: ${(C.rate_l14d * 100).toFixed(1)}%). Either small-sample noise or a real calibration issue — check the 7d window for consistency.`;
  }

  return {
    tiers,
    monotone_14d: monotone14,
    monotone_7d: monotone7,
    diagnosis,
    rationale,
    anchor,
    l7d_from: l7dFrom,
    l14d_from: l14dFrom,
  };
}

// =============================================================================
//  Pool Coverage / Near Misses / Exclusion Reasons / Best Historical Pool
// -----------------------------------------------------------------------------
//  These four helpers power the redesigned HR Targets main page (task #206+).
//
//  The user's diagnostic question is: "is the model's edge a pool-construction
//  problem or a ranking problem?" Each helper isolates one axis of that:
//
//    Pool Coverage     — what fraction of actual HR hitters did the model
//                        even consider? (denominator = HR hitters that day)
//    Near Misses       — of the HR hitters in the pool, where did the model
//                        rank them? (51-100, 101+, or unranked)
//    Exclusion Reasons — for HR hitters outside the top 50, WHY were they
//                        excluded? (cold penalty / low power cap / not in
//                        pool / low heat / missing data)
//    Best Historical
//    Pool              — search for criteria that would have included more
//                        unranked HR hitters in the pool. Recurring profiles
//                        across the window are the actionable patterns.
//
//  STRICT honesty rules: surfacing only. No mutation of HEAT_SCORE_WEIGHTS.
//  Treat all output as evidence — apply weight changes by hand.
// =============================================================================

const TOP_POOL_SIZE = 50;

/** Per-day pool-coverage snapshot. */
export interface CoverageDayRow {
  date: string;
  total_hr_hitters: number;
  inside_pool: number;
  outside_pool: number;
  coverage_rate: number;
}

/** Rolling-window aggregate. */
export interface CoverageWindow {
  /** Window label: "7d", "14d", "30d". */
  label: string;
  days_in_window: number;
  total_hr_hitters: number;
  inside_pool: number;
  outside_pool: number;
  coverage_rate: number;
}

export interface PoolCoverageResult {
  /** Anchor date the windows are computed against. */
  anchor: string;
  days: CoverageDayRow[];
  l7d: CoverageWindow;
  l14d: CoverageWindow;
  l30d: CoverageWindow;
  note: string;
}

function coverageWindow(
  label: string,
  rangeStart: string,
  anchor: string,
  perDay: CoverageDayRow[],
): CoverageWindow {
  let total = 0, inside = 0, outside = 0, days = 0;
  for (const d of perDay) {
    if (d.date < rangeStart || d.date > anchor) continue;
    total += d.total_hr_hitters;
    inside += d.inside_pool;
    outside += d.outside_pool;
    days += 1;
  }
  return {
    label,
    days_in_window: days,
    total_hr_hitters: total,
    inside_pool: inside,
    outside_pool: outside,
    coverage_rate: total > 0 ? inside / total : 0,
  };
}

/**
 * For each day in the window, compare the saved snapshot's player_id set
 * against the actual HR-hitter set, then roll up over 7d/14d/30d.
 *
 * "Inside pool" = player has ANY snapshot row that day (any rank), so this
 * measures POOL CONSTRUCTION, not ranking depth.
 */
export function computePoolCoverage(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  anchor: string,
): PoolCoverageResult {
  // Build per-day pool sets (player_ids in the snapshot).
  const poolByDate = new Map<string, Set<number>>();
  for (const snap of snapshots) {
    if (snap.target_date > anchor) continue;
    let s = poolByDate.get(snap.target_date);
    if (!s) { s = new Set<number>(); poolByDate.set(snap.target_date, s); }
    s.add(snap.player_id);
  }

  // Every date that has actual HR data + a snapshot for that date.
  const allDates = new Set<string>();
  for (const d of hrPlayersByDate.keys()) if (d <= anchor) allDates.add(d);
  for (const d of poolByDate.keys()) if (d <= anchor) allDates.add(d);
  const sortedDates = Array.from(allDates).sort();

  const days: CoverageDayRow[] = [];
  for (const date of sortedDates) {
    const hr = hrPlayersByDate.get(date);
    if (!hr || hr.size === 0) continue; // skip days with no actual HRs
    const pool = poolByDate.get(date) ?? new Set<number>();
    let inside = 0;
    for (const id of hr) if (pool.has(id)) inside++;
    const outside = hr.size - inside;
    days.push({
      date,
      total_hr_hitters: hr.size,
      inside_pool: inside,
      outside_pool: outside,
      coverage_rate: hr.size > 0 ? inside / hr.size : 0,
    });
  }

  const l7d = coverageWindow('7d', addDays(anchor, -6), anchor, days);
  const l14d = coverageWindow('14d', addDays(anchor, -13), anchor, days);
  const l30d = coverageWindow('30d', addDays(anchor, -29), anchor, days);

  return {
    anchor,
    days,
    l7d, l14d, l30d,
    note: 'Pool = any player_id that received a snapshot row that day. Measures pool construction (did we even consider them?), not ranking depth.',
  };
}

// -----------------------------------------------------------------------------
//  Near Misses
// -----------------------------------------------------------------------------

export interface NearMissPlayer {
  date: string;
  player_id: number;
  player_name: string;
  team: string;
  /** null = completely unranked (no snapshot row). */
  rank: number | null;
  heat_score: number | null;
  reason: string | null;
}

export interface NearMissBucket {
  label: string;          // "51-100", "101+", "Unranked"
  players: NearMissPlayer[];
  count: number;
}

export interface NearMissResult {
  /** Anchor date — most recent date covered. */
  anchor: string;
  window_days: number;
  ranked_51_100: NearMissBucket;
  ranked_101_plus: NearMissBucket;
  unranked: NearMissBucket;
  /** Aggregate across the window. */
  total_hr_hitters: number;
  total_near_misses: number;
}

/**
 * For every HR hitter in the window, classify how far the model was from
 * including them in the actionable Top 50:
 *   - 51-100  → close, ranking issue
 *   - 101+    → in pool but deeply buried
 *   - unranked → not in pool at all (construction issue)
 */
export function computeNearMisses(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  hrPlayerInfo: Map<number, { player_name: string; team: string }>,
  anchor: string,
  windowDays = 14,
): NearMissResult {
  const rangeStart = addDays(anchor, -(windowDays - 1));

  // Build (date, player_id) → snapshot row index.
  const snapByDayPlayer = new Map<string, RevAnalysisSnapshotRow>();
  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    snapByDayPlayer.set(`${snap.target_date}:${snap.player_id}`, snap);
  }

  const bucket_51_100: NearMissPlayer[] = [];
  const bucket_101_plus: NearMissPlayer[] = [];
  const bucket_unranked: NearMissPlayer[] = [];
  let total_hr = 0;
  let total_near = 0;

  for (const [date, hrSet] of hrPlayersByDate) {
    if (date < rangeStart || date > anchor) continue;
    for (const pid of hrSet) {
      total_hr += 1;
      const key = `${date}:${pid}`;
      const snap = snapByDayPlayer.get(key);
      const info = hrPlayerInfo.get(pid) ?? { player_name: `#${pid}`, team: '' };
      const player: NearMissPlayer = {
        date,
        player_id: pid,
        player_name: snap?.player_name ?? info.player_name,
        team: snap?.team ?? info.team,
        rank: snap?.rank ?? null,
        heat_score: snap?.heat_score ?? null,
        reason: snap?.reason ?? null,
      };
      if (!snap) {
        bucket_unranked.push(player); total_near++;
      } else if (snap.rank <= TOP_POOL_SIZE) {
        // Inside Top 50 — not a near miss.
        continue;
      } else if (snap.rank <= 100) {
        bucket_51_100.push(player); total_near++;
      } else {
        bucket_101_plus.push(player); total_near++;
      }
    }
  }

  const byRank = (a: NearMissPlayer, b: NearMissPlayer) => (a.rank ?? 9999) - (b.rank ?? 9999);
  const byDateThenRank = (a: NearMissPlayer, b: NearMissPlayer) => a.date < b.date ? 1 : a.date > b.date ? -1 : byRank(a, b);
  bucket_51_100.sort(byDateThenRank);
  bucket_101_plus.sort(byDateThenRank);
  bucket_unranked.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.player_name.localeCompare(b.player_name));

  return {
    anchor,
    window_days: windowDays,
    ranked_51_100: { label: '51–100', players: bucket_51_100, count: bucket_51_100.length },
    ranked_101_plus: { label: '101+', players: bucket_101_plus, count: bucket_101_plus.length },
    unranked: { label: 'Unranked', players: bucket_unranked, count: bucket_unranked.length },
    total_hr_hitters: total_hr,
    total_near_misses: total_near,
  };
}

// -----------------------------------------------------------------------------
//  Exclusion Reasons
// -----------------------------------------------------------------------------

export type ExclusionReason =
  | 'not_in_pool'
  | 'cold_batter_penalty'
  | 'low_season_power_cap'
  | 'low_heat_score'
  | 'lineup_issue'
  | 'missing_data'
  | 'weak_season_profile'
  | 'bad_recent_form'
  | 'odds_missing';

const EXCLUSION_REASON_LABEL: Record<ExclusionReason, string> = {
  not_in_pool: 'Not in model pool',
  cold_batter_penalty: 'Cold Batter penalty',
  low_season_power_cap: 'Low season power cap',
  low_heat_score: 'Low Heat Score',
  lineup_issue: 'Lineup not posted',
  missing_data: 'Missing data',
  weak_season_profile: 'Weak season profile',
  bad_recent_form: 'Bad recent form',
  odds_missing: 'Odds missing',
};

/** Threshold below which Heat Score alone explains exclusion. */
const LOW_HEAT_THRESHOLD = 40;

export interface ExcludedHrHitter {
  date: string;
  player_id: number;
  player_name: string;
  team: string;
  rank: number | null;
  heat_score: number | null;
  reasons: ExclusionReason[];
}

export interface ExclusionReasonAggregate {
  reason: ExclusionReason;
  label: string;
  /** Number of excluded HR hitters that triggered this reason in the window. */
  count: number;
  /** Share of all exclusions (multi-cause sums >100% — same player can have multiple). */
  share: number;
}

export interface ExclusionReasonsResult {
  anchor: string;
  window_days: number;
  /** Every HR hitter outside Top 50 in the window, with their reason chips. */
  excluded: ExcludedHrHitter[];
  /** Aggregate counts per reason. */
  aggregates: ExclusionReasonAggregate[];
  /** Total HR hitters in the window. */
  total_hr_hitters: number;
  /** How many of those were OUTSIDE the actionable Top 50. */
  total_excluded: number;
}

/**
 * For every HR hitter NOT in the saved Top 50, build the list of reasons
 * the model excluded them. Multiple reasons can fire per player (a cold
 * batter with low season power gets both chips).
 *
 * Categories:
 *   not_in_pool       — no snapshot row at all
 *   cold_batter_penalty — "Cold last 7d" chip present
 *   low_season_power_cap — "low_season_power" derived signal (no power chip)
 *   low_heat_score    — heat_score < LOW_HEAT_THRESHOLD and no specific penalty
 *   lineup_issue      — reason mentions "Lineup pending" or absent (only some snapshots carry this)
 *   missing_data      — reason is null/empty or "Data limited"
 */
export function computeExclusionReasons(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  hrPlayerInfo: Map<number, { player_name: string; team: string }>,
  anchor: string,
  windowDays = 14,
): ExclusionReasonsResult {
  const rangeStart = addDays(anchor, -(windowDays - 1));
  const snapByDayPlayer = new Map<string, RevAnalysisSnapshotRow>();
  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    snapByDayPlayer.set(`${snap.target_date}:${snap.player_id}`, snap);
  }

  const excluded: ExcludedHrHitter[] = [];
  const reasonCounts = new Map<ExclusionReason, number>();
  let total_hr = 0;
  let total_excluded = 0;

  for (const [date, hrSet] of hrPlayersByDate) {
    if (date < rangeStart || date > anchor) continue;
    for (const pid of hrSet) {
      total_hr += 1;
      const snap = snapByDayPlayer.get(`${date}:${pid}`);
      // Inside Top 50 → not excluded
      if (snap && snap.rank <= TOP_POOL_SIZE) continue;
      total_excluded += 1;
      const info = hrPlayerInfo.get(pid) ?? { player_name: `#${pid}`, team: '' };
      const reasons: ExclusionReason[] = [];
      if (!snap) {
        reasons.push('not_in_pool');
      } else {
        const reasonText = snap.reason ?? '';
        const signals = parseSignalsFromReason(snap.reason);
        if (signals.has('cold_batter')) reasons.push('cold_batter_penalty');
        if (signals.has('low_season_power')) reasons.push('low_season_power_cap');
        if (/Lineup pending|Lineup unconfirmed/i.test(reasonText)) reasons.push('lineup_issue');
        if (/Data limited/i.test(reasonText) || !reasonText) reasons.push('missing_data');
        // Heat score gate — only if no specific reason already caught it.
        if (reasons.length === 0 && (snap.heat_score < LOW_HEAT_THRESHOLD)) reasons.push('low_heat_score');
        // Fallback when nothing specific fired.
        if (reasons.length === 0) reasons.push('weak_season_profile');
      }
      const row: ExcludedHrHitter = {
        date,
        player_id: pid,
        player_name: snap?.player_name ?? info.player_name,
        team: snap?.team ?? info.team,
        rank: snap?.rank ?? null,
        heat_score: snap?.heat_score ?? null,
        reasons,
      };
      excluded.push(row);
      for (const r of reasons) {
        reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
      }
    }
  }

  const aggregates: ExclusionReasonAggregate[] = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({
      reason,
      label: EXCLUSION_REASON_LABEL[reason],
      count,
      share: total_excluded > 0 ? count / total_excluded : 0,
    }))
    .sort((a, b) => b.count - a.count);

  excluded.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (a.rank ?? 9999) - (b.rank ?? 9999));

  return {
    anchor,
    window_days: windowDays,
    excluded,
    aggregates,
    total_hr_hitters: total_hr,
    total_excluded,
  };
}

// -----------------------------------------------------------------------------
//  Best Historical Pool
// -----------------------------------------------------------------------------

export interface BestPoolDay {
  date: string;
  current_pool_size: number;
  current_hr_hits_in_pool: number;
  current_coverage: number;
  reconstructed_pool_size: number;
  reconstructed_hr_hits_in_pool: number;
  reconstructed_coverage: number;
  /** Players gained = HR hitters newly INCLUDED in the pool. */
  gained: { player_id: number; player_name: string; team: string; signals: SignalKey[] }[];
  /** Signals (criteria) on the gained players, used to derive recurring patterns. */
  criteria_used: SignalKey[];
}

export interface RecurringPoolCriterion {
  signal: SignalKey;
  label: string;
  /** Days this signal appeared on gained players. */
  days_present: number;
  total_days: number;
  /** Total players gained across the window who had this signal. */
  player_count: number;
}

export interface BestPoolResult {
  anchor: string;
  window_days: number;
  days: BestPoolDay[];
  current_pool_coverage: number;
  reconstructed_pool_coverage: number;
  total_gained: number;
  recurring: RecurringPoolCriterion[];
  note: string;
}

/**
 * Best Historical Pool — for each past day, identify what criteria the
 * UNRANKED HR hitters had in common (the snapshot rows DON'T exist for them
 * since they were excluded, so we can't read reason text for unranked
 * players). For this v1 we surface a simpler diagnostic: how many HR
 * hitters would the pool have caught if we extended snapshots to rank 100
 * vs rank 50? And of HR hitters AT THE EDGE (rank 51-100), what signal
 * profiles repeated across days?
 *
 * This is hindsight research — NOT a live prediction.
 */
export function computeBestHistoricalPool(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  hrPlayerInfo: Map<number, { player_name: string; team: string }>,
  anchor: string,
  windowDays = 14,
): BestPoolResult {
  const rangeStart = addDays(anchor, -(windowDays - 1));

  // Per-day index: full snapshot pool, edge snapshot pool (rank 51-100).
  type DayIdx = {
    poolIds: Set<number>;
    edgeRows: RevAnalysisSnapshotRow[];
  };
  const byDate = new Map<string, DayIdx>();
  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    let idx = byDate.get(snap.target_date);
    if (!idx) { idx = { poolIds: new Set(), edgeRows: [] }; byDate.set(snap.target_date, idx); }
    idx.poolIds.add(snap.player_id);
    if (snap.rank > TOP_POOL_SIZE && snap.rank <= 100) idx.edgeRows.push(snap);
  }

  const days: BestPoolDay[] = [];
  const signalDayCounts = new Map<SignalKey, Set<string>>();
  const signalPlayerCounts = new Map<SignalKey, number>();
  let totalCurrentInPool = 0;
  let totalReconstructedInPool = 0;
  let totalHr = 0;
  let totalGained = 0;

  // Build actionable-pool index (rank ≤ TOP_POOL_SIZE) per date — separate
  // from the full pool. The reconstruction promotes rank 51–100 HR hitters
  // INTO the actionable pool.
  const actionableByDate = new Map<string, Set<number>>();
  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    if (snap.rank > TOP_POOL_SIZE) continue;
    let s = actionableByDate.get(snap.target_date);
    if (!s) { s = new Set<number>(); actionableByDate.set(snap.target_date, s); }
    s.add(snap.player_id);
  }

  const sortedDates = Array.from(byDate.keys()).sort();
  for (const date of sortedDates) {
    const idx = byDate.get(date)!;
    const actionable = actionableByDate.get(date) ?? new Set<number>();
    const hrSet = hrPlayersByDate.get(date) ?? new Set<number>();
    totalHr += hrSet.size;

    // Current actionable-pool coverage = HR hitters in rank ≤ TOP_POOL_SIZE.
    let currentIn = 0;
    for (const pid of hrSet) if (actionable.has(pid)) currentIn++;
    totalCurrentInPool += currentIn;

    // Reconstructed: promote rank 51–100 HR hitters into the actionable pool.
    const gained: BestPoolDay['gained'] = [];
    const dayCriteria = new Set<SignalKey>();
    for (const snap of idx.edgeRows) {
      if (!hrSet.has(snap.player_id)) continue;
      const signals = Array.from(parseSignalsFromReason(snap.reason));
      const info = hrPlayerInfo.get(snap.player_id) ?? { player_name: snap.player_name ?? `#${snap.player_id}`, team: snap.team ?? '' };
      gained.push({
        player_id: snap.player_id,
        player_name: snap.player_name ?? info.player_name,
        team: snap.team ?? info.team,
        signals,
      });
      for (const s of signals) {
        dayCriteria.add(s);
        let ds = signalDayCounts.get(s);
        if (!ds) { ds = new Set<string>(); signalDayCounts.set(s, ds); }
        ds.add(date);
        signalPlayerCounts.set(s, (signalPlayerCounts.get(s) ?? 0) + 1);
      }
    }
    const reconstructedIn = currentIn + gained.length;
    totalReconstructedInPool += reconstructedIn;
    totalGained += gained.length;

    days.push({
      date,
      current_pool_size: actionable.size,
      current_hr_hits_in_pool: currentIn,
      current_coverage: hrSet.size > 0 ? currentIn / hrSet.size : 0,
      reconstructed_pool_size: actionable.size + gained.length,
      reconstructed_hr_hits_in_pool: reconstructedIn,
      reconstructed_coverage: hrSet.size > 0 ? reconstructedIn / hrSet.size : 0,
      gained,
      criteria_used: Array.from(dayCriteria),
    });
  }

  const recurring: RecurringPoolCriterion[] = Array.from(signalDayCounts.entries())
    .map(([signal, dateSet]) => ({
      signal,
      label: SIGNAL_LABELS[signal],
      days_present: dateSet.size,
      total_days: days.length,
      player_count: signalPlayerCounts.get(signal) ?? 0,
    }))
    .filter((r) => r.days_present >= 2)
    .sort((a, b) => b.days_present - a.days_present || b.player_count - a.player_count);

  return {
    anchor,
    window_days: windowDays,
    days,
    current_pool_coverage: totalHr > 0 ? totalCurrentInPool / totalHr : 0,
    reconstructed_pool_coverage: totalHr > 0 ? totalReconstructedInPool / totalHr : 0,
    total_gained: totalGained,
    recurring,
    note: 'Hindsight pool reconstruction — looks at HR hitters ranked 51–100 who would be promoted into a "actionable Top 100" pool. Surfaces signal profiles that repeat across days. NOT a live prediction tool.',
  };
}

// =============================================================================
//  Miss Quality Analysis + Top-N Efficiency (task #217)
// -----------------------------------------------------------------------------
//  Reframe the optimizer goal: STOP chasing perfect 10/10 hindsight Top 10s
//  (overfit to specific players) and START identifying recurring traits the
//  model is systematically underweighting.
//
//  Two outputs:
//
//  MISS QUALITY ANALYSIS
//    For HR hitters the model missed, bucket them by snapshot rank:
//      51-100   — close miss, ranking nudge would fix
//      101-150  — deeper miss, pool present but rank weak
//      151-200  — pool edge
//      200+     — barely in pool
//      unranked — not in pool at all
//    Per bucket aggregate the realistic-candidate proxies:
//      • avg_season_hr        — power tier (high = realistic candidate)
//      • avg_american_odds    — sportsbook expectation
//      • avg_heat_score
//      • park_signal_rate     — % of bucket with Power Park chip
//      • hr_pitcher_rate      — % with HR Pitcher chip
//      • weather_signal_rate  — % with Wind Out OR Warm chip
//      • cold_penalty_rate    — % with Cold Batter chip
//    Plus a side-by-side comparison row: Top 10 vs Top 25 vs Top 50 vs Missed.
//    This answers: are we missing realistic candidates, or random longshots?
//
//  TOP-N EFFICIENCY
//    The right betting-relevant metrics:
//      • Top 5 efficiency   = hits in Top 5  / 5  (10-day daily betting size)
//      • Top 10 efficiency  = hits in Top 10 / 10
//      • Top 25 coverage    = HR hitters caught in Top 25 / total HR hitters
//    These replace the "perfect 10/10" hindsight target.
// =============================================================================

/** Range descriptor for miss-quality bucketing. */
const MISS_BUCKETS: { id: string; label: string; min: number; max: number }[] = [
  { id: '51_100', label: '51–100',  min: 51,  max: 100 },
  { id: '101_150', label: '101–150', min: 101, max: 150 },
  { id: '151_200', label: '151–200', min: 151, max: 200 },
  { id: '200_plus', label: '200+',   min: 201, max: Infinity },
];

/** Quality metrics for one bucket (or for a slice like "Top 10"). */
export interface MissQualityMetrics {
  /** Group label: "51-100", "Top 10", etc. */
  label: string;
  /** Number of player-days in this group. */
  n: number;
  /** Average season HR count (lookup at the snapshot's target_date). */
  avg_season_hr: number;
  /** Average American odds (positive numbers like +450). null if no odds samples. */
  avg_american_odds: number | null;
  /** Number of bucket members that had an odds row. */
  odds_n: number;
  avg_heat_score: number;
  /** % of bucket members with a Power Park signal (0..1). */
  park_signal_rate: number;
  /** % with HR Pitcher signal. */
  hr_pitcher_rate: number;
  /** % with Wind Out OR Warm weather signal. */
  weather_signal_rate: number;
  /** % with Cold Batter signal. */
  cold_penalty_rate: number;
  /** % with Elite Power signal. */
  elite_power_rate: number;
  /** Bonus for the missed-HR buckets: share of total misses (rate of all misses). */
  share_of_misses?: number;
}

export interface MissQualityResult {
  anchor: string;
  window_days: number;
  total_hr_hitters: number;
  total_missed: number;
  /** Bucketed missed-HR analysis. */
  buckets: MissQualityMetrics[];
  /** Same metrics across the model's own slices. */
  top10: MissQualityMetrics;
  top25: MissQualityMetrics;
  top50: MissQualityMetrics;
  /** Same metrics across ALL missed HR hitters. */
  missed_overall: MissQualityMetrics;
  /** Plain-English diagnosis of what the misses suggest. */
  diagnosis: string;
  note: string;
}

/** Map of (target_date, player_id) → cumulative season HR through that
 *  target_date. Built by the caller from the home_runs table. */
export type SeasonHrIndex = Map<string, number>;
/** Map of (target_date, player_id) → latest american odds for that target_date. */
export type OddsIndex = Map<string, number>;

function emptyMetrics(label: string): MissQualityMetrics {
  return {
    label, n: 0,
    avg_season_hr: 0,
    avg_american_odds: null,
    odds_n: 0,
    avg_heat_score: 0,
    park_signal_rate: 0,
    hr_pitcher_rate: 0,
    weather_signal_rate: 0,
    cold_penalty_rate: 0,
    elite_power_rate: 0,
  };
}

/** Aggregate a set of (snapshot, signals, season_hr, odds) tuples into a
 *  single MissQualityMetrics row. */
function aggregateMetrics(
  label: string,
  rows: Array<{
    heat_score: number;
    season_hr: number | null;
    american_odds: number | null;
    signals: Set<SignalKey>;
  }>,
): MissQualityMetrics {
  const out = emptyMetrics(label);
  if (rows.length === 0) return out;
  let totalSeason = 0, seasonN = 0;
  let totalOdds = 0, oddsN = 0;
  let totalHeat = 0;
  let park = 0, hrp = 0, weather = 0, cold = 0, elite = 0;
  for (const r of rows) {
    totalHeat += r.heat_score;
    if (r.season_hr != null) { totalSeason += r.season_hr; seasonN++; }
    if (r.american_odds != null) { totalOdds += r.american_odds; oddsN++; }
    if (r.signals.has('power_park')) park++;
    if (r.signals.has('hr_pitcher')) hrp++;
    if (r.signals.has('wind_out') || r.signals.has('warm_weather')) weather++;
    if (r.signals.has('cold_batter')) cold++;
    if (r.signals.has('elite_power')) elite++;
  }
  out.n = rows.length;
  out.avg_season_hr = seasonN > 0 ? totalSeason / seasonN : 0;
  out.avg_american_odds = oddsN > 0 ? totalOdds / oddsN : null;
  out.odds_n = oddsN;
  out.avg_heat_score = totalHeat / rows.length;
  out.park_signal_rate = park / rows.length;
  out.hr_pitcher_rate = hrp / rows.length;
  out.weather_signal_rate = weather / rows.length;
  out.cold_penalty_rate = cold / rows.length;
  out.elite_power_rate = elite / rows.length;
  return out;
}

/** Produce a plain-English diagnosis of the miss-quality data. */
function diagnoseMissQuality(top10: MissQualityMetrics, missed: MissQualityMetrics): string {
  // If missed HR hitters have meaningfully higher season HR than Top 10
  // → the model is underweighting elite power.
  // If missed odds are similar to Top 10 odds → realistic candidates being missed.
  // If missed odds are far longer (more positive) → mostly random longshots and variance.
  const seasonGap = missed.avg_season_hr - top10.avg_season_hr;
  const top10Odds = top10.avg_american_odds ?? 0;
  const missedOdds = missed.avg_american_odds ?? 0;
  const oddsClose = top10Odds > 0 && missedOdds > 0 && missedOdds < top10Odds * 1.8;
  const oddsFar = missedOdds > top10Odds * 2.5;

  if (missed.n < 20) {
    return `Only ${missed.n} missed HR-player-days — sample too small for a confident call.`;
  }
  if (seasonGap >= 3 && oddsClose) {
    return `Missed HR hitters average ${missed.avg_season_hr.toFixed(1)} season HR vs Top 10's ${top10.avg_season_hr.toFixed(1)}, with similar sportsbook expectations. Model is systematically underweighting realistic, well-priced power hitters — a rankings problem, not a variance problem.`;
  }
  if (oddsFar) {
    return `Missed HRs average odds around ${missedOdds > 0 ? '+' : ''}${Math.round(missedOdds)} vs Top 10's ${top10Odds > 0 ? '+' : ''}${Math.round(top10Odds)} — most misses are sportsbook longshots / random variance, not realistic candidates the model could have caught.`;
  }
  if (seasonGap >= 2) {
    return `Missed HR hitters have moderately higher season HR than Top 10 — some real candidates leaking out of the pool. Worth investigating the underlying chip profile in the buckets below.`;
  }
  return `Missed HR hitters and Top 10 picks have similar power + market profiles. Variance is doing most of the work — not a clear rankings problem.`;
}

/**
 * Build the Miss Quality Analysis over the window. Returns per-rank-bucket
 * stats plus the side-by-side comparison row.
 *
 * @param snapshots all snapshot rows in the window
 * @param hrPlayersByDate game_date → set of HR player_ids
 * @param hrPlayerInfo for fallback names of unranked HR hitters
 * @param seasonHrAt (target_date, player_id) → season HR count up through that date
 * @param oddsAt (target_date, player_id) → american odds
 * @param anchor right-edge date (typically yesterday)
 * @param windowDays defaults to 14
 */
export function computeMissQualityAnalysis(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  hrPlayerInfo: Map<number, { player_name: string; team: string }>,
  seasonHrAt: SeasonHrIndex,
  oddsAt: OddsIndex,
  anchor: string,
  windowDays = 14,
): MissQualityResult {
  const rangeStart = addDays(anchor, -(windowDays - 1));

  // Pre-index snapshot rows by (date, player_id) for quick lookup.
  const snapByDayPlayer = new Map<string, RevAnalysisSnapshotRow>();
  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    snapByDayPlayer.set(`${snap.target_date}:${snap.player_id}`, snap);
  }

  // Tally buckets for MISSED HR hitters.
  const bucketRows: Record<string, Array<{ heat_score: number; season_hr: number | null; american_odds: number | null; signals: Set<SignalKey> }>> = {};
  for (const b of MISS_BUCKETS) bucketRows[b.id] = [];
  const unrankedRows: Array<{ heat_score: number; season_hr: number | null; american_odds: number | null; signals: Set<SignalKey> }> = [];
  const top10Rows: typeof unrankedRows = [];
  const top25Rows: typeof unrankedRows = [];
  const top50Rows: typeof unrankedRows = [];
  const missedRows: typeof unrankedRows = [];

  let totalHr = 0;
  let totalMissed = 0;

  // First pass: aggregate Top 10/25/50 metrics over the window.
  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    const key = `${snap.target_date}:${snap.player_id}`;
    const signals = parseSignalsFromReason(snap.reason);
    const row = {
      heat_score: snap.heat_score,
      season_hr: seasonHrAt.get(key) ?? null,
      american_odds: oddsAt.get(key) ?? null,
      signals,
    };
    if (snap.rank <= 10) top10Rows.push(row);
    if (snap.rank <= 25) top25Rows.push(row);
    if (snap.rank <= 50) top50Rows.push(row);
  }

  // Second pass: for every actual HR hitter, classify by snapshot rank.
  for (const [date, hrSet] of hrPlayersByDate) {
    if (date < rangeStart || date > anchor) continue;
    for (const pid of hrSet) {
      totalHr += 1;
      const key = `${date}:${pid}`;
      const snap = snapByDayPlayer.get(key);
      // Inside Top 50 → not a miss
      if (snap && snap.rank <= 50) continue;
      totalMissed += 1;
      const signals = snap ? parseSignalsFromReason(snap.reason) : new Set<SignalKey>();
      const row = {
        heat_score: snap?.heat_score ?? 0,
        season_hr: seasonHrAt.get(key) ?? null,
        american_odds: oddsAt.get(key) ?? null,
        signals,
      };
      missedRows.push(row);
      if (!snap) {
        unrankedRows.push(row);
      } else {
        const bucket = MISS_BUCKETS.find((b) => snap.rank >= b.min && snap.rank <= b.max);
        if (bucket) bucketRows[bucket.id].push(row);
      }
    }
  }

  // Build per-bucket metrics, including the share_of_misses field.
  const buckets: MissQualityMetrics[] = MISS_BUCKETS.map((b) => {
    const m = aggregateMetrics(b.label, bucketRows[b.id]);
    m.share_of_misses = totalMissed > 0 ? m.n / totalMissed : 0;
    return m;
  });
  const unrankedMetrics = aggregateMetrics('Unranked', unrankedRows);
  unrankedMetrics.share_of_misses = totalMissed > 0 ? unrankedMetrics.n / totalMissed : 0;
  buckets.push(unrankedMetrics);

  const top10 = aggregateMetrics('Top 10', top10Rows);
  const top25 = aggregateMetrics('Top 25', top25Rows);
  const top50 = aggregateMetrics('Top 50', top50Rows);
  const missedOverall = aggregateMetrics('Missed HRs', missedRows);

  const diagnosis = diagnoseMissQuality(top10, missedOverall);

  return {
    anchor,
    window_days: windowDays,
    total_hr_hitters: totalHr,
    total_missed: totalMissed,
    buckets,
    top10, top25, top50,
    missed_overall: missedOverall,
    diagnosis,
    note: 'Park / HR Pitcher / Weather / Cold metrics are SIGNAL-PRESENCE rates (% of bucket with the chip), not numeric scores. Batting order position is not tracked in snapshots yet — shown as "—".',
  };
}

// -----------------------------------------------------------------------------
//  Top-N Efficiency (replaces "perfect 10/10" optimizer target)
// -----------------------------------------------------------------------------

export interface TopNEfficiencyResult {
  anchor: string;
  window_days: number;
  days_counted: number;
  /** Hits in Top 5 / 5 / days. */
  top5_efficiency: number;
  top5_hits: number;
  top5_slots: number;
  /** Hits in Top 10 / 10 / days. */
  top10_efficiency: number;
  top10_hits: number;
  top10_slots: number;
  /** Top 25 COVERAGE — share of total HR hitters caught in Top 25. */
  top25_coverage: number;
  top25_hits: number;
  total_hr_hitters: number;
  note: string;
}

/**
 * The right betting-relevant optimizer metrics:
 *   • Top 5 efficiency = how often each top-5 slot homers (5-bet daily basis)
 *   • Top 10 efficiency = same for Top 10 (10-bet daily basis)
 *   • Top 25 coverage = of all HR hitters that day, how many in Top 25
 *
 * These replace "perfect 10/10 hindsight" as the optimizer target — they
 * reward the model for the bets the user actually places.
 */
export function computeTopNEfficiency(
  snapshots: RevAnalysisSnapshotRow[],
  hrPlayersByDate: Map<string, Set<number>>,
  anchor: string,
  windowDays = 14,
): TopNEfficiencyResult {
  const rangeStart = addDays(anchor, -(windowDays - 1));
  // Per-date set of player_ids in Top N.
  const top5ByDate = new Map<string, Set<number>>();
  const top10ByDate = new Map<string, Set<number>>();
  const top25ByDate = new Map<string, Set<number>>();

  for (const snap of snapshots) {
    if (snap.target_date < rangeStart || snap.target_date > anchor) continue;
    if (snap.rank > 25) continue;
    const set5 = top5ByDate.get(snap.target_date) ?? new Set<number>();
    const set10 = top10ByDate.get(snap.target_date) ?? new Set<number>();
    const set25 = top25ByDate.get(snap.target_date) ?? new Set<number>();
    if (snap.rank <= 5) set5.add(snap.player_id);
    if (snap.rank <= 10) set10.add(snap.player_id);
    set25.add(snap.player_id);
    top5ByDate.set(snap.target_date, set5);
    top10ByDate.set(snap.target_date, set10);
    top25ByDate.set(snap.target_date, set25);
  }

  let top5Hits = 0, top10Hits = 0, top25Hits = 0;
  let top5Slots = 0, top10Slots = 0;
  let totalHr = 0;
  let daysCounted = 0;
  const dates = new Set<string>();
  for (const d of hrPlayersByDate.keys()) {
    if (d < rangeStart || d > anchor) continue;
    dates.add(d);
  }
  for (const d of top25ByDate.keys()) {
    if (d < rangeStart || d > anchor) continue;
    dates.add(d);
  }

  for (const date of dates) {
    daysCounted += 1;
    const hrSet = hrPlayersByDate.get(date) ?? new Set<number>();
    totalHr += hrSet.size;
    const t5 = top5ByDate.get(date) ?? new Set<number>();
    const t10 = top10ByDate.get(date) ?? new Set<number>();
    const t25 = top25ByDate.get(date) ?? new Set<number>();
    top5Slots += t5.size;       // typically 5 unless the snapshot is short
    top10Slots += t10.size;     // typically 10
    for (const pid of hrSet) {
      if (t5.has(pid)) top5Hits++;
      if (t10.has(pid)) top10Hits++;
      if (t25.has(pid)) top25Hits++;
    }
  }

  return {
    anchor,
    window_days: windowDays,
    days_counted: daysCounted,
    top5_efficiency: top5Slots > 0 ? top5Hits / top5Slots : 0,
    top5_hits: top5Hits,
    top5_slots: top5Slots,
    top10_efficiency: top10Slots > 0 ? top10Hits / top10Slots : 0,
    top10_hits: top10Hits,
    top10_slots: top10Slots,
    top25_coverage: totalHr > 0 ? top25Hits / totalHr : 0,
    top25_hits: top25Hits,
    total_hr_hitters: totalHr,
    note: 'Betting-relevant metrics: Top 5/10 efficiency = per-bet hit rate; Top 25 coverage = % of all HR hitters caught in the actionable pool.',
  };
}
