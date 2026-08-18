/**
 * snapshotHitTargets — pregame Hit Score writer.
 *
 * ISOLATED from the HR pipeline. Does NOT import computeHrTargets,
 * HrTarget, snapshotHrTargets, or any HR-side scoring code. Reads
 * from shared data-layer tables (games, player_daily_hit_summary,
 * pitcher_form, players, player_batting_lines) only.
 *
 * For date D:
 *   1. Load games on D, extract eligible starting hitters from
 *      home_lineup / away_lineup arrays (confirmed + pending).
 *   2. Load per-player summaries + pitcher form.
 *   3. computeHitTargets → both 1+ and 2+ rankings per player.
 *   4. Assign global rank + team rank per ranker (independent).
 *   5. Write to hit_target_universe (force-clean per run).
 *   6. Write to hit_target_snapshots (first-write-wins pregame).
 *
 * Games-started fence: identical to computeAiPicksPregame. If any
 * game on D has started AND no prior pregame snapshot exists →
 * refuse. Existing snapshot rows are ALWAYS preserved — this writer
 * never mutates rank/score/contributions once a snapshot lands.
 *
 * Failure isolation contract: throwing here MUST NOT break the HR
 * pipeline. The updateDaily.ts wiring wraps this call in try/catch.
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { mlbToday } from './lib/mlbDate.js';
import {
  HIT_MODEL_1PLUS,
  HIT_MODEL_1PLUS_HASH,
  HIT_MODEL_2PLUS,
  HIT_MODEL_2PLUS_HASH,
  computeHitTargets,
  describeHitModels,
  type HitCandidate,
  type HitGameContext,
  type HitTarget,
  type PitcherFormRow,
  type PlayerDailyHitSummaryRow,
  type LineupStatus,
} from '../src/lib/hitStats.js';

/** Statuses that mean a game is past its pre-game state. Copied here
 *  (not imported from the HR side) so the two pipelines share zero
 *  code paths. */
const STARTED_STATUSES = new Set(['In Progress', 'Final', 'Game Over', 'Completed Early', 'Suspended']);

export interface SnapshotHitResult {
  date: string;
  status: 'written' | 'frozen_kept' | 'refused_games_started' | 'no_games' | 'no_candidates';
  reason: string;
  games_total: number;
  games_started: number;
  candidates_total: number;
  candidates_confirmed: number;
  candidates_pending: number;
  universe_rows_written: number;
  snapshot_rows_written: number;
  snapshot_rows_kept_frozen: number;
  model_1plus: { id: string; hash: string; is_validated: boolean };
  model_2plus: { id: string; hash: string; is_validated: boolean };
}

export interface SnapshotHitOptions {
  /** Force re-write hit_target_universe AND hit_target_snapshots for
   *  this date. USE WITH CARE — overwrites the frozen pregame audit
   *  record. Operator override only. */
  force?: boolean;
  /** Skip snapshot when any game has started. Default true — the
   *  writer refuses to fabricate a pregame record after first pitch. */
  skipIfGamesStarted?: boolean;
}

/** Model version stamped on rows. Bumped when we promote a walk-forward
 *  winner and want to distinguish historical rows. */
const HIT_MODEL_VERSION = 1;

// ---------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------

interface GameRowRaw {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  status: string;
  home_probable_pitcher_id: number | null;
  home_probable_pitcher_name: string | null;
  home_probable_pitcher_hand: string | null;
  away_probable_pitcher_id: number | null;
  away_probable_pitcher_name: string | null;
  away_probable_pitcher_hand: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  home_lineup: number[] | null;
  away_lineup: number[] | null;
  lineups_confirmed: boolean | null;
}

async function loadGamesForDate(date: string): Promise<GameRowRaw[]> {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select(
      'game_pk, game_date, home_team, away_team, status, ' +
      'home_probable_pitcher_id, home_probable_pitcher_name, home_probable_pitcher_hand, ' +
      'away_probable_pitcher_id, away_probable_pitcher_name, away_probable_pitcher_hand, ' +
      'weather_temp_f, weather_wind_mph, weather_wind_dir, ' +
      'home_lineup, away_lineup, lineups_confirmed',
    )
    .eq('game_date', date);
  if (error) throw new Error(`games ${date}: ${error.message}`);
  return (data ?? []) as unknown as GameRowRaw[];
}

