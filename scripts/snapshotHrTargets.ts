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
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';
import {
  applyCanonicalTeams,
  computeHrTargets,
  parseSignalsFromReason,
  pitcherHrLeaderboard,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  type ExtraLineupCandidate,
  type HomeRunRow,
  type HrTarget,
  type HrTargetGame,
  type PitcherFormLite,
  type PlayerTeamIndex,
  type SignalKey,
} from '../src/lib/stats.js';

const UNIVERSE_SIGNAL_KEYS: SignalKey[] = [
  'hr_pitcher', 'power_park', 'wind_out', 'wind_in', 'warm_weather',
  'hot_l7d', 'hr_streak', 'platoon_edge', 'elite_power', 'mid_power',
  'low_season_power', 'cold_batter', 'pitcher_dominant',
];

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

// "today" anchored on Pacific calendar — see scripts/lib/mlbDate.ts.
const todayISO_local = mlbToday;

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

const addDays = mlbAddDays;

async function countExistingSnapshot(targetDate: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('hr_target_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('target_date', targetDate);
  if (error) throw new Error(`count snapshot failed: ${error.message}`);
  return count ?? 0;
}

/** Returns 0 when the table doesn't exist yet — callers treat that as
 *  "universe missing, please write." */
async function countExistingUniverse(targetDate: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('hr_target_universe')
    .select('*', { count: 'exact', head: true })
    .eq('target_date', targetDate)
    .eq('model_version', 1);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return 0;
    throw new Error(`count universe failed: ${error.message}`);
  }
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

    // K/9 and BB/9 — require ≥ 3 starts AND ≥ 18 IP before the rate is
    // trustworthy enough to drive the pitcher-quality adjustment.
    const totalIp = starts.reduce((s, r: any) => s + (r.innings_pitched ?? 0), 0);
    const totalK  = starts.reduce((s, r: any) => s + (r.strikeouts ?? 0), 0);
    const totalBb = starts.reduce((s, r: any) => s + (r.walks ?? 0), 0);
    const ratesValid = starts.length >= 3 && totalIp >= 18;
    const k_per_9  = ratesValid ? Math.round((totalK  * 9 * 100) / totalIp) / 100 : undefined;
    const bb_per_9 = ratesValid ? Math.round((totalBb * 9 * 100) / totalIp) / 100 : undefined;

    out.set(pid, {
      pitcher_id: pid,
      pitcher_throws: hand,
      allowed_last_14_days: l14,
      allowed_last_3_starts: sum(last3),
      allowed_last_5_starts: sum(last5),
      season_hr_allowed: sum(starts),
      starts_known: starts.length,
      k_per_9,
      bb_per_9,
    });
  }
  return out;
}

