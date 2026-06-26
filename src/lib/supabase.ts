import { createClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client — uses the *anon* key. RLS allows read-only access
 * to the three public tables; writes happen exclusively from backend scripts.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !key) {
  // Don't crash the app — just log; the UI surfaces a helpful error too.
  // eslint-disable-next-line no-console
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. ' +
      'Copy .env.example to .env and restart `npm run dev`.',
  );
}

export const supabase = createClient(url ?? 'http://invalid', key ?? 'invalid');

// ---- Row types matching the SQL schema ----
// HomeRunRow lives in stats.ts so the model is fully self-contained for
// node scripts. Re-exported here so existing frontend code (which imports
// from supabase) keeps working unchanged.
export type { HomeRunRow } from './stats';

export interface PlayerSummaryRow {
  player_id: number;
  player_name: string;
  date: string;
  team: string;
  hrs_today: number;
  season_total: number;
  hrs_last_3_games: number;
  hrs_last_5_games: number;
  hrs_last_7_days: number;
  last_hr_date: string | null;
}

export interface GameRow {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  status: string;
  processed: boolean;
  processed_at: string | null;

  // Matchup context (may be null until MLB announces probables)
  venue_id: number | null;
  venue_name: string | null;
  home_probable_pitcher_id: number | null;
  home_probable_pitcher_name: string | null;
  home_probable_pitcher_hand: string | null;
  away_probable_pitcher_id: number | null;
  away_probable_pitcher_name: string | null;
  away_probable_pitcher_hand: string | null;

  // Weather (populated by `npm run enrich:weather` from the MLB feed —
  // null until MLB publishes it, usually a few hours before first pitch).
  /** Raw gameData.weather object from the feed. */
  weather: { condition?: string; temp?: string; wind?: string } | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  /** When enrichWeather last successfully wrote weather columns. NULL ↔
   *  weather still pending (game too far out, MLB hasn't published yet). */
  weather_updated_at: string | null;

  // Lineups (migration 012, populated by `npm run enrich:lineups` from the
  // MLB feed's batting order — null until MLB posts the lineup ~2-4h pre-game).
  /** Starter player_ids in the home batting order, or null/[] when pending. */
  home_lineup: number[] | null;
  /** Starter player_ids in the away batting order. */
  away_lineup: number[] | null;
  /** True once both sides have a 9-man order posted. */
  lineups_confirmed: boolean | null;
  lineups_updated_at: string | null;
}

/** Canonical players catalog. The frontend prefers `current_team_name` from
 *  this table over the per-HR `team` field (which can be a non-MLB name
 *  like "United States" for WBC games). Maintained by `npm run enrich:players`. */
export interface PlayerRow {
  player_id: number;
  full_name: string;
  current_team_id: number | null;
  current_team_name: string | null;
  primary_position: string | null;
  bat_side: string | null;
  pitch_hand: string | null;
  birth_country: string | null;
  active: boolean;
}

/** Canonical venues catalog. */
export interface VenueRow {
  venue_id: number;
  name: string;
  city: string | null;
  state: string | null;
}

/**
 * Fetch all rows from the canonical `players` table and return them as a
 * Map<player_id, { team, full_name }>. Cheap query (small table) — call
 * once per page load. Frontend uses this to remap each HR row's per-game
 * team string to the player's current MLB team before aggregating.
 */
