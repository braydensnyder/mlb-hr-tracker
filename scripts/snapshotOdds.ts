/**
 * snapshotOdds — capture an HR-prop odds snapshot for a target date.
 *
 * Flow:
 *   1. Resolve target_date (defaults to mlbToday()).
 *   2. Build the [00:00 PT, 23:59 PT] commence window in UTC.
 *   3. Call The Odds API list-events endpoint → event ids.
 *   4. For each event, fetch HR-prop odds (all US books).
 *   5. Match each (player_name) against our players catalog to fill
 *      player_id + team. Unmatched rows still get stored (player_id=null).
 *   6. Pull the model's Heat Score for each matched player from the
 *      computeHrTargets pass at THIS moment so the snapshot row
 *      captures both market price and model conviction simultaneously.
 *   7. Compute decimal odds, implied prob, model prob (via sigmoid),
 *      and edge for each row.
 *   8. Upsert into `odds_snapshots` keyed on
 *      (target_date, snapshot_type, game_pk, player_id, book).
 *
 * Idempotent. Safe to re-run for the same snapshot_type — the unique
 * index dedups and the second run just refreshes the same rows.
 *
 * We DO NOT touch the home_runs / games tables. Failures in odds fetch
 * are isolated per-event so one bad book payload can't fail the whole run.
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import {
  listMlbEvents,
  fetchEventHrOdds,
  flattenEventOdds,
  type FlatOddsRow,
} from './lib/oddsApi.js';
import {
  americanToDecimal,
  americanToImplied,
  heatScoreToModelProb,
  computeEdge,
} from './lib/oddsMath.js';
import { mlbToday } from './lib/mlbDate.js';
import { computeHrTargets, applyCanonicalTeams, ELITE_POWER_NAMES, type HomeRunRow, type HrTarget, type HrTargetGame, type PitcherFormLite, type PlayerTeamIndex } from '../src/lib/stats.js';
import { pitcherHrLeaderboard, venueLeaderboard } from '../src/lib/stats.js';

export type OddsSnapshotType = 'morning' | 'midday' | 'pregame' | 'manual';

export interface SnapshotOddsOptions {
  /** YYYY-MM-DD; defaults to mlbToday(). */
  date?: string;
  /** Snapshot bucket; defaults to 'manual'. */
  snapshotType?: OddsSnapshotType;
  /** Restrict to specific books (e.g. ['draftkings']). Default: all US. */
  books?: string[];
  /** Dry-run: log the rows we'd write, but skip the upsert. */
  dryRun?: boolean;
}

export interface SnapshotOddsResult {
  date: string;
  snapshot_type: OddsSnapshotType;
  events_listed: number;
  events_fetched: number;
  events_failed: number;
  rows_built: number;
  rows_upserted: number;
  unmatched_players: number;
  /** Per-event errors (non-fatal). */
  failures: { event_id: string; error: string }[];
}

interface PlayerLookup {
  byNorm: Map<string, { player_id: number; full_name: string; team: string | null }>;
}

