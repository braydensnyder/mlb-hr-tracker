/**
 * snapshotHrTargets — compute the Top-N HR target ranking for a date and
 * persist it into `hr_target_snapshots` so the Backtest page can later
 * compare predicted hitters against actual HRs.
 *
 * The exact same model the HR Targets page uses runs server-side here
 * (imported from `src/lib/stats.ts`). Stats are anchored at `asOf = date - 1`
 * to avoid leakage from the day's games into their own prediction.
 *
 * Required tables: `home_runs` and `games` only.
 * Optional tables: `pitcher_starts` (richer pitcher form) and
 *   `hr_target_snapshots` (the destination — must exist).
 *
 * Notably, this script does NOT require a `players` catalog table.
 * The player index (name + team) is derived from `home_runs` itself —
 * see derivePlayerIndexFromHrs() below.
 *
 * Idempotent: by default, skips dates that already have a snapshot.
 * `--force` wipes and re-inserts. Per-step failures (pitcher_starts
 * unavailable, etc.) degrade gracefully — the model accepts missing inputs.
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import {
  applyCanonicalTeams,
  computeHrTargets,
  pitcherHrLeaderboard,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  type HomeRunRow,
  type HrTarget,
  type HrTargetGame,
  type PitcherFormLite,
  type PlayerTeamIndex,
} from '../src/lib/stats.js';

export interface SnapshotResult {
  date: string;
  asOf: string;
  generated: number;
  inserted: number;
  skipped: boolean;
  snapshot_type?: 'live' | 'simulated';
}

export interface SnapshotOptions {
  /** Top N rows to persist. Default 50. The Backtest page uses top 10/5/3 of those. */
  limit?: number;
  /** Overwrite an existing snapshot for the date. */
  force?: boolean;
  /** If true (and !force), abort without inserting when any game on
   *  target_date has already started. Enforces "pre-game only" semantics
   *  for the orchestrator — Backtest needs honest pre-game rankings, not
   *  ones contaminated by same-day results. The manual CLI defaults to
   *  false so an operator can deliberately take a simulated snapshot. */
  skipIfGamesStarted?: boolean;
  /** Override the auto-detected snapshot_type. If omitted, auto-detected:
   *  'simulated' when target_date is in the past OR any game already started;
   *  'live' otherwise. */
  snapshotType?: 'live' | 'simulated';
}

/** Statuses that indicate a game has progressed past pre-game state. */
const STARTED_STATUSES = new Set(['In Progress', 'Final', 'Game Over', 'Completed Early', 'Suspended']);