export async function fetchPlayerIndex(): Promise<Map<number, { team: string | null; full_name: string | null }>> {
  const all: PlayerRow[] = [];
  const PAGE = 1000;
  for (let page = 0; ; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await supabase
      .from('players')
      .select('player_id, full_name, current_team_name')
      .range(from, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Pick<PlayerRow, 'player_id' | 'full_name' | 'current_team_name'>[];
    for (const r of rows) {
      all.push({ ...r, current_team_id: null, primary_position: null, bat_side: null, pitch_hand: null, birth_country: null, active: true });
    }
    if (rows.length < PAGE) break;
  }
  const m = new Map<number, { team: string | null; full_name: string | null }>();
  for (const p of all) {
    m.set(p.player_id, { team: p.current_team_name, full_name: p.full_name });
  }
  return m;
}

/** One row per (game_id, pitcher_id) for every starting pitcher (canonical
 *  shape per migration 006). Drives accurate "HR allowed L3 starts / L5
 *  starts / L14d / season" on the HR Targets page. Populated by
 *  processDate (forward) and `npm run enrich:pitcher-starts` (backfill). */
export interface PitcherStartRow {
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

/**
 * For each pitcher_id, compute real "form" from `pitcher_starts`:
 *   - season HR allowed (current calendar year, ≤ asOf)
 *   - HR allowed in last 3 / 5 starts
 *   - HR allowed in last 14 calendar days
 *
 * Returns an empty map when no rows exist (frontend gracefully falls back
 * to the home_runs approximation in that case). Designed for ≤ a few
 * hundred pitcher_ids per call — fine to pass every probable id on a date.
 */
export async function fetchPitcherFormIndex(
  pitcherIds: number[],
  asOf: string,
): Promise<Map<number, {
  pitcher_id: number;
  pitcher_throws: string | null;
  starts_count: number;
  season_hr_allowed: number;
  hr_allowed_l3_starts: number;
  hr_allowed_l5_starts: number;
  hr_allowed_l14d: number;
  /** K/9 and BB/9 across all on-file starts (current season). Only set
   *  when starts_count ≥ 3 AND total innings_pitched ≥ 18 (~3 full starts);
   *  null otherwise so the model can skip the pitcher-quality adjustment. */
  k_per_9: number | null;
  bb_per_9: number | null;
}>> {
  const result = new Map<number, {
    pitcher_id: number;
    pitcher_throws: string | null;
    starts_count: number;
    season_hr_allowed: number;
    hr_allowed_l3_starts: number;
    hr_allowed_l5_starts: number;
    hr_allowed_l14d: number;
    k_per_9: number | null;
    bb_per_9: number | null;
  }>();
  if (pitcherIds.length === 0) return result;

  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  // Postgres has a hard cap on .in() of ~1000 values. We're well below that
  // in practice, but slice into safe chunks just in case.
  const CHUNK = 200;
  const allStarts: PitcherStartRow[] = [];
  for (let i = 0; i < pitcherIds.length; i += CHUNK) {
    const slice = pitcherIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('pitcher_starts')
      .select('*')
      .in('pitcher_id', slice)
      .gte('game_date', yearStart)
      .lte('game_date', asOf)
      .order('game_date', { ascending: false });
    if (error) throw new Error(error.message);
    allStarts.push(...((data ?? []) as PitcherStartRow[]));
  }

  const fourteenStart = (() => {
    const [y, m, d] = asOf.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 13);
    return dt.toISOString().slice(0, 10);
  })();

  // Group rows by pitcher; rows are already desc by game_date.
  const buckets = new Map<number, PitcherStartRow[]>();
  for (const s of allStarts) {
    let arr = buckets.get(s.pitcher_id);
    if (!arr) { arr = []; buckets.set(s.pitcher_id, arr); }
    arr.push(s);
  }

  for (const [pid, starts] of buckets) {
    const last3 = starts.slice(0, 3);
    const last5 = starts.slice(0, 5);
    const sum = (rows: PitcherStartRow[]) => rows.reduce((s, r) => s + (r.home_runs_allowed ?? 0), 0);
    const l14 = starts.filter((r) => r.game_date >= fourteenStart).reduce((s, r) => s + (r.home_runs_allowed ?? 0), 0);
    // pitcher_hand — prefer most recent non-null value
    const hand = starts.find((s) => s.pitcher_hand)?.pitcher_hand ?? null;

    // K/9 and BB/9 — require ≥ 3 starts AND ≥ 18 IP total before the
    // ratio is published. Below that, the rate is too noisy to drive
    // the negative-weighting heuristic.
    const totalIp = starts.reduce((s, r) => s + (r.innings_pitched ?? 0), 0);
    const totalK  = starts.reduce((s, r) => s + (r.strikeouts ?? 0), 0);
    const totalBb = starts.reduce((s, r) => s + (r.walks ?? 0), 0);
    const ratesValid = starts.length >= 3 && totalIp >= 18;
    const k_per_9  = ratesValid ? round2((totalK  * 9) / totalIp) : null;
    const bb_per_9 = ratesValid ? round2((totalBb * 9) / totalIp) : null;

    result.set(pid, {
      pitcher_id: pid,
      pitcher_throws: hand,
      starts_count: starts.length,
      season_hr_allowed: sum(starts),
      hr_allowed_l3_starts: sum(last3),
      hr_allowed_l5_starts: sum(last5),
      hr_allowed_l14d: l14,
      k_per_9,
      bb_per_9,
    });
  }
  return result;
}

function round2(n: number) { return Math.round(n * 100) / 100; }

/**
 * One-shot "today's actual results" status read for the Dashboard
 * status card. Aggregates:
 *   - games on `date` grouped by status bucket (live / final / pregame / processed)
 *   - HR count on `date`
 *   - latest home_runs.created_at among rows whose game_date == `date`
 *     (i.e. "when did we last ingest a HR that happened today?")
 *
 * Single-purpose helper — three small queries — so the Dashboard can
 * render a status panel without sucking down all of today's HR rows
 * twice.
 */
export interface TodayStatus {
  date: string;
  totalGames: number;
  liveGames: number;
  finalGames: number;
  /** Games marked processed=true (Final + we already ingested them). */
  processedGames: number;
  /** Final games NOT yet processed (next cron will pick them up). */
  finalsAwaitingIngest: number;
  pregameGames: number;
  hrsToday: number;
  /** MAX(home_runs.created_at) where game_date = date. The "last actual
   *  results update" timestamp the user wants on the Dashboard. */
  lastActualHrCreatedAt: string | null;
}

const LIVE_STATUSES_SET = new Set([
  'In Progress',
  'Manager Challenge',
  'Delayed',
  'Delayed: Rain',
  'Suspended',
  'Suspended: Rain',
  'Warmup',
]);
const FINAL_STATUSES_SET = new Set([
  'Final',
  'Game Over',
  'Completed Early',
]);

export async function fetchTodayStatus(date: string): Promise<TodayStatus> {
  // ---- 1) games on the date with status + processed flag ----
  const { data: gameRows, error: gErr } = await supabase
    .from('games')
    .select('status, processed')
    .eq('game_date', date);
  if (gErr) throw new Error(gErr.message);

  const games = (gameRows ?? []) as { status: string; processed: boolean }[];
  let liveGames = 0;
  let finalGames = 0;
  let processedGames = 0;
  let finalsAwaitingIngest = 0;
  let pregameGames = 0;
  for (const g of games) {
    if (FINAL_STATUSES_SET.has(g.status)) {
      finalGames++;
      if (g.processed) processedGames++;
      else finalsAwaitingIngest++;
    } else if (LIVE_STATUSES_SET.has(g.status)) {
      liveGames++;
    } else {
      pregameGames++;
    }
  }

  // ---- 2) HR count for the date ----
  const { count: hrCount, error: cErr } = await supabase
    .from('home_runs')
    .select('*', { count: 'exact', head: true })
    .eq('game_date', date);
  if (cErr) throw new Error(cErr.message);

  // ---- 3) latest HR created_at among today's rows ----
  const { data: latest, error: lErr } = await supabase
    .from('home_runs')
    .select('created_at')
    .eq('game_date', date)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lErr) throw new Error(lErr.message);

  return {
    date,
    totalGames: games.length,
    liveGames,
    finalGames,
    processedGames,
    finalsAwaitingIngest,
    pregameGames,
    hrsToday: hrCount ?? 0,
    lastActualHrCreatedAt: (latest as { created_at: string } | null)?.created_at ?? null,
  };
}