/** Player catalog for name + bat_side + pitch_hand fallback lookups.
 *  Only loads the ids we actually need. */
async function loadPlayerCatalog(playerIds: number[], pitcherIds: number[]): Promise<Map<number, { full_name: string; bat_side: string | null; pitch_hand: string | null }>> {
  const out = new Map<number, { full_name: string; bat_side: string | null; pitch_hand: string | null }>();
  const idSet = new Set<number>([...playerIds, ...pitcherIds]);
  if (idSet.size === 0) return out;
  const ids = [...idSet];
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('players')
      .select('player_id, full_name, bat_side, pitch_hand')
      .in('player_id', chunk);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(`players catalog: ${error.message}`);
    }
    for (const p of (data ?? []) as Array<{ player_id: number; full_name: string; bat_side: string | null; pitch_hand: string | null }>) {
      out.set(p.player_id, { full_name: p.full_name, bat_side: p.bat_side, pitch_hand: p.pitch_hand });
    }
  }
  return out;
}

/** Hit summaries as of the day before target_date so the ranker only
 *  sees strictly-prior data. When no exact match exists for that
 *  date (rebuildHitSummaries hasn't run yet for it), fall back to the
 *  latest row for each player with summary_date <= date - 1. */
async function loadHitSummariesAsOf(playerIds: number[], asOf: string): Promise<Map<number, PlayerDailyHitSummaryRow>> {
  const out = new Map<number, PlayerDailyHitSummaryRow>();
  if (playerIds.length === 0) return out;
  // We'll iterate over player ids and get the most recent summary_date
  // <= asOf for each. A single window-func query would be nicer but is
  // painful via PostgREST; two-pass approach is fine for the scale.
  const CHUNK = 200;
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const chunk = playerIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('player_daily_hit_summary')
      .select(
        'player_id, summary_date, hits_l7d, ab_l7d, hit_rate_l7d, strikeout_rate_l7d, ' +
        'multi_hit_games_l5g, multi_hit_games_l10g, ' +
        'hits_vs_lhp_starters, ab_vs_lhp_starters, hits_vs_rhp_starters, ab_vs_rhp_starters, ' +
        'season_avg, season_obp, season_slg, season_ops, flags',
      )
      .in('player_id', chunk)
      .lte('summary_date', asOf);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(`player_daily_hit_summary: ${error.message}`);
    }
    // Keep the latest per player.
    const latest = new Map<number, { summary_date: string; row: PlayerDailyHitSummaryRow }>();
    for (const r of ((data ?? []) as unknown) as Array<PlayerDailyHitSummaryRow & { summary_date: string; flags?: string[] }>) {
      const prior = latest.get(r.player_id);
      if (!prior || r.summary_date > prior.summary_date) {
        latest.set(r.player_id, { summary_date: r.summary_date, row: r });
      }
    }
    for (const [pid, v] of latest) out.set(pid, v.row);
  }
  return out;
}

async function loadPitcherForm(pitcherIds: number[]): Promise<Map<number, PitcherFormRow>> {
  const out = new Map<number, PitcherFormRow>();
  if (pitcherIds.length === 0) return out;
  const ids = [...new Set(pitcherIds)];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('pitcher_form')
      .select('pitcher_id, starts_known, h_per_9, k_per_9, bb_per_9, whip')
      .in('pitcher_id', chunk);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(`pitcher_form: ${error.message}`);
    }
    for (const r of (data ?? []) as PitcherFormRow[]) out.set(r.pitcher_id, r);
  }
  return out;
}

async function countExistingUniverse(date: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('hit_target_universe')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('model_version', HIT_MODEL_VERSION);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return 0;
    throw new Error(`count universe: ${error.message}`);
  }
  return count ?? 0;
}

async function countExistingSnapshot(date: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('hit_target_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('model_version', HIT_MODEL_VERSION);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return 0;
    throw new Error(`count snapshot: ${error.message}`);
  }
  return count ?? 0;
}