/** Lowercase + collapse non-letter chars for fuzzy name matching. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

async function loadPlayerLookup(): Promise<PlayerLookup> {
  const PAGE = 1000;
  const byNorm = new Map<string, { player_id: number; full_name: string; team: string | null }>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('players')
      .select('player_id, full_name, current_team_name')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      console.warn(`[snapshotOdds] players catalog read failed: ${error.message} — proceeding with empty index`);
      break;
    }
    const rows = (data ?? []) as { player_id: number; full_name: string; current_team_name: string | null }[];
    for (const r of rows) {
      if (!r.full_name) continue;
      byNorm.set(normName(r.full_name), {
        player_id: r.player_id,
        full_name: r.full_name,
        team: r.current_team_name,
      });
    }
    if (rows.length < PAGE) break;
  }
  return { byNorm };
}

/** Date helper: build the UTC ISO bounds for "all of `date` in Pacific time". */
function ptDayUtcBounds(date: string): { fromIso: string; toIso: string } {
  // We use the date as a Pacific-local calendar day. The Odds API
  // accepts ISO with UTC offset; we widen the window 1h on each side
  // to be safe against early/late MLB scheduling oddities.
  // Pacific is UTC-8 (PST) or UTC-7 (PDT). Use Intl to get the offset.
  const probe = new Date(`${date}T12:00:00-08:00`); // anchor inside PT
  // commence_from / commence_to need ISO format without milliseconds.
  const dayStartPt = new Date(`${date}T00:00:00-07:00`); // use PDT-ish; the 1h slop covers PST
  const dayEndPt = new Date(`${date}T23:59:59-07:00`);
  // Subtract / add 1h slop.
  const fromIso = new Date(dayStartPt.getTime() - 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
  const toIso = new Date(dayEndPt.getTime() + 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
  void probe;
  return { fromIso, toIso };
}

/** Build the Heat-Score index for `date` by running the existing model
 *  pipeline against home_runs + games + pitcher_starts. Returns a map
 *  keyed by player_id → HrTarget so we can attach the model snapshot
 *  to each odds row. */
async function buildHeatIndex(date: string): Promise<Map<number, HrTarget>> {
  const yearStart = `${date.slice(0, 4)}-01-01`;
  // home_runs season-to-date
  const PAGE = 1000;
  const hrs: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('*')
      .gte('game_date', yearStart)
      .lte('game_date', date)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`home_runs fetch failed: ${error.message}`);
    const rows = (data ?? []) as HomeRunRow[];
    hrs.push(...rows);
    if (rows.length < PAGE) break;
  }
  // games on date
  const { data: gameRows, error: gErr } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('game_date', date)
    .order('game_pk', { ascending: true });
  if (gErr) throw new Error(`games fetch failed: ${gErr.message}`);
  const games = (gameRows ?? []) as Array<{
    game_pk: number; game_date: string; home_team: string; away_team: string;
    venue_name: string | null;
    home_probable_pitcher_id: number | null; home_probable_pitcher_name: string | null; home_probable_pitcher_hand: string | null;
    away_probable_pitcher_id: number | null; away_probable_pitcher_name: string | null; away_probable_pitcher_hand: string | null;
    weather: { condition?: string } | null;
    weather_temp_f: number | null; weather_wind_mph: number | null; weather_wind_dir: string | null;
    weather_updated_at: string | null;
  }>;

  // players catalog → mutable Map, then exposed via PlayerTeamIndex read-only alias.
  const playerIdxMut = new Map<number, { team: string | null; full_name?: string | null }>();
  {
    const { data } = await supabaseAdmin
      .from('players')
      .select('player_id, full_name, current_team_name');
    for (const p of (data ?? []) as { player_id: number; full_name: string; current_team_name: string | null }[]) {
      playerIdxMut.set(p.player_id, { team: p.current_team_name, full_name: p.full_name });
    }
  }
  const playerIdx: PlayerTeamIndex = playerIdxMut;
  const canon = applyCanonicalTeams(hrs, playerIdx);

  // Pitcher form index — light approximation from home_runs leaderboard.
  const pitcherIndex = new Map<number, PitcherFormLite>();
  for (const p of pitcherHrLeaderboard(canon, date)) {
    pitcherIndex.set(p.pitcher_id, {
      pitcher_id: p.pitcher_id,
      pitcher_throws: p.pitcher_throws ?? null,
      allowed_last_14_days: p.allowed_last_14_days,
      allowed_last_3_starts: p.allowed_last_3_starts,
      season_hr_allowed: p.season_allowed,
      starts_known: 0,
    });
  }
  // Build venue index for computeHrTargets — derive rank locally since
  // venueLeaderboard returns the public VenueStats shape (no rank field).
  const venueBoard = venueLeaderboard(canon, date);
  const venueByL14d = venueBoard.slice().sort((a, b) => b.l14d - a.l14d);
  const venueIndex = new Map(
    venueByL14d.map((v, i) => [
      v.venue_name,
      { venue_name: v.venue_name, l14d: v.l14d, rank_l14d: i + 1, total_ranked: venueByL14d.length },
    ] as const),
  );

  const elitePowerIds = new Set<number>();
  for (const [pid, info] of playerIdx) {
    if (info.full_name && ELITE_POWER_NAMES.has(info.full_name)) elitePowerIds.add(pid);
  }

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
    weather_temp_f: g.weather_temp_f,
    weather_wind_mph: g.weather_wind_mph,
    weather_wind_dir: g.weather_wind_dir,
    weather_updated_at: g.weather_updated_at,
  }));

  const boards = computeHrTargets(canon, date, targetGames, { pitcherIndex, venueIndex, elitePowerIds });

  const heatByPlayer = new Map<number, HrTarget>();
  for (const b of boards) {
    for (const t of [...b.away_targets, ...b.home_targets]) {
      // If the same player shows up across multiple games (rare — usually
      // doubleheaders), prefer the highest heat_score entry.
      const prev = heatByPlayer.get(t.player_id);
      if (!prev || t.heat_score > prev.heat_score) heatByPlayer.set(t.player_id, t);
    }
  }
  return heatByPlayer;
}