function todayISO_local(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Decide whether a snapshot for `targetDate` should be tagged 'live' or
 * 'simulated' given the current set of games and their statuses.
 */
export function deriveSnapshotType(targetDate: string, games: { status: string }[]): 'live' | 'simulated' {
  const today = todayISO_local();
  if (targetDate < today) return 'simulated';
  if (games.some((g) => STARTED_STATUSES.has(g.status))) return 'simulated';
  return 'live';
}

const PAGE = 1000;

function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

async function countExistingSnapshot(targetDate: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('hr_target_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('target_date', targetDate);
  if (error) throw new Error(`count snapshot failed: ${error.message}`);
  return count ?? 0;
}

async function fetchSeasonHrs(asOf: string): Promise<HomeRunRow[]> {
  const seasonStart = `${asOf.slice(0, 4)}-01-01`;
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('*')
      .gte('game_date', seasonStart)
      .lte('game_date', asOf)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`fetch home_runs failed: ${error.message}`);
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

async function fetchGamesOn(date: string): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('game_date', date)
    .order('game_pk', { ascending: true });
  if (error) throw new Error(`fetch games failed: ${error.message}`);
  return data ?? [];
}

/**
 * Build a player index from `home_runs` without depending on a `players`
 * catalog table. For each player_id, takes the MOST RECENT (name, team)
 * observed in the HR rows — caller passes seasonHrs already sorted desc
 * by game_date so the first occurrence is the freshest.
 *
 * This is "good enough" for snapshotting because:
 *   1. applyCanonicalTeams just remaps each row's team to whatever team
 *      the player was last listed under. Mid-season trades collapse into
 *      the current team naturally.
 *   2. Elite-power detection (ELITE_POWER_NAMES) matches on player_name,
 *      and the MLB API gives stable full names — so Aaron Judge in
 *      home_runs.player_name will match the curated list.
 *   3. Game lookup (`team@opponent`) compares against games.home_team /
 *      games.away_team, both of which come from the schedule API. A
 *      player's most-recent team string is normally an MLB team name
 *      that matches games rows exactly. Any non-MLB residue (e.g. a
 *      WBC row stuck in the season) simply fails the game lookup and
 *      that target gets filtered out — which is the correct behavior.
 */
function derivePlayerIndexFromHrs(seasonHrs: HomeRunRow[]): PlayerTeamIndex {
  const map = new Map<number, { team: string | null; full_name: string | null }>();
  for (const r of seasonHrs) {
    if (!map.has(r.player_id)) {
      map.set(r.player_id, { team: r.team, full_name: r.player_name });
    }
  }
  return map;
}

async function fetchPitcherFormForDate(pitcherIds: number[], asOf: string): Promise<Map<number, PitcherFormLite>> {
  const out = new Map<number, PitcherFormLite>();
  if (pitcherIds.length === 0) return out;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const fourteenStart = addDays(asOf, -13);

  const CHUNK = 200;
  const allStarts: any[] = [];
  for (let i = 0; i < pitcherIds.length; i += CHUNK) {
    const slice = pitcherIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('pitcher_starts')
      .select('*')
      .in('pitcher_id', slice)
      .gte('game_date', yearStart)
      .lte('game_date', asOf)
      .order('game_date', { ascending: false });
    if (error) throw new Error(`fetch pitcher_starts failed: ${error.message}`);
    allStarts.push(...(data ?? []));
  }

  const buckets = new Map<number, any[]>();
  for (const s of allStarts) {
    let arr = buckets.get(s.pitcher_id);
    if (!arr) { arr = []; buckets.set(s.pitcher_id, arr); }
    arr.push(s);
  }

  for (const [pid, starts] of buckets) {
    const last3 = starts.slice(0, 3);
    const last5 = starts.slice(0, 5);
    const sum = (rs: any[]) => rs.reduce((acc, r) => acc + (r.home_runs_allowed ?? 0), 0);
    const l14 = starts.filter((r) => r.game_date >= fourteenStart).reduce((acc, r) => acc + (r.home_runs_allowed ?? 0), 0);
    const hand = starts.find((s) => s.pitcher_hand)?.pitcher_hand ?? null;
    out.set(pid, {
      pitcher_id: pid,
      pitcher_throws: hand,
      allowed_last_14_days: l14,
      allowed_last_3_starts: sum(last3),
      allowed_last_5_starts: sum(last5),
      season_hr_allowed: sum(starts),
      starts_known: starts.length,
    });
  }
  return out;
}

export async function snapshotHrTargets(date: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const limit = opts.limit ?? 50;
  const force = !!opts.force;
  const asOf = addDays(date, -1);

  console.log(`[snapshotHrTargets] date=${date} asOf=${asOf} limit=${limit}${force ? ' force' : ''}`);

  // 1. Idempotency check
  const existing = await countExistingSnapshot(date);
  if (existing > 0 && !force) {
    console.log(`  ${existing} row(s) already exist for ${date}. Skipping (use --force to overwrite).`);
    return { date, asOf, generated: 0, inserted: 0, skipped: true };
  }

  // 2. Fetch inputs in parallel — derive the player index from home_runs
  //    rather than depending on a separate `players` catalog table. This
  //    keeps the snapshotter self-sufficient: only home_runs + games are
  //    required to ship a snapshot.
  const [seasonHrs, games] = await Promise.all([
    fetchSeasonHrs(asOf),
    fetchGamesOn(date),
  ]);
  const playerIndex = derivePlayerIndexFromHrs(seasonHrs);
  console.log(
    `  inputs: ${seasonHrs.length} HRs, ${games.length} games, ` +
      `${playerIndex.size} players (derived from home_runs)`,
  );
  if (games.length === 0) {
    console.log(`  no scheduled games on ${date} — nothing to snapshot.`);
    return { date, asOf, generated: 0, inserted: 0, skipped: false };
  }

  // ---- pre-game purity check + snapshot_type detection ----
  // For an honest Backtest, snapshots should be taken BEFORE first pitch.
  // If any of the date's games are already in progress or done, the
  // computed targets may have been informed by same-day results — and
  // the snapshot gets tagged 'simulated' rather than 'live'.
  const startedCount = games.filter((g) => STARTED_STATUSES.has(g.status)).length;
  const snapshotType: 'live' | 'simulated' =
    opts.snapshotType ?? deriveSnapshotType(date, games);

  // Pre-game-only enforcement: when called from update:daily (which sets
  // skipIfGamesStarted=true), abort entirely if games have started. The
  // orchestrator should never create a contaminated snapshot. --force
  // bypasses this so an operator can take a deliberate post-start snapshot.
  if (startedCount > 0 && opts.skipIfGamesStarted && !force) {
    const msg = `${startedCount}/${games.length} game(s) on ${date} have already started — skipping (pre-game-only mode). Use --force to override.`;
    console.warn(`  ⚠ ${msg}`);
    return { date, asOf, generated: 0, inserted: 0, skipped: true, snapshot_type: snapshotType };
  }

  if (startedCount > 0 && snapshotType === 'simulated') {
    console.warn(
      `  ⚠ Snapshot may not be clean pre-game — ${startedCount}/${games.length} game(s) on ${date} have already started/finished. Tagged as snapshot_type='simulated'.`,
    );
  } else if (snapshotType === 'simulated') {
    console.log(`  snapshot_type='simulated' (target_date is in the past)`);
  } else {
    console.log(`  snapshot_type='live' (pre-game)`);
  }

  // 3. Canonical-team remap + indexes (same as HrTargets.tsx does in the UI)
  const canonHrs = applyCanonicalTeams(seasonHrs, playerIndex);

  // Pitcher form: prefer real pitcher_starts data; the homeRuns approximation
  // backfills any pitcher who isn't in pitcher_starts yet.
  const pitcherBoard = pitcherHrLeaderboard(canonHrs, asOf);
  const approxPitcher = new Map<number, PitcherFormLite>(
    pitcherBoard.map((p) => [p.pitcher_id, {
      pitcher_id: p.pitcher_id,
      pitcher_throws: p.pitcher_throws,
      allowed_last_14_days: p.allowed_last_14_days,
      allowed_last_3_starts: p.allowed_last_3_starts,
      starts_known: 0,
    }] as const),
  );
  const probableIds = new Set<number>();
  for (const g of games) {
    if (g.home_probable_pitcher_id != null) probableIds.add(g.home_probable_pitcher_id);
    if (g.away_probable_pitcher_id != null) probableIds.add(g.away_probable_pitcher_id);
  }
  const realPitcher = await fetchPitcherFormForDate(Array.from(probableIds), asOf);
  for (const [id, real] of realPitcher) approxPitcher.set(id, real);

  // Venue index with L14d rank
  const venueBoard = venueLeaderboard(canonHrs, asOf);
  const totalVenues = venueBoard.length;
  const venueIndex = new Map(
    venueBoard.map((v, i) => [v.venue_name, { venue_name: v.venue_name, l14d: v.l14d, rank_l14d: i + 1, total_ranked: totalVenues }] as const),
  );

  // Elite power detection (curated list)
  const elitePowerIds = new Set<number>();
  for (const [id, p] of playerIndex) {
    const name = (p.full_name ?? '').trim().toLowerCase();
    if (name && ELITE_POWER_NAMES.has(name)) elitePowerIds.add(id);
  }

  // 4. Map GameRow → HrTargetGame
  const targetGames: HrTargetGame[] = games.map((g) => ({
    game_pk: g.game_pk,
    game_date: g.game_date,
    home_team: g.home_team,
    away_team: g.away_team,
    venue_name: g.venue_name,
    home_probable_pitcher_id: g.home_probable_pitcher_id,
    home_probable_pitcher_name: g.home_probable_pitcher_name,
    home_probable_pitcher_hand: g.home_probable_pitcher_hand,
    away_probable_pitcher_id: g.away_probable_pitcher_id,
    away_probable_pitcher_name: g.away_probable_pitcher_name,
    away_probable_pitcher_hand: g.away_probable_pitcher_hand,
  }));

  // 5. Run the model
  const boards = computeHrTargets(canonHrs, asOf, targetGames, {
    pitcherIndex: approxPitcher,
    venueIndex,
    elitePowerIds,
  });

  // 6. Flatten + sort + slice
  const all: HrTarget[] = [];
  for (const b of boards) all.push(...b.away_targets, ...b.home_targets);
  all.sort(
    (a, b) =>
      b.heat_score - a.heat_score ||
      b.season_hr - a.season_hr ||
      a.player_name.localeCompare(b.player_name),
  );
  const top = all.slice(0, limit);

  // 7. Map each target to its game_pk via the team pairs on the date
  const gameByPair = new Map<string, number>();
  for (const g of games) {
    gameByPair.set(`${g.away_team}@${g.home_team}`, g.game_pk);
    gameByPair.set(`${g.home_team}@${g.away_team}`, g.game_pk);
  }

  const rows = top
    .map((t, i) => ({
      // target_date = the day these predictions are FOR. snapshot_date
      // (when the row was written) defaults to now() server-side.
      target_date: date,
      player_id: t.player_id,
      game_pk: gameByPair.get(`${t.team}@${t.opponent}`) ?? null,
      rank: i + 1,
      player_name: t.player_name,
      team: t.team,
      opponent: t.opponent,
      heat_score: t.heat_score,
      reason: t.reasons.join(' · ') || null,
      snapshot_type: snapshotType,
    }))
    .filter((r) => r.game_pk != null);

  if (rows.length === 0) {
    console.log(`  no qualifying targets (no hitters with a matching game on ${date})`);
    return { date, asOf, generated: top.length, inserted: 0, skipped: false, snapshot_type: snapshotType };
  }

  // 8. Persist
  if (force && existing > 0) {
    const { error: delErr } = await supabaseAdmin
      .from('hr_target_snapshots')
      .delete()
      .eq('target_date', date);
    if (delErr) throw new Error(`force-delete existing failed: ${delErr.message}`);
    console.log(`  cleared ${existing} existing rows (--force)`);
  }

  const { error: insErr } = await supabaseAdmin
    .from('hr_target_snapshots')
    .insert(rows);
  if (insErr) throw new Error(`insert hr_target_snapshots failed: ${insErr.message}`);

  console.log(`  inserted ${rows.length} snapshot rows for ${date} (top of ${top.length} generated, type=${snapshotType})`);
  return { date, asOf, generated: top.length, inserted: rows.length, skipped: false, snapshot_type: snapshotType };
}