async function loadExistingSnapshotPlayerIds(date: string): Promise<Set<number>> {
  const { data, error } = await supabaseAdmin
    .from('hit_target_snapshots')
    .select('player_id')
    .eq('target_date', date)
    .eq('model_version', HIT_MODEL_VERSION);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return new Set();
    throw new Error(`existing snapshot player ids: ${error.message}`);
  }
  const s = new Set<number>();
  for (const r of (data ?? []) as { player_id: number }[]) s.add(r.player_id);
  return s;
}

// ---------------------------------------------------------------------
// Candidate assembly
// ---------------------------------------------------------------------

function normHand(v: unknown): 'L' | 'R' | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' ? u : null;
}

function normBatSide(v: unknown): 'L' | 'R' | 'S' | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}

/** Build one candidate per starting hitter across both teams for every
 *  game. Slot = index+1 of the player in the lineup array. Opposing
 *  starter = the OTHER side's probable pitcher.
 *
 *  Lineup status:
 *    - lineups_confirmed=true AND player in lineup → 'confirmed'
 *    - lineups_confirmed=false OR null, lineup has entries → 'pending'
 *    - game postponed / cancelled → 'postponed'
 *    - lineup empty and lineups_confirmed=false → skip (no candidates yet) */
function assembleCandidates(
  games: GameRowRaw[],
  catalog: Map<number, { full_name: string; bat_side: string | null; pitch_hand: string | null }>,
): HitCandidate[] {
  const out: HitCandidate[] = [];
  for (const g of games) {
    const dead = g.status === 'Postponed' || g.status === 'Cancelled';
    const homeConfirmed = g.lineups_confirmed === true && Array.isArray(g.home_lineup) && g.home_lineup.length >= 9;
    const awayConfirmed = g.lineups_confirmed === true && Array.isArray(g.away_lineup) && g.away_lineup.length >= 9;
    const homeHasLineup = Array.isArray(g.home_lineup) && g.home_lineup.length > 0;
    const awayHasLineup = Array.isArray(g.away_lineup) && g.away_lineup.length > 0;

    // Opposing-starter hand — fall back to catalog when the game row
    // has no probable_pitcher_hand persisted.
    const awayStarterHand = normHand(g.away_probable_pitcher_hand)
      ?? (g.away_probable_pitcher_id != null ? catalog.get(g.away_probable_pitcher_id)?.pitch_hand as 'L' | 'R' | null ?? null : null);
    const homeStarterHand = normHand(g.home_probable_pitcher_hand)
      ?? (g.home_probable_pitcher_id != null ? catalog.get(g.home_probable_pitcher_id)?.pitch_hand as 'L' | 'R' | null ?? null : null);

    // HOME batters face the AWAY starter.
    if (homeHasLineup) {
      const status: LineupStatus = dead ? 'postponed' : homeConfirmed ? 'confirmed' : 'pending';
      for (let i = 0; i < g.home_lineup!.length; i++) {
        const pid = g.home_lineup![i];
        const info = catalog.get(pid);
        out.push({
          player_id: pid,
          player_name: info?.full_name ?? `#${pid}`,
          team: g.home_team,
          opponent: g.away_team,
          game_pk: g.game_pk,
          batting_order_slot: i < 9 ? i + 1 : null,
          lineup_status: status,
          opposing_starter_id: g.away_probable_pitcher_id,
          opposing_starter_hand: awayStarterHand,
          batter_side: normBatSide(info?.bat_side),
        });
      }
    }
    // AWAY batters face the HOME starter.
    if (awayHasLineup) {
      const status: LineupStatus = dead ? 'postponed' : awayConfirmed ? 'confirmed' : 'pending';
      for (let i = 0; i < g.away_lineup!.length; i++) {
        const pid = g.away_lineup![i];
        const info = catalog.get(pid);
        out.push({
          player_id: pid,
          player_name: info?.full_name ?? `#${pid}`,
          team: g.away_team,
          opponent: g.home_team,
          game_pk: g.game_pk,
          batting_order_slot: i < 9 ? i + 1 : null,
          lineup_status: status,
          opposing_starter_id: g.home_probable_pitcher_id,
          opposing_starter_hand: homeStarterHand,
          batter_side: normBatSide(info?.bat_side),
        });
      }
    }
  }
  // Dedup on player_id — a rare case if a player appears on both
  // lineups (shouldn't happen; guard anyway).
  const seen = new Set<number>();
  return out.filter((c) => {
    if (seen.has(c.player_id)) return false;
    seen.add(c.player_id);
    return true;
  });
}