/**
 * Probe the freshest `home_runs.created_at` to show "Data last updated at"
 * timestamps in the UI. Single round-trip; fast.
 *
 * Returns null if the table is empty or the request fails (soft).
 */
export async function fetchDataLastUpdated(): Promise<string | null> {
  const { data, error } = await supabase
    .from('home_runs')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { created_at: string }).created_at;
}

/** One row from hr_target_snapshots — a persisted Top-N HR target ranking
 *  for a target_date. Drives the Backtest page (compares ranking vs. actual HRs). */
export interface HrTargetSnapshotRow {
  id: number;
  target_date: string;        // YYYY-MM-DD (the day games are predicted FOR)
  snapshot_date: string;      // timestamptz — when this row was written
  player_id: number;
  game_pk: number;
  rank: number;               // 1-based across all targets that day
  player_name: string;
  team: string;
  opponent: string;
  heat_score: number;
  reason: string | null;
  /** 'live' = honest pre-game snapshot (taken before first pitch).
   *  'simulated' = historical backfill via snapshot:range OR taken after games started. */
  snapshot_type: 'live' | 'simulated';
  created_at: string;
}

/** Derived venue HR cache, maintained by `npm run enrich:venues`. */
export interface VenueSummaryRow {
  venue_id: number;
  venue_name: string;
  computed_for: string;
  hrs_season: number;
  hrs_l7d: number;
  hrs_l14d: number;
  unique_hitters: number;
  teams_seen: string[];
  updated_at: string;
}