export async function snapshotHrTargets(date: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const limit = opts.limit ?? 50;
  const force = !!opts.force;
  const asOf = addDays(date, -1);

  console.log(`[snapshotHrTargets] date=${date} asOf=${asOf} limit=${limit}${force ? ' force' : ''}`);

  // 1. Idempotency check — top-50 AND universe.
  //    We only short-circuit if BOTH already exist. If the universe row
  //    is missing (e.g. mig 018 just applied), we still run the full
  //    pipeline so writeUniverseSnapshot can backfill it, while the
  //    existing top-50 insert stays skipped.
  const existing = await countExistingSnapshot(date);
  const existingUniverse = await countExistingUniverse(date);
  const skipTop50 = existing > 0 && !force;
  if (existing > 0 && existingUniverse > 0 && !force) {
    console.log(`  snapshot + universe already exist, skipped — ${existing} top-50 row(s), ${existingUniverse} universe row(s) for ${date} (use --force to overwrite)`);
    return { date, asOf, generated: 0, inserted: 0, skipped: true };
  }
  if (skipTop50) {
    console.log(`  top-50 exists (${existing} row(s)) — keeping it; will refresh hr_target_universe only. (use --force to also overwrite top-50)`);
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
    console.warn(
      `  snapshot already exists, skipped — games already started for ${date} ` +
        `(${startedCount}/${games.length} in-progress/final, pre-game-only mode; use --force to override)`,
    );
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

  // 4. Map GameRow → HrTargetGame (including weather context)
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
    weather_condition: g.weather?.condition ?? null,
    weather_temp_f: g.weather_temp_f ?? null,
    weather_wind_mph: g.weather_wind_mph ?? null,
    weather_wind_dir: g.weather_wind_dir ?? null,
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

  // 8. Persist top-50 — but only if this run isn't already gated by the
  //    idempotency skip (existing top-50 present, no --force).
  let insertedTop = 0;
  const isOverwrite = force && existing > 0;
  if (!skipTop50) {
    if (isOverwrite) {
      const { error: delErr } = await supabaseAdmin
        .from('hr_target_snapshots')
        .delete()
        .eq('target_date', date);
      if (delErr) throw new Error(`force-delete existing failed: ${delErr.message}`);
      console.log(`  snapshot overwritten — cleared ${existing} existing row(s) for ${date} (force=true)`);
    }

    const { error: insErr } = await supabaseAdmin
      .from('hr_target_snapshots')
      .insert(rows);
    if (insErr) throw new Error(`insert hr_target_snapshots failed: ${insErr.message}`);
    insertedTop = rows.length;

    // Emit a clear, greppable line. When this run was a force-replace, prefix
    // with the "snapshot overwritten" phrase so log scrapers can tell the
    // difference between "fresh create" and "overwrite-then-create".
    const verb = isOverwrite ? 'snapshot overwritten — created' : 'created snapshot —';
    console.log(`  ${verb} ${rows.length} rows for ${date} (type=${snapshotType}, top of ${top.length} generated)`);
  } else {
    console.log(`  top-50 insert skipped (existing snapshot retained) — continuing to universe write`);
  }

  // Freeze the pre-game context per game (migration 016). The captureChanges
  // script diffs current game rows against this baseline to detect what
  // moved after the snapshot was locked in. Non-fatal — if this fails the
  // snapshot itself is still valid, we just lose delta tracking for the day.
  try {
    const stateRows = (games as Array<Record<string, unknown>>).map((g) => ({
      target_date: date,
      game_pk: g.game_pk as number,
      captured_at: new Date().toISOString(),
      lineups_confirmed: (g.lineups_confirmed as boolean | null) ?? false,
      home_probable_pitcher_id: (g.home_probable_pitcher_id as number | null) ?? null,
      away_probable_pitcher_id: (g.away_probable_pitcher_id as number | null) ?? null,
      weather_temp_f:  (g.weather_temp_f  as number | null) ?? null,
      weather_wind_mph: (g.weather_wind_mph as number | null) ?? null,
      weather_wind_dir: (g.weather_wind_dir as string | null) ?? null,
    }));
    if (stateRows.length > 0) {
      const { error: stateErr } = await supabaseAdmin
        .from('game_state_at_snapshot')
        .upsert(stateRows, { onConflict: 'target_date,game_pk' });
      if (stateErr) {
        if (/does not exist|schema cache/i.test(stateErr.message)) {
          console.warn(`  ⚠ game_state_at_snapshot table missing — apply migration 016 to enable change tracking`);
        } else {
          console.warn(`  ⚠ game_state_at_snapshot upsert warning (non-fatal): ${stateErr.message}`);
        }
      } else {
        console.log(`  froze ${stateRows.length} game states for delta tracking`);
      }
    }
  } catch (stateEx) {
    console.warn(`  ⚠ game_state_at_snapshot capture failed (non-fatal): ${stateEx instanceof Error ? stateEx.message : String(stateEx)}`);
  }

  // -------------------------------------------------------------------
  //  Canonical universe write (mig 018).
  //
  //  Runs after the 50-row snapshot lands. Rescores with lineup UNION +
  //  uncapped per-team so every eligible hitter gets a global_rank.
  //  Written to `hr_target_universe`. Fully non-fatal — the existing
  //  50-row snapshot is what everything else depends on for now.
  // -------------------------------------------------------------------
  try {
    // Always refresh the universe on any snapshot run. Force-clean the
    // date/model_version rows so lineup changes during the day (pending →
    // confirmed, new probable pitchers, weather updates) reflect
    // immediately without stacking duplicate rows via ON CONFLICT.
    await writeUniverseSnapshot({
      date, asOf,
      games, targetGames, canonHrs,
      approxPitcher, venueIndex, elitePowerIds,
      force: true,
    });
  } catch (uniEx) {
    console.warn(`  ⚠ hr_target_universe write failed (non-fatal): ${uniEx instanceof Error ? uniEx.message : String(uniEx)}`);
  }

  return { date, asOf, generated: top.length, inserted: insertedTop, skipped: false, snapshot_type: snapshotType };
}

// =====================================================================
//  Canonical hitter-universe writer (mig 018)
// =====================================================================

type ComputeHrTargetsOpts = NonNullable<Parameters<typeof computeHrTargets>[3]>;

interface UniverseWriteArgs {
  date: string;
  asOf: string;
  games: Array<Record<string, unknown>>;
  targetGames: HrTargetGame[];
  canonHrs: HomeRunRow[];
  approxPitcher: Map<number, PitcherFormLite>;
  venueIndex: NonNullable<ComputeHrTargetsOpts['venueIndex']>;
  elitePowerIds: Set<number>;
  force: boolean;
}

async function writeUniverseSnapshot(args: UniverseWriteArgs): Promise<void> {
  const { date, asOf, games, targetGames, canonHrs, approxPitcher, venueIndex, elitePowerIds, force } = args;

  // -------- 1) Fetch player catalog (names for zero-HR lineup starters) --------
  //   Falls back to `#playerId` if the player isn't in the catalog. Non-fatal —
  //   we prefer imperfect names over dropping the row.
  const playerCatalog = new Map<number, { full_name: string; bat_hand: string | null }>();
  try {
    const { data: playersRows, error: playersErr } = await supabaseAdmin
      .from('players')
      .select('player_id, full_name, bat_hand');
    if (playersErr) {
      if (/does not exist|schema cache/i.test(playersErr.message)) {
        console.warn(`  ⚠ players catalog missing — zero-HR starters will use '#playerId' as name`);
      } else {
        console.warn(`  ⚠ players catalog fetch warning: ${playersErr.message}`);
      }
    } else {
      for (const p of (playersRows ?? []) as Array<{ player_id: number; full_name: string; bat_hand: string | null }>) {
        playerCatalog.set(p.player_id, { full_name: p.full_name, bat_hand: p.bat_hand });
      }
    }
  } catch (catEx) {
    console.warn(`  ⚠ players catalog fetch failed: ${catEx instanceof Error ? catEx.message : String(catEx)}`);
  }

  // -------- 2) Extract lineup player IDs per team from games --------
  const lineupCandidatesByTeam = new Map<string, Set<number>>();
  for (const g of games as Array<Record<string, unknown>>) {
    const homeTeam = g.home_team as string;
    const awayTeam = g.away_team as string;
    const homeLineup = g.home_lineup as number[] | null | undefined;
    const awayLineup = g.away_lineup as number[] | null | undefined;
    if (Array.isArray(homeLineup)) {
      const s = lineupCandidatesByTeam.get(homeTeam) ?? new Set<number>();
      for (const pid of homeLineup) s.add(pid);
      lineupCandidatesByTeam.set(homeTeam, s);
    }
    if (Array.isArray(awayLineup)) {
      const s = lineupCandidatesByTeam.get(awayTeam) ?? new Set<number>();
      for (const pid of awayLineup) s.add(pid);
      lineupCandidatesByTeam.set(awayTeam, s);
    }
  }

  // -------- 3) Build extraLineupPlayers list --------
  //   computeHrTargets internally dedupes against HR-derived candidates —
  //   any player_id already in that set is preserved (richer HR history).
  //   Extras contribute only when the player has NO HR history yet.
  const extras: ExtraLineupCandidate[] = [];
  let lineupCandidateCount = 0;
  for (const [team, pids] of lineupCandidatesByTeam) {
    for (const pid of pids) {
      lineupCandidateCount += 1;
      const info = playerCatalog.get(pid);
      extras.push({
        player_id: pid,
        player_name: info?.full_name ?? `#${pid}`,
        team,
        batter_side: info?.bat_hand ?? null,
      });
    }
  }

  const hrHistoryCandidateCount = (() => {
    const s = new Set<number>();
    for (const h of canonHrs) s.add(h.player_id);
    return s.size;
  })();

  // -------- 4) Score UNCAPPED with the UNION --------
  const universeBoards = computeHrTargets(canonHrs, asOf, targetGames, {
    pitcherIndex: approxPitcher,
    venueIndex,
    elitePowerIds,
    limitPerTeam: null,          // ← the fix: rank 9+ per team preserved
    extraLineupPlayers: extras,  // ← the fix: zero-HR starters included
  });

  // Flatten + global sort. Ties broken by season_hr then name (matches the
  // existing snapshot flatten so top rows agree with hr_target_snapshots).
  const universeAll: HrTarget[] = [];
  for (const b of universeBoards) universeAll.push(...b.away_targets, ...b.home_targets);
  universeAll.sort(
    (a, b) => b.heat_score - a.heat_score
      || b.season_hr - a.season_hr
      || a.player_name.localeCompare(b.player_name),
  );

  // -------- 5) Team-rank counter + game_pk lookup --------
  const gamePkByTeam = new Map<string, number>();
  for (const g of games as Array<Record<string, unknown>>) {
    gamePkByTeam.set(g.home_team as string, g.game_pk as number);
    gamePkByTeam.set(g.away_team as string, g.game_pk as number);
  }

  // -------- 6) Optional: attach odds if we already have them for the date --------
  //   Best-effort. If odds_snapshots doesn't have this date yet, we skip.
  const oddsByPlayer = new Map<number, { american: number; implied: number }>();
  try {
    const { data: oddsRows } = await supabaseAdmin
      .from('odds_snapshots')
      .select('player_id, american_odds, implied_prob, snapshot_time')
      .eq('target_date', date)
      .order('snapshot_time', { ascending: true });
    for (const r of (oddsRows ?? []) as Array<{ player_id: number | null; american_odds: number; implied_prob: number }>) {
      if (r.player_id != null) {
        oddsByPlayer.set(r.player_id, { american: r.american_odds, implied: r.implied_prob });
      }
    }
  } catch { /* graceful */ }

  // -------- 7) Doubleheader / anomaly flags per team --------
  const teamsPlayingTwice = new Map<string, number>();
  for (const g of games as Array<Record<string, unknown>>) {
    const h = g.home_team as string;
    const a = g.away_team as string;
    teamsPlayingTwice.set(h, (teamsPlayingTwice.get(h) ?? 0) + 1);
    teamsPlayingTwice.set(a, (teamsPlayingTwice.get(a) ?? 0) + 1);
  }
  const teamsPlayingLarge = new Set<string>();
  for (const [team, count] of teamsPlayingTwice) if (count > 1) teamsPlayingLarge.add(team);

  // Detect oversized lineups (>9 batting-order slots — malformed data)
  const teamsWithLargeLineup = new Set<string>();
  for (const [team, pids] of lineupCandidatesByTeam) {
    if (pids.size > 10) teamsWithLargeLineup.add(team);
  }

  // -------- 8) Build rows --------
  const nowIso = new Date().toISOString();
  const teamRankCounter = new Map<string, number>();
  let confirmedCount = 0, pendingCount = 0, notStartingCount = 0;
  const universeRows = universeAll.map((t, i) => {
    const prev = teamRankCounter.get(t.team) ?? 0;
    const teamRank = prev + 1;
    teamRankCounter.set(t.team, teamRank);

    if (t.lineup_status === 'confirmed') confirmedCount += 1;
    else if (t.lineup_status === 'pending') pendingCount += 1;
    else if (t.lineup_status === 'not_starting') notStartingCount += 1;

    const reasonText = t.reasons.join(' · ') || null;
    // Reuse the same parseSignalsFromReason used by learning_predictions so
    // signal keys line up across tables.
    const signalsSet = parseSignalsFromReason(reasonText);
    const signalsMap: Record<string, boolean> = {};
    for (const k of UNIVERSE_SIGNAL_KEYS) signalsMap[k] = signalsSet.has(k);

    const flags: string[] = [];
    if (teamsPlayingLarge.has(t.team)) flags.push('doubleheader');
    if (teamsWithLargeLineup.has(t.team)) flags.push('lineup_larger_than_9');
    if (!t.pitcher_id) flags.push('no_probable_pitcher');
    if (t.reason_chips.some((c) => c.kind === 'data_limited')) flags.push('data_limited');

    const odds = oddsByPlayer.get(t.player_id) ?? null;

    return {
      target_date: date,
      snapshot_at: nowIso,
      model_version: 1,           // universe reflects v1's scoring today
      player_id: t.player_id,
      player_name: t.player_name,
      team: t.team,
      opponent: t.opponent,
      game_pk: gamePkByTeam.get(t.team) ?? null,
      global_rank: i + 1,
      team_rank: teamRank,
      heat_score: t.heat_score,
      lineup_status: t.lineup_status,
      subscores_json: t.subscores as unknown as Record<string, unknown>,
      signals_json: signalsMap,
      reason: reasonText,
      american_odds: odds?.american ?? null,
      implied_prob: odds?.implied ?? null,
      flags,
    };
  });

  // -------- 9) Delete existing rows (force or first write per date) --------
  if (universeRows.length === 0) {
    console.log(`  hr_target_universe — nothing to persist (no candidates found)`);
    return;
  }

  if (force) {
    const { error: delErr } = await supabaseAdmin
      .from('hr_target_universe')
      .delete()
      .eq('target_date', date)
      .eq('model_version', 1);
    if (delErr && !/does not exist|schema cache/i.test(delErr.message)) {
      throw new Error(`hr_target_universe force-delete: ${delErr.message}`);
    }
  }

  // -------- 10) Upsert --------
  const { error: upErr, count } = await supabaseAdmin
    .from('hr_target_universe')
    .upsert(universeRows, { onConflict: 'target_date,player_id,model_version', count: 'exact' });
  if (upErr) {
    if (/does not exist|schema cache/i.test(upErr.message)) {
      console.warn(`  ⚠ hr_target_universe table missing — apply migration 018 first`);
      return;
    }
    throw new Error(`hr_target_universe upsert: ${upErr.message}`);
  }

  // -------- 11) Logging summary in user-requested format --------
  console.log(`  ── canonical universe ──`);
  console.log(`  scheduled teams:     ${lineupCandidatesByTeam.size}`);
  console.log(`  lineup candidates:   ${lineupCandidateCount}`);
  console.log(`  HR-history candidates: ${hrHistoryCandidateCount}`);
  console.log(`  union candidates:    ${universeAll.length}`);
  console.log(`  scored:              ${universeAll.length}`);
  console.log(`  persisted universe:  ${count ?? universeRows.length}`);
  console.log(`  confirmed starters:  ${confirmedCount}`);
  console.log(`  pending:             ${pendingCount}`);
  console.log(`  not starting:        ${notStartingCount}`);

  // -------- 12) Validation checks --------
  await validateUniverseWrite(date, universeAll.length);
}

/** Post-write validation. Runs 5 sanity queries and WARNS (does not
 *  throw) on any failure so the snapshot job stays green. */
async function validateUniverseWrite(date: string, expectedRows: number): Promise<void> {
  const problems: string[] = [];

  // Check 1: no duplicate rows for (date, player, model)
  const { data: dupCheck, error: dupErr } = await supabaseAdmin
    .from('hr_target_universe')
    .select('player_id, model_version')
    .eq('target_date', date);
  if (dupErr) {
    problems.push(`dup-check failed: ${dupErr.message}`);
  } else {
    const seen = new Set<string>();
    let dups = 0;
    for (const r of (dupCheck ?? []) as Array<{ player_id: number; model_version: number }>) {
      const k = `${r.player_id}:${r.model_version}`;
      if (seen.has(k)) dups++;
      seen.add(k);
    }
    if (dups > 0) problems.push(`${dups} duplicate (player_id, model_version) rows for ${date}`);
    if (seen.size !== expectedRows) {
      problems.push(`row count mismatch: expected ${expectedRows}, DB has ${seen.size} distinct players`);
    }
  }

  // Check 2: contiguous global ranks (1..N per model_version)
  const { data: rankCheck } = await supabaseAdmin
    .from('hr_target_universe')
    .select('global_rank, team, team_rank')
    .eq('target_date', date)
    .eq('model_version', 1)
    .order('global_rank', { ascending: true });
  const ranks = (rankCheck ?? []).map((r: { global_rank: number }) => r.global_rank);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) {
      problems.push(`global_rank not contiguous — position ${i} has rank ${ranks[i]} (expected ${i + 1})`);
      break;
    }
  }

  // Check 3: contiguous team ranks within each team
  const teamRanksSeen = new Map<string, number[]>();
  for (const r of (rankCheck ?? []) as Array<{ global_rank: number; team: string; team_rank: number }>) {
    const arr = teamRanksSeen.get(r.team) ?? [];
    arr.push(r.team_rank);
    teamRanksSeen.set(r.team, arr);
  }
  for (const [team, arr] of teamRanksSeen) {
    arr.sort((a, b) => a - b);
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== i + 1) {
        problems.push(`team_rank not contiguous for ${team} — position ${i} has ${arr[i]} (expected ${i + 1})`);
        break;
      }
    }
  }

  // Check 4: at least one confirmed zero-season-HR starter present (spot check).
  // Only meaningful once lineups are posted — we don't fail if zero.
  const { count: zeroHrCount } = await supabaseAdmin
    .from('hr_target_universe')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('lineup_status', 'confirmed')
    .filter('subscores_json->>season', 'eq', '0');
  // Informational only — DO log so we can spot check it.

  // Check 5: at least one rank>8 row persisted (proves per-team cap really is gone)
  let maxTeamRank = 0;
  for (const arr of teamRanksSeen.values()) maxTeamRank = Math.max(maxTeamRank, Math.max(...arr));
  const hasRank9Plus = maxTeamRank >= 9;

  if (problems.length > 0) {
    for (const p of problems) console.warn(`  ⚠ universe validation: ${p}`);
  } else {
    console.log(`  ✓ universe validation clean · max team_rank=${maxTeamRank}` +
      (hasRank9Plus ? ` (rank ≥9 preserved — per-team cap is off)` : ``) +
      (zeroHrCount != null ? ` · ${zeroHrCount} zero-HR confirmed starter(s)` : ``));
  }
}