// ---------------------------------------------------------------------
// Ranking (independent 1+ / 2+)
// ---------------------------------------------------------------------

interface RankedTarget {
  target: HitTarget;
  rank_1plus: number;
  team_rank_1plus: number;
  rank_2plus: number;
  team_rank_2plus: number;
}

function assignRanks(targets: HitTarget[]): RankedTarget[] {
  // 1+ global rank — desc by hit_prob_1plus, tie-break by hit_score_1plus
  // then player_name for stability.
  const by1 = targets.slice().sort((a, b) =>
    b.hit_prob_1plus - a.hit_prob_1plus
    || b.hit_score_1plus - a.hit_score_1plus
    || a.player_name.localeCompare(b.player_name));
  const rank1Global = new Map<number, number>();
  for (let i = 0; i < by1.length; i++) rank1Global.set(by1[i].player_id, i + 1);

  // 2+ global rank — INDEPENDENT sort. Do not derive from 1+.
  const by2 = targets.slice().sort((a, b) =>
    b.hit_prob_2plus - a.hit_prob_2plus
    || b.hit_score_2plus - a.hit_score_2plus
    || a.player_name.localeCompare(b.player_name));
  const rank2Global = new Map<number, number>();
  for (let i = 0; i < by2.length; i++) rank2Global.set(by2[i].player_id, i + 1);

  // Team ranks per ranker (independent).
  const teamRank1 = new Map<number, number>();
  const teamRank2 = new Map<number, number>();
  const teamCounters1 = new Map<string, number>();
  const teamCounters2 = new Map<string, number>();
  for (const t of by1) {
    const cur = (teamCounters1.get(t.team) ?? 0) + 1;
    teamCounters1.set(t.team, cur);
    teamRank1.set(t.player_id, cur);
  }
  for (const t of by2) {
    const cur = (teamCounters2.get(t.team) ?? 0) + 1;
    teamCounters2.set(t.team, cur);
    teamRank2.set(t.player_id, cur);
  }

  return targets.map((t) => ({
    target: t,
    rank_1plus: rank1Global.get(t.player_id)!,
    team_rank_1plus: teamRank1.get(t.player_id)!,
    rank_2plus: rank2Global.get(t.player_id)!,
    team_rank_2plus: teamRank2.get(t.player_id)!,
  }));
}

// ---------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------

function makeUniverseRow(r: RankedTarget, targetDate: string, pregameRunAt: string): Record<string, unknown> {
  const t = r.target;
  return {
    target_date: targetDate,
    captured_at: pregameRunAt,
    model_version: HIT_MODEL_VERSION,

    model_config_id_1plus: t.contributions_1plus.model.id,
    model_config_hash_1plus: t.contributions_1plus.model.hash,
    model_config_id_2plus: t.contributions_2plus.model.id,
    model_config_hash_2plus: t.contributions_2plus.model.hash,

    player_id: t.player_id,
    player_name: t.player_name,
    team: t.team,
    opponent: t.opponent,
    game_pk: t.game_pk,

    batting_order_slot: t.batting_order_slot,
    lineup_status: t.lineup_status,
    opposing_starter_id: t.opposing_starter_id,
    opposing_starter_hand: t.opposing_starter_hand,

    hit_score_1plus: round4(t.hit_score_1plus),
    hit_prob_1plus: round4(t.hit_prob_1plus),
    rank_1plus: r.rank_1plus,
    team_rank_1plus: r.team_rank_1plus,
    contributions_1plus_json: t.contributions_1plus as unknown as Record<string, unknown>,
    confidence_1plus: t.confidence_1plus,

    hit_score_2plus: round4(t.hit_score_2plus),
    hit_prob_2plus: round4(t.hit_prob_2plus),
    rank_2plus: r.rank_2plus,
    team_rank_2plus: r.team_rank_2plus,
    contributions_2plus_json: t.contributions_2plus as unknown as Record<string, unknown>,
    confidence_2plus: t.confidence_2plus,

    flags: t.flags,
  };
}