/**
 * One row in `odds_snapshots` — captures a single (book, player, game,
 * snapshot_type) HR-prop line at a moment in time. Drives the Odds tab.
 *
 * Phase 1: model_prob is derived from the Heat Score at snapshot time
 * via the sigmoid curve in src/lib/oddsMath.ts. `edge = model_prob -
 * implied_prob` is signed; positive means the model thinks the player
 * is more likely to homer than the book's price implies.
 */
export interface OddsSnapshotRow {
  id: number;
  target_date: string;          // YYYY-MM-DD
  snapshot_type: 'morning' | 'midday' | 'pregame' | 'manual';
  snapshot_time: string;        // ISO timestamp
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
  confidence: 'high' | 'medium' | 'low' | null;
  model_prob: number | null;
  edge: number | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  created_at: string;
}

/** Fetch all odds_snapshots rows for a target_date, across every
 *  snapshot_type and book. The Odds page aggregates them in memory. */
export async function fetchOddsSnapshots(targetDate: string): Promise<OddsSnapshotRow[]> {
  const PAGE = 1000;
  const all: OddsSnapshotRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('odds_snapshots')
      .select('*')
      .eq('target_date', targetDate)
      .order('snapshot_time', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      // Table missing → empty result (Phase 1 graceful degradation when
      // migration 011 hasn't been applied yet).
      if (/odds_snapshots/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
        return [];
      }
      throw new Error(error.message);
    }
    const rows = (data ?? []) as OddsSnapshotRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** Singleton row from cron_state — backs the "Last cron run" tile on
 *  the Dashboard's status card. */
export interface CronStateRow {
  id: number;
  last_run_at: string | null;
  last_run_mode: string | null;
  last_heavy_run_at: string | null;
  last_night_run_at: string | null;
  running: boolean;
  lock_acquired_at: string | null;
  run_count: number;
}

/** Read the cron_state singleton. Returns null on error / when the row
 *  hasn't been seeded — the Dashboard will just hide the tile in that case. */
export async function fetchCronState(): Promise<CronStateRow | null> {
  const { data, error } = await supabase
    .from('cron_state')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return null;
  return data as CronStateRow;
}

/** Quick weather-coverage probe for a date — drives the
 *  "Weather: 12/15 games" / "Weather pending" Dashboard tile. */
export interface WeatherCoverage {
  date: string;
  totalGames: number;
  withWeather: number;
  /** Freshest games.weather_updated_at across the date — newest moment
   *  any game's weather was written. Null when nothing has weather yet. */
  lastWeatherUpdatedAt: string | null;
}

export async function fetchWeatherCoverage(date: string): Promise<WeatherCoverage> {
  type Wide = { game_pk: number; weather_temp_f: number | null; weather_updated_at: string | null };
  type Narrow = Omit<Wide, 'weather_updated_at'>;

  let rows: Wide[] = [];
  // Tier 1 — full select with weather_updated_at.
  const { data, error } = await supabase
    .from('games')
    .select('game_pk, weather_temp_f, weather_updated_at')
    .eq('game_date', date);

  if (error) {
    const msg = error.message ?? '';
    const isMissingColumn =
      /weather_updated_at/i.test(msg) && /(does not exist|schema cache|column)/i.test(msg);
    if (!isMissingColumn) throw new Error(msg);
    // Tier 2 — without the new column.
    // eslint-disable-next-line no-console
    console.warn(
      '[weather] fetchWeatherCoverage: weather_updated_at column not found. ' +
        'Run supabase/migrations/010_weather_updated_at.sql. Coverage tile will still work; freshness will read null.',
    );
    const { data: data2, error: error2 } = await supabase
      .from('games')
      .select('game_pk, weather_temp_f')
      .eq('game_date', date);
    if (error2) throw new Error(error2.message);
    rows = ((data2 ?? []) as Narrow[]).map((g) => ({ ...g, weather_updated_at: null }));
  } else {
    rows = (data ?? []) as Wide[];
  }

  let withWeather = 0;
  let latest: string | null = null;
  for (const r of rows) {
    if (r.weather_temp_f != null) withWeather++;
    if (r.weather_updated_at && (!latest || r.weather_updated_at > latest)) {
      latest = r.weather_updated_at;
    }
  }
  return {
    date,
    totalGames: rows.length,
    withWeather,
    lastWeatherUpdatedAt: latest,
  };
}

// =============================================================================
//  Learning Engine fetchers (migration 013)
// =============================================================================

export interface ModelVersionRow {
  version: number;
  name: string;
  created_at: string;
  weights_json: Record<string, unknown>;
  notes: string | null;
  active: boolean;
  parlays_built: number | null;
  full_3of3_hits: number | null;
  partial_2of3_hits: number | null;
  per_leg_hit_rate: number | null;
  pool_coverage_rate: number | null;
  top10_coverage_rate: number | null;
  last_evaluated_for: string | null;
}

export interface LearningPredictionRow {
  id: number;
  target_date: string;
  player_id: number;
  model_version: number;
  player_name: string;
  team: string;
  opponent: string | null;
  game_pk: number | null;
  rank: number | null;
  heat_score: number | null;
  model_prob: number | null;
  reason: string | null;
  signals_json: Record<string, boolean>;
  in_safe: boolean;
  in_value: boolean;
  in_chaos: boolean;
  homered: boolean | null;
  hr_count: number | null;
  classification: 'TP' | 'FP' | 'FN' | 'TN' | null;
  captured_at: string | null;
}

export interface FeatureImportanceRowDB {
  id: number;
  model_version: number;
  window_days: number;
  computed_for: string;
  signal_key: string;
  signal_label: string;
  n_present: number;
  hits_present: number;
  rate_present: number;
  n_absent: number;
  hits_absent: number;
  rate_absent: number;
  lift: number;
  importance_score: number;
  sample_quality: 'high' | 'medium' | 'low';
  created_at: string;
}

/** All model versions, newest first. */
export async function fetchModelVersions(): Promise<ModelVersionRow[]> {
  const { data, error } = await supabase
    .from('model_versions')
    .select('*')
    .order('version', { ascending: false });
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as ModelVersionRow[];
}

/** Recent learning_predictions for a window. */
export async function fetchLearningPredictions(opts: {
  from: string; to: string; model_version?: number;
}): Promise<LearningPredictionRow[]> {
  const PAGE_SIZE = 1000;
  const all: LearningPredictionRow[] = [];
  for (let page = 0; page < 30; page++) {
    let q = supabase
      .from('learning_predictions')
      .select('*')
      .gte('target_date', opts.from)
      .lte('target_date', opts.to)
      .order('target_date', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (opts.model_version != null) q = q.eq('model_version', opts.model_version);
    const { data, error } = await q;
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as LearningPredictionRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/** Most-recent feature_importance row per signal_key for a window. */
export async function fetchFeatureImportance(opts: {
  model_version: number; window_days: number;
}): Promise<FeatureImportanceRowDB[]> {
  const { data, error } = await supabase
    .from('feature_importance')
    .select('*')
    .eq('model_version', opts.model_version)
    .eq('window_days', opts.window_days)
    .order('computed_for', { ascending: false })
    .order('importance_score', { ascending: false })
    .limit(200);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  const rows = (data ?? []) as FeatureImportanceRowDB[];
  if (rows.length === 0) return [];
  // Filter to most-recent computed_for (multiple windows may share the same
  // anchor; this query already filtered window_days, so they're all the same date).
  const mostRecent = rows[0].computed_for;
  return rows.filter((r) => r.computed_for === mostRecent);
}