/** Map an Odds-API team name (e.g. "Los Angeles Dodgers") to our shorter
 *  team key (e.g. "Dodgers"). Tries exact match against the day's games;
 *  falls back to the last word. */
function matchGameForOdds(
  awayTeam: string,
  homeTeam: string,
  games: Array<{ game_pk: number; away_team: string; home_team: string }>,
): { game_pk: number; away_team: string; home_team: string } | null {
  const norm = (s: string) => s.toLowerCase().trim();
  const a = norm(awayTeam);
  const h = norm(homeTeam);
  // Exact, contains, or last-word match — be lenient.
  return (
    games.find((g) => norm(g.away_team) === a && norm(g.home_team) === h) ??
    games.find((g) => a.endsWith(norm(g.away_team)) && h.endsWith(norm(g.home_team))) ??
    games.find((g) => norm(g.away_team).endsWith(a.split(' ').slice(-1)[0])) ??
    null
  );
}

export async function snapshotOdds(opts: SnapshotOddsOptions = {}): Promise<SnapshotOddsResult> {
  const date = opts.date ?? mlbToday();
  const snapshot_type: OddsSnapshotType = opts.snapshotType ?? 'manual';
  const dryRun = !!opts.dryRun;

  console.log(`\n[snapshotOdds] date=${date} type=${snapshot_type} dryRun=${dryRun}`);

  const { fromIso, toIso } = ptDayUtcBounds(date);
  const events = await listMlbEvents(fromIso, toIso, { bookmakers: opts.books });
  console.log(`[snapshotOdds] ${events.length} events in window ${fromIso} → ${toIso}`);

  // Load supporting indexes in parallel.
  const [lookup, heatIndex, gamesData] = await Promise.all([
    loadPlayerLookup(),
    buildHeatIndex(date).catch((e) => {
      console.warn(`[snapshotOdds] heat index build failed (continuing without model attribution): ${e instanceof Error ? e.message : e}`);
      return new Map<number, HrTarget>();
    }),
    supabaseAdmin
      .from('games')
      .select('game_pk, away_team, home_team, weather_temp_f, weather_wind_mph, weather_wind_dir')
      .eq('game_date', date)
      .then((r) => (r.data ?? []) as Array<{
        game_pk: number; away_team: string; home_team: string;
        weather_temp_f: number | null; weather_wind_mph: number | null; weather_wind_dir: string | null;
      }>),
  ]);

  const gamesByPk = new Map(gamesData.map((g) => [g.game_pk, g]));

  const result: SnapshotOddsResult = {
    date,
    snapshot_type,
    events_listed: events.length,
    events_fetched: 0,
    events_failed: 0,
    rows_built: 0,
    rows_upserted: 0,
    unmatched_players: 0,
    failures: [],
  };

  type RowToInsert = {
    target_date: string;
    snapshot_type: OddsSnapshotType;
    snapshot_time: string;
    game_pk: number;
    player_id: number | null;
    player_name: string;
    team: string | null;
    opponent: string | null;
    book: string;
    market_key: string;
    american_odds: number;
    decimal_odds: number;
    implied_prob: number;
    heat_score: number | null;
    confidence: string | null;
    model_prob: number | null;
    edge: number | null;
    weather_temp_f: number | null;
    weather_wind_mph: number | null;
    weather_wind_dir: string | null;
  };
  const rows: RowToInsert[] = [];
  const nowIso = new Date().toISOString();

  for (const evt of events) {
    let flat: FlatOddsRow[] = [];
    try {
      const evtOdds = await fetchEventHrOdds(evt.id, { bookmakers: opts.books });
      flat = flattenEventOdds(evtOdds);
      result.events_fetched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      result.events_failed++;
      result.failures.push({ event_id: evt.id, error: msg });
      console.warn(`[snapshotOdds] event ${evt.id} fetch FAILED: ${msg}`);
      continue;
    }

    const matchedGame = matchGameForOdds(evt.away_team, evt.home_team, gamesData);
    if (!matchedGame) {
      console.warn(
        `[snapshotOdds] event ${evt.id} (${evt.away_team} @ ${evt.home_team}) had no matching game_pk in games for ${date} — skipping ${flat.length} odds rows`,
      );
      continue;
    }

    const weather = gamesByPk.get(matchedGame.game_pk);

    for (const f of flat) {
      const lookupHit = lookup.byNorm.get(normName(f.player_name)) ?? null;
      const playerId = lookupHit?.player_id ?? null;
      if (!playerId) result.unmatched_players++;

      const heat = playerId != null ? heatIndex.get(playerId) : null;
      const heat_score = heat?.heat_score ?? null;
      const model_prob = heat_score != null ? heatScoreToModelProb(heat_score) : null;
      const decimal = americanToDecimal(f.american_odds);
      const implied = americanToImplied(f.american_odds);
      const edge = model_prob != null ? computeEdge(model_prob, implied) : null;

      // Team / opponent: prefer canonical from heat index (which uses the
      // players catalog), fall back to the schedule's team strings.
      const team = heat?.team ?? lookupHit?.team ?? null;
      const opponent =
        team && team === matchedGame.away_team
          ? matchedGame.home_team
          : team && team === matchedGame.home_team
          ? matchedGame.away_team
          : null;

      rows.push({
        target_date: date,
        snapshot_type,
        snapshot_time: nowIso,
        game_pk: matchedGame.game_pk,
        player_id: playerId,
        player_name: f.player_name,
        team,
        opponent,
        book: f.book,
        market_key: 'batter_home_runs',
        american_odds: f.american_odds,
        decimal_odds: Number(decimal.toFixed(4)),
        implied_prob: Number(implied.toFixed(4)),
        heat_score: heat_score != null ? Number(heat_score.toFixed(2)) : null,
        confidence: heat?.confidence ?? null,
        model_prob: model_prob != null ? Number(model_prob.toFixed(4)) : null,
        edge: edge != null ? Number(edge.toFixed(4)) : null,
        weather_temp_f: weather?.weather_temp_f ?? null,
        weather_wind_mph: weather?.weather_wind_mph ?? null,
        weather_wind_dir: weather?.weather_wind_dir ?? null,
      });
    }
  }
  result.rows_built = rows.length;

  console.log(
    `[snapshotOdds] built ${result.rows_built} rows ` +
      `(unmatched players=${result.unmatched_players}, failed events=${result.events_failed})`,
  );

  if (dryRun) {
    console.log('[snapshotOdds] dry-run — skipping upsert. First 5 rows:');
    for (const r of rows.slice(0, 5)) console.log('  ', r);
    return result;
  }

  // The dedup index requires non-null player_id — drop unmatched rows
  // OR group them under the player_name (we still want to see them on
  // the page, but the dedup composite key needs all components). For
  // Phase 1, drop unmatched rows from the upsert and surface the count.
  const upsertable = rows.filter((r) => r.player_id != null);
  const skippedForNullId = rows.length - upsertable.length;
  if (skippedForNullId > 0) {
    console.warn(
      `[snapshotOdds] skipping ${skippedForNullId} rows with unmatched player_id ` +
        '(run enrich:players to add missing players, then re-run).',
    );
  }

  // Chunked upsert — Supabase REST will handle a few thousand rows fine,
  // but slice to be safe.
  const CHUNK = 500;
  for (let i = 0; i < upsertable.length; i += CHUNK) {
    const slice = upsertable.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from('odds_snapshots')
      .upsert(slice, {
        onConflict: 'target_date,snapshot_type,game_pk,player_id,book',
      });
    if (error) {
      console.error(`[snapshotOdds] upsert chunk failed: ${error.message}`);
      throw new Error(error.message);
    }
    result.rows_upserted += slice.length;
  }

  console.log(`[snapshotOdds] DONE upserted=${result.rows_upserted}`);
  return result;
}