function makeSnapshotRow(r: RankedTarget, targetDate: string, pregameRunAt: string, snapshotType: 'pregame' | 'simulated'): Record<string, unknown> {
  // Reuse the universe row shape but STRIP captured_at — that column
  // exists on hit_target_universe only. The snapshot table uses
  // snapshot_at (row-write time) + pregame_run_at (frozen decision
  // time) instead. Two-tables-mirror-HR-pattern design has them
  // deliberately distinct.
  const { captured_at: _dropped, ...universeShape } = makeUniverseRow(r, targetDate, pregameRunAt);
  void _dropped;
  return {
    ...universeShape,
    snapshot_at: pregameRunAt,
    pregame_run_at: pregameRunAt,
    snapshot_type: snapshotType,
    // Outcome fields explicitly null pregame; enrichHitOutcomes fills later.
    hits: null,
    at_bats: null,
    hit_1plus: null,
    hit_2plus: null,
    doubles: null,
    triples: null,
    outcome_enriched_at: null,
  };
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------

export async function snapshotHitTargets(date: string, opts: SnapshotHitOptions = {}): Promise<SnapshotHitResult> {
  const force = !!opts.force;
  const skipIfStarted = opts.skipIfGamesStarted ?? true;
  const nowIso = new Date().toISOString();
  const runningToday = date === mlbToday();

  console.log(`[snapshotHitTargets] date=${date}${force ? ' force' : ''}${runningToday ? ' (today)' : ''}`);
  console.log(describeHitModels().split('\n').map((l) => `  ${l}`).join('\n'));

  // --- Fetch games ---
  const games = await loadGamesForDate(date);
  const startedCount = games.filter((g) => STARTED_STATUSES.has(g.status)).length;

  if (games.length === 0) {
    console.log(`  no games scheduled on ${date}`);
    return {
      date, status: 'no_games', reason: 'no games scheduled',
      games_total: 0, games_started: 0,
      candidates_total: 0, candidates_confirmed: 0, candidates_pending: 0,
      universe_rows_written: 0, snapshot_rows_written: 0, snapshot_rows_kept_frozen: 0,
      model_1plus: { id: HIT_MODEL_1PLUS.id, hash: HIT_MODEL_1PLUS_HASH, is_validated: HIT_MODEL_1PLUS.is_validated },
      model_2plus: { id: HIT_MODEL_2PLUS.id, hash: HIT_MODEL_2PLUS_HASH, is_validated: HIT_MODEL_2PLUS.is_validated },
    };
  }

  // --- Games-started fence ---
  const existingSnapshotCount = await countExistingSnapshot(date);
  if (startedCount > 0 && skipIfStarted && !force && existingSnapshotCount === 0) {
    console.warn(
      `[snapshotHitTargets] ✗ REFUSED — ${startedCount}/${games.length} games already started for ${date} ` +
      `and no prior pregame snapshot exists. Cannot fabricate a clean pregame Hits record from ` +
      `potentially contaminated inputs. Use --force to override.`,
    );
    return {
      date, status: 'refused_games_started',
      reason: `${startedCount}/${games.length} games started; no prior pregame snapshot`,
      games_total: games.length, games_started: startedCount,
      candidates_total: 0, candidates_confirmed: 0, candidates_pending: 0,
      universe_rows_written: 0, snapshot_rows_written: 0, snapshot_rows_kept_frozen: 0,
      model_1plus: { id: HIT_MODEL_1PLUS.id, hash: HIT_MODEL_1PLUS_HASH, is_validated: HIT_MODEL_1PLUS.is_validated },
      model_2plus: { id: HIT_MODEL_2PLUS.id, hash: HIT_MODEL_2PLUS_HASH, is_validated: HIT_MODEL_2PLUS.is_validated },
    };
  }

  // --- Load catalog + summaries + pitcher form ---
  const asOfSummary = mlbAddDaysUtc(date, -1);   // strictly-prior data only
  const playerIdSet = new Set<number>();
  const pitcherIdSet = new Set<number>();
  for (const g of games) {
    for (const pid of (g.home_lineup ?? [])) playerIdSet.add(pid);
    for (const pid of (g.away_lineup ?? [])) playerIdSet.add(pid);
    if (g.home_probable_pitcher_id != null) pitcherIdSet.add(g.home_probable_pitcher_id);
    if (g.away_probable_pitcher_id != null) pitcherIdSet.add(g.away_probable_pitcher_id);
  }
  const [catalog, summariesById, pitcherFormById] = await Promise.all([
    loadPlayerCatalog([...playerIdSet], [...pitcherIdSet]),
    loadHitSummariesAsOf([...playerIdSet], asOfSummary),
    loadPitcherForm([...pitcherIdSet]),
  ]);
  console.log(`  loaded ${catalog.size} player-catalog rows, ${summariesById.size} summaries (as-of ${asOfSummary}), ${pitcherFormById.size} pitcher-form rows`);

  // --- Assemble candidates ---
  const candidates = assembleCandidates(games, catalog);
  const confirmed = candidates.filter((c) => c.lineup_status === 'confirmed').length;
  const pending = candidates.filter((c) => c.lineup_status === 'pending').length;
  console.log(`  candidates: ${candidates.length} total  (${confirmed} confirmed, ${pending} pending)`);

  if (candidates.length === 0) {
    return {
      date, status: 'no_candidates', reason: 'no eligible starters (lineups empty)',
      games_total: games.length, games_started: startedCount,
      candidates_total: 0, candidates_confirmed: 0, candidates_pending: 0,
      universe_rows_written: 0, snapshot_rows_written: 0, snapshot_rows_kept_frozen: existingSnapshotCount,
      model_1plus: { id: HIT_MODEL_1PLUS.id, hash: HIT_MODEL_1PLUS_HASH, is_validated: HIT_MODEL_1PLUS.is_validated },
      model_2plus: { id: HIT_MODEL_2PLUS.id, hash: HIT_MODEL_2PLUS_HASH, is_validated: HIT_MODEL_2PLUS.is_validated },
    };
  }

  // --- Build game context map ---
  const gamesByPk = new Map<number, HitGameContext>();
  for (const g of games) {
    gamesByPk.set(g.game_pk, {
      game_pk: g.game_pk,
      game_date: g.game_date,
      home_team: g.home_team,
      away_team: g.away_team,
      home_probable_pitcher_id: g.home_probable_pitcher_id,
      home_probable_pitcher_name: g.home_probable_pitcher_name,
      home_probable_pitcher_hand: normHand(g.home_probable_pitcher_hand),
      away_probable_pitcher_id: g.away_probable_pitcher_id,
      away_probable_pitcher_name: g.away_probable_pitcher_name,
      away_probable_pitcher_hand: normHand(g.away_probable_pitcher_hand),
      weather_temp_f: g.weather_temp_f,
      weather_wind_mph: g.weather_wind_mph,
      weather_wind_dir: g.weather_wind_dir,
      home_lineup: g.home_lineup,
      away_lineup: g.away_lineup,
      lineups_confirmed: g.lineups_confirmed,
      game_status: g.status,
    });
  }

  // --- Score ---
  const boards = computeHitTargets({
    candidates,
    gamesByPk,
    hitSummaryById: summariesById,
    pitcherFormById,
  });
  const allTargets: HitTarget[] = [];
  for (const b of boards) allTargets.push(...b.home_targets, ...b.away_targets);
  console.log(`  scored ${allTargets.length} targets across ${boards.length} game board(s)`);

  const ranked = assignRanks(allTargets);

  // --- Universe: force-clean per run ---
  {
    const { error: delErr } = await supabaseAdmin
      .from('hit_target_universe')
      .delete()
      .eq('target_date', date)
      .eq('model_version', HIT_MODEL_VERSION);
    if (delErr && !/does not exist|schema cache/i.test(delErr.message)) {
      throw new Error(`hit_target_universe delete: ${delErr.message}`);
    }
  }
  const universeRows = ranked.map((r) => makeUniverseRow(r, date, nowIso));
  let universeWritten = 0;
  {
    const BATCH = 500;
    for (let i = 0; i < universeRows.length; i += BATCH) {
      const chunk = universeRows.slice(i, i + BATCH);
      const { error, count } = await supabaseAdmin
        .from('hit_target_universe')
        .insert(chunk, { count: 'exact' });
      if (error) throw new Error(`hit_target_universe insert: ${error.message}`);
      universeWritten += count ?? chunk.length;
    }
  }
  console.log(`  hit_target_universe: wrote ${universeWritten} rows`);

  // --- Snapshots: first-write-wins per (date, player, model_version) ---
  //     Existing snapshot rows are ALWAYS preserved (their pregame ranks
  //     stay frozen). Only new players get new rows unless --force.
  const snapshotType: 'pregame' | 'simulated' = startedCount > 0 ? 'simulated' : 'pregame';
  const existingSnapshotIds = await loadExistingSnapshotPlayerIds(date);
  const snapshotRowsToWrite: Array<Record<string, unknown>> = [];
  let keptFrozen = 0;
  for (const r of ranked) {
    if (existingSnapshotIds.has(r.target.player_id) && !force) {
      keptFrozen++;
      continue;
    }
    snapshotRowsToWrite.push(makeSnapshotRow(r, date, nowIso, snapshotType));
  }

  if (force && existingSnapshotIds.size > 0) {
    const { error: delSnapErr } = await supabaseAdmin
      .from('hit_target_snapshots')
      .delete()
      .eq('target_date', date)
      .eq('model_version', HIT_MODEL_VERSION);
    if (delSnapErr && !/does not exist|schema cache/i.test(delSnapErr.message)) {
      throw new Error(`hit_target_snapshots force-delete: ${delSnapErr.message}`);
    }
    console.log(`  hit_target_snapshots: force-cleared ${existingSnapshotIds.size} existing pregame row(s)`);
  }

  let snapshotWritten = 0;
  if (snapshotRowsToWrite.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < snapshotRowsToWrite.length; i += BATCH) {
      const chunk = snapshotRowsToWrite.slice(i, i + BATCH);
      const { error, count } = await supabaseAdmin
        .from('hit_target_snapshots')
        .upsert(chunk, { onConflict: 'target_date,player_id,model_version', count: 'exact' });
      if (error) throw new Error(`hit_target_snapshots upsert: ${error.message}`);
      snapshotWritten += count ?? chunk.length;
    }
  }

  const status: SnapshotHitResult['status'] =
    keptFrozen > 0 && snapshotWritten === 0 && !force ? 'frozen_kept' : 'written';
  const reason =
    status === 'frozen_kept'
      ? `all ${keptFrozen} pregame snapshot rows preserved`
      : `${snapshotWritten} new snapshot rows + ${keptFrozen} kept frozen`;
  console.log(
    `[snapshotHitTargets] ✓ ${status.toUpperCase()} — ${reason} · type=${snapshotType} · ` +
    `games=${startedCount}/${games.length} started`,
  );

  return {
    date, status, reason,
    games_total: games.length, games_started: startedCount,
    candidates_total: candidates.length,
    candidates_confirmed: confirmed,
    candidates_pending: pending,
    universe_rows_written: universeWritten,
    snapshot_rows_written: snapshotWritten,
    snapshot_rows_kept_frozen: keptFrozen,
    model_1plus: { id: HIT_MODEL_1PLUS.id, hash: HIT_MODEL_1PLUS_HASH, is_validated: HIT_MODEL_1PLUS.is_validated },
    model_2plus: { id: HIT_MODEL_2PLUS.id, hash: HIT_MODEL_2PLUS_HASH, is_validated: HIT_MODEL_2PLUS.is_validated },
  };
}

/** Local addDays — mlbToday module doesn't re-export it under that name.
 *  We use it only for the summaries as-of lookup, so a simple UTC-safe
 *  helper is fine (calendar-date arithmetic only, no DST concerns). */
function mlbAddDaysUtc(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
