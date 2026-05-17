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
  /** Maximum heat score for capped players. */
  cap: 30,
} as const;

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
        const penalty = -10;
        heat += penalty;
        cold_penalty += penalty;
        adjustments.push({
          label: `Cold streak — 0 HR L5 games + 0 HR L7 days (${season_hr} season HR)`,
          delta: penalty,
        });
      } else if (isQuiet && season_hr >= 8) {
        const penalty = -5;
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

    return {
      game_pk: g.game_pk,
      game_date: g.game_date,
      away_team: g.away_team,
      home_team: g.home_team,
      venue_name: g.venue_name,
      away_facing: awayFacing,
      home_facing: homeFacing,
      away_targets: rankForTeam(g.away_team, g.home_team, g.venue_name, awayFacing, weatherCtx),
      home_targets: rankForTeam(g.home_team, g.away_team, g.venue_name, homeFacing, weatherCtx),
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
