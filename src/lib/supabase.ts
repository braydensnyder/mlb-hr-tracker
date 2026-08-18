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
  /** Migration 015 — manually marked retired so it's hidden from
   *  comparisons. Historical rows are preserved. */
  retired?: boolean;
  retired_at?: string | null;
  retired_reason?: string | null;
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

/** Per-date capture summary for the Learning Dashboard. Aggregates
 *  learning_predictions rows server-side via a lightweight query. */
export interface LearningCaptureDay {
  date: string;
  model_version: number;
  player_count: number;
  hr_hitter_count: number;
  tp: number; fp: number; fn: number; tn: number;
  /** Most recent captured_at across all rows for the date. */
  last_captured_at: string | null;
}

/**
 * Build a per-day aggregate for the Learning Dashboard. Pulls minimal
 * fields (no signals_json / no reason text) so the page stays fast.
 */
export async function fetchLearningCaptureSummary(opts: {
  from?: string; to?: string; limit?: number;
} = {}): Promise<LearningCaptureDay[]> {
  const PAGE_SIZE = 1000;
  let q = supabase
    .from('learning_predictions')
    .select('target_date, model_version, player_id, homered, classification, captured_at')
    .order('target_date', { ascending: false })
    .order('captured_at', { ascending: false });
  if (opts.from) q = q.gte('target_date', opts.from);
  if (opts.to) q = q.lte('target_date', opts.to);

  const all: { target_date: string; model_version: number; player_id: number; homered: boolean | null; classification: string | null; captured_at: string | null }[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as typeof all;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  // Aggregate by (date, version).
  type Accum = LearningCaptureDay & { player_set: Set<number>; hr_set: Set<number> };
  const acc = new Map<string, Accum>();
  for (const r of all) {
    const key = `${r.target_date}:${r.model_version}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        date: r.target_date,
        model_version: r.model_version,
        player_count: 0,
        hr_hitter_count: 0,
        tp: 0, fp: 0, fn: 0, tn: 0,
        last_captured_at: null,
        player_set: new Set(),
        hr_set: new Set(),
      };
      acc.set(key, entry);
    }
    entry.player_set.add(r.player_id);
    if (r.homered === true) entry.hr_set.add(r.player_id);
    if (r.classification === 'TP') entry.tp++;
    else if (r.classification === 'FP') entry.fp++;
    else if (r.classification === 'FN') entry.fn++;
    else if (r.classification === 'TN') entry.tn++;
    if (r.captured_at && (!entry.last_captured_at || r.captured_at > entry.last_captured_at)) {
      entry.last_captured_at = r.captured_at;
    }
  }
  const summaries: LearningCaptureDay[] = Array.from(acc.values()).map((e) => ({
    date: e.date,
    model_version: e.model_version,
    player_count: e.player_set.size,
    hr_hitter_count: e.hr_set.size,
    tp: e.tp, fp: e.fp, fn: e.fn, tn: e.tn,
    last_captured_at: e.last_captured_at,
  }));
  summaries.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  if (opts.limit) return summaries.slice(0, opts.limit);
  return summaries;
}

/** Per-version performance metrics across a window. Used by the
 *  Learning Dashboard's Model Comparison panel. */
export interface ModelComparisonRow {
  version: number;
  name: string;
  is_active: boolean;
  days_tested: number;
  /** Distinct dates covered. */
  dates: string[];
  total_players_scored: number;
  total_hr_hitters: number;
  /** HR hitters with rank ≤ 10. */
  hr_in_top10: number;
  /** HR hitters with rank ≤ 3. */
  hr_in_top3: number;
  /** Top 10 coverage = hr_in_top10 / total_hr_hitters. */
  top10_coverage: number;
  /** Top 3 coverage = hr_in_top3 / total_hr_hitters. */
  top3_coverage: number;
  /** Days where at least one full 3/3 parlay hit. Best estimate from
   *  the saved in_safe/in_value/in_chaos + homered flags. */
  parlay_full_3of3_hits: number;
  parlay_2of3_hits: number;
  /** Total legs hit across all parlays in the window. */
  total_legs_hit: number;
  /** Total legs placed (parlays_built × 3). */
  total_legs_placed: number;
  parlay_full_hit_rate: number;
  parlay_2of3_hit_rate: number;
  avg_legs_hit_per_parlay: number;
  /** Days where parlays missed every HR hitter. */
  worst_day: { date: string; hr_hitters: number; legs_hit: number } | null;
  /** Day with best 3/3 hit. */
  best_day: { date: string; legs_hit: number; full_parlays_hit: number } | null;
  missed_hr_count: number;
  /** Classification breakdown. */
  tp: number; fp: number; fn: number; tn: number;
}

/** Build per-version comparison metrics from learning_predictions over
 *  a [from, to] date window. Aggregates client-side (no server SQL needed). */
export async function fetchModelComparison(opts: {
  from: string; to: string;
}): Promise<ModelComparisonRow[]> {
  const PAGE_SIZE = 1000;
  // 1. Load all versions for name lookup.
  const versions = await fetchModelVersions();
  if (versions.length === 0) return [];

  // 2. Stream learning_predictions in pages.
  type R = {
    target_date: string; player_id: number; model_version: number;
    rank: number | null; homered: boolean | null;
    in_safe: boolean; in_value: boolean; in_chaos: boolean;
    classification: 'TP' | 'FP' | 'FN' | 'TN' | null;
  };
  const all: R[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabase
      .from('learning_predictions')
      .select('target_date, player_id, model_version, rank, homered, in_safe, in_value, in_chaos, classification')
      .gte('target_date', opts.from)
      .lte('target_date', opts.to)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as R[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  // 3. Group by (version, date) for per-day parlay tally.
  type DayAccum = {
    hr_count: number;            // distinct HR hitters
    hr_in_top10: number;
    hr_in_top3: number;
    safe_legs_hit: number; safe_full: boolean; safe_2of3: boolean; safe_complete: boolean;
    value_legs_hit: number; value_full: boolean; value_2of3: boolean; value_complete: boolean;
    chaos_legs_hit: number; chaos_full: boolean; chaos_2of3: boolean; chaos_complete: boolean;
    hr_seen: Set<number>;
    safe_count: number; value_count: number; chaos_count: number;
  };
  const dayByVer = new Map<string, DayAccum>(); // key = `${version}:${date}`

  for (const r of all) {
    const key = `${r.model_version}:${r.target_date}`;
    let day = dayByVer.get(key);
    if (!day) {
      day = {
        hr_count: 0, hr_in_top10: 0, hr_in_top3: 0,
        safe_legs_hit: 0, safe_full: false, safe_2of3: false, safe_complete: false,
        value_legs_hit: 0, value_full: false, value_2of3: false, value_complete: false,
        chaos_legs_hit: 0, chaos_full: false, chaos_2of3: false, chaos_complete: false,
        hr_seen: new Set<number>(),
        safe_count: 0, value_count: 0, chaos_count: 0,
      };
      dayByVer.set(key, day);
    }
    if (r.homered === true && !day.hr_seen.has(r.player_id)) {
      day.hr_seen.add(r.player_id);
      day.hr_count += 1;
      if (r.rank != null && r.rank <= 10) day.hr_in_top10 += 1;
      if (r.rank != null && r.rank <= 3) day.hr_in_top3 += 1;
    }
    if (r.in_safe) {
      day.safe_count += 1;
      if (r.homered === true) day.safe_legs_hit += 1;
    }
    if (r.in_value) {
      day.value_count += 1;
      if (r.homered === true) day.value_legs_hit += 1;
    }
    if (r.in_chaos) {
      day.chaos_count += 1;
      if (r.homered === true) day.chaos_legs_hit += 1;
    }
  }

  // Decide parlay completion + hit status per day-version.
  for (const day of dayByVer.values()) {
    day.safe_complete = day.safe_count === 3;
    day.value_complete = day.value_count === 3;
    day.chaos_complete = day.chaos_count === 3;
    if (day.safe_complete && day.safe_legs_hit === 3) day.safe_full = true;
    else if (day.safe_complete && day.safe_legs_hit === 2) day.safe_2of3 = true;
    if (day.value_complete && day.value_legs_hit === 3) day.value_full = true;
    else if (day.value_complete && day.value_legs_hit === 2) day.value_2of3 = true;
    if (day.chaos_complete && day.chaos_legs_hit === 3) day.chaos_full = true;
    else if (day.chaos_complete && day.chaos_legs_hit === 2) day.chaos_2of3 = true;
  }

  // 4. Roll up per version.
  const out: ModelComparisonRow[] = [];
  for (const v of versions) {
    const days = Array.from(dayByVer.entries())
      .filter(([k]) => k.startsWith(`${v.version}:`))
      .map(([k, day]) => ({ date: k.split(':')[1], day }));
    if (days.length === 0) {
      out.push({
        version: v.version, name: v.name, is_active: v.active,
        days_tested: 0, dates: [],
        total_players_scored: 0,
        total_hr_hitters: 0,
        hr_in_top10: 0, hr_in_top3: 0,
        top10_coverage: 0, top3_coverage: 0,
        parlay_full_3of3_hits: 0, parlay_2of3_hits: 0,
        total_legs_hit: 0, total_legs_placed: 0,
        parlay_full_hit_rate: 0, parlay_2of3_hit_rate: 0, avg_legs_hit_per_parlay: 0,
        worst_day: null, best_day: null,
        missed_hr_count: 0,
        tp: 0, fp: 0, fn: 0, tn: 0,
      });
      continue;
    }

    // Total players scored = all rows for this version (not deduped — different days).
    const totalPlayers = all.filter((r) => r.model_version === v.version).length;
    let totalHr = 0, top10 = 0, top3 = 0;
    let fullHits = 0, twoOfThree = 0;
    let legsHit = 0, legsPlaced = 0;
    let bestDay: ModelComparisonRow['best_day'] = null;
    let worstDay: ModelComparisonRow['worst_day'] = null;
    let parlaysBuilt = 0;

    for (const { date, day } of days) {
      totalHr += day.hr_count;
      top10 += day.hr_in_top10;
      top3 += day.hr_in_top3;
      const dayLegsHit = day.safe_legs_hit + day.value_legs_hit + day.chaos_legs_hit;
      const dayLegsPlaced = (day.safe_complete ? 3 : 0) + (day.value_complete ? 3 : 0) + (day.chaos_complete ? 3 : 0);
      const dayFull = (day.safe_full ? 1 : 0) + (day.value_full ? 1 : 0) + (day.chaos_full ? 1 : 0);
      const dayPartial = (day.safe_2of3 ? 1 : 0) + (day.value_2of3 ? 1 : 0) + (day.chaos_2of3 ? 1 : 0);
      const dayParlays = (day.safe_complete ? 1 : 0) + (day.value_complete ? 1 : 0) + (day.chaos_complete ? 1 : 0);
      legsHit += dayLegsHit;
      legsPlaced += dayLegsPlaced;
      fullHits += dayFull;
      twoOfThree += dayPartial;
      parlaysBuilt += dayParlays;

      if (!bestDay || dayFull > bestDay.full_parlays_hit ||
          (dayFull === bestDay.full_parlays_hit && dayLegsHit > bestDay.legs_hit)) {
        bestDay = { date, legs_hit: dayLegsHit, full_parlays_hit: dayFull };
      }
      if (!worstDay || (day.hr_count > 0 && dayLegsHit < (worstDay.legs_hit ?? 0))) {
        worstDay = { date, hr_hitters: day.hr_count, legs_hit: dayLegsHit };
      }
    }

    const versionRows = all.filter((r) => r.model_version === v.version);
    const tp = versionRows.filter((r) => r.classification === 'TP').length;
    const fp = versionRows.filter((r) => r.classification === 'FP').length;
    const fn = versionRows.filter((r) => r.classification === 'FN').length;
    const tn = versionRows.filter((r) => r.classification === 'TN').length;

    out.push({
      version: v.version, name: v.name, is_active: v.active,
      days_tested: days.length,
      dates: days.map((d) => d.date).sort(),
      total_players_scored: totalPlayers,
      total_hr_hitters: totalHr,
      hr_in_top10: top10,
      hr_in_top3: top3,
      top10_coverage: totalHr > 0 ? top10 / totalHr : 0,
      top3_coverage: totalHr > 0 ? top3 / totalHr : 0,
      parlay_full_3of3_hits: fullHits,
      parlay_2of3_hits: twoOfThree,
      total_legs_hit: legsHit,
      total_legs_placed: legsPlaced,
      parlay_full_hit_rate: parlaysBuilt > 0 ? fullHits / parlaysBuilt : 0,
      parlay_2of3_hit_rate: parlaysBuilt > 0 ? twoOfThree / parlaysBuilt : 0,
      avg_legs_hit_per_parlay: parlaysBuilt > 0 ? legsHit / parlaysBuilt : 0,
      worst_day: worstDay,
      best_day: bestDay,
      missed_hr_count: fn,
      tp, fp, fn, tn,
    });
  }

  return out.sort((a, b) => a.version - b.version);
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

// =============================================================================
//  Research / Champion / Model Drill-Down fetchers (Phase: Champion System)
// =============================================================================

/** All learning_predictions rows for a single (date, version) — used by
 *  the ModelCard's "today/historical" drill-down. */
export async function fetchLearningForDateVersion(opts: {
  date: string; model_version: number;
}): Promise<LearningPredictionRow[]> {
  const PAGE_SIZE = 1000;
  const all: LearningPredictionRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from('learning_predictions')
      .select('*')
      .eq('target_date', opts.date)
      .eq('model_version', opts.model_version)
      .order('rank', { ascending: true, nullsFirst: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
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

/** All learning_predictions for a single date across ALL model versions —
 *  used by the HistoricalDay + CompareModels pages. */
export async function fetchAllVersionsForDate(date: string): Promise<LearningPredictionRow[]> {
  const PAGE_SIZE = 1000;
  const all: LearningPredictionRow[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await supabase
      .from('learning_predictions')
      .select('*')
      .eq('target_date', date)
      .order('model_version', { ascending: true })
      .order('rank', { ascending: true, nullsFirst: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
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

// -----------------------------------------------------------------------------
//  Research segmentation — joins learning_predictions with games
// -----------------------------------------------------------------------------

export type ResearchSegment =
  | 'pitcher_hand'      // RHP vs LHP
  | 'slate_size'        // <6 / 6-9 / 10+ games
  | 'temperature'       // hot ≥85F / warm 70-85F / cool <70F
  | 'wind'              // out / in / neutral
  | 'park_factor';      // hitter-friendly / neutral / pitcher-friendly (proxied by venue_l14d_rank when available)

export interface ResearchSegmentBucket {
  /** Bucket label: 'RHP', 'Large (10+ games)', 'Hot (≥85°F)', etc. */
  label: string;
  /** Per-version performance inside this bucket. */
  per_version: Array<{
    version: number;
    name: string;
    total_player_days: number;
    tp: number; fp: number; fn: number; tn: number;
    /** TP / (TP + FN) — recall. */
    recall: number;
    /** TP / (TP + FP) — precision. */
    precision: number;
    /** F1 over the bucket. */
    f1: number;
    /** HRs captured in Top 10 / total HRs in bucket. */
    top10_coverage: number;
    total_hrs_in_bucket: number;
    hrs_in_top10: number;
  }>;
}

export interface ResearchSegmentResult {
  segment: ResearchSegment;
  buckets: ResearchSegmentBucket[];
  /** Total games / player-days the segmentation could classify. */
  total_player_days_classified: number;
  /** Player-days that couldn't be classified (missing game data, etc.). */
  unclassified: number;
  note: string;
}

interface GameRowLite {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  home_probable_pitcher_hand: string | null;
  away_probable_pitcher_hand: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  venue_name: string | null;
}

/** Load games for a date range (used by research join). Returns empty
 *  on missing tables. */
async function fetchGamesForRange(from: string, to: string): Promise<Map<number, GameRowLite>> {
  const out = new Map<number, GameRowLite>();
  const PAGE_SIZE = 1000;
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from('games')
      .select('game_pk, game_date, home_team, away_team, ' +
        'home_probable_pitcher_hand, away_probable_pitcher_hand, ' +
        'weather_temp_f, weather_wind_mph, weather_wind_dir, venue_name')
      .gte('game_date', from)
      .lte('game_date', to)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(error.message);
    }
    const rows = (data ?? []) as unknown as GameRowLite[];
    for (const g of rows) out.set(g.game_pk, g);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** Compute per-segment, per-version performance over a window.
 *  Joins learning_predictions with games on game_pk + uses the player's
 *  team to determine which side they bat on (and thus which pitcher they
 *  face). */
export async function fetchResearchSegmentation(opts: {
  from: string; to: string; segment: ResearchSegment;
}): Promise<ResearchSegmentResult> {
  const versions = await fetchModelVersions();
  const games = await fetchGamesForRange(opts.from, opts.to);

  // Pull learning_predictions in the window.
  const PAGE_SIZE = 1000;
  const preds: LearningPredictionRow[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabase
      .from('learning_predictions')
      .select('*')
      .gte('target_date', opts.from)
      .lte('target_date', opts.to)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        return { segment: opts.segment, buckets: [], total_player_days_classified: 0, unclassified: 0, note: 'learning_predictions missing — apply migrations 013/014.' };
      }
      throw new Error(error.message);
    }
    const rows = (data ?? []) as LearningPredictionRow[];
    preds.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  // For slate_size we need games-per-date.
  const gamesPerDate = new Map<string, number>();
  for (const g of games.values()) {
    gamesPerDate.set(g.game_date, (gamesPerDate.get(g.game_date) ?? 0) + 1);
  }

  // Bucket helper — returns label or null if unclassifiable.
  function bucketize(row: LearningPredictionRow): string | null {
    const game = row.game_pk != null ? games.get(row.game_pk) : null;

    switch (opts.segment) {
      case 'pitcher_hand': {
        if (!game) return null;
        // Player faces the OPPOSING pitcher. Determine which team the
        // player is on, then take the other side's pitcher hand.
        const isHome = game.home_team === row.team;
        const isAway = game.away_team === row.team;
        if (!isHome && !isAway) return null;
        const pitcherHand = isHome ? game.away_probable_pitcher_hand : game.home_probable_pitcher_hand;
        if (pitcherHand === 'R') return 'vs RHP';
        if (pitcherHand === 'L') return 'vs LHP';
        return null;
      }
      case 'slate_size': {
        const n = gamesPerDate.get(row.target_date) ?? 0;
        if (n === 0) return null;
        if (n <= 5) return 'Small (≤5 games)';
        if (n <= 9) return 'Medium (6–9 games)';
        return 'Large (10+ games)';
      }
      case 'temperature': {
        if (!game || game.weather_temp_f == null) return null;
        if (game.weather_temp_f >= 85) return 'Hot (≥85°F)';
        if (game.weather_temp_f >= 70) return 'Warm (70–85°F)';
        return 'Cool (<70°F)';
      }
      case 'wind': {
        if (!game || game.weather_wind_dir == null || game.weather_wind_mph == null) return null;
        const dir = game.weather_wind_dir.toLowerCase();
        if (game.weather_wind_mph >= 10 && /out/.test(dir)) return 'Wind out (10+ mph)';
        if (game.weather_wind_mph >= 10 && /in/.test(dir)) return 'Wind in (10+ mph)';
        return 'Neutral wind';
      }
      case 'park_factor': {
        // We don't have ballpark factor stored. Heuristic: known hitter-
        // friendly parks vs known pitcher-friendly vs neutral. Same list
        // used elsewhere in the project would be ideal; here we lean on
        // venue name keywords — best we can do without venue_factor data.
        if (!game || !game.venue_name) return null;
        const v = game.venue_name.toLowerCase();
        if (/coors|fenway|camden|cincinnati|great american|yankee stadium|globe life|citizens bank/.test(v)) return 'Hitter-friendly';
        if (/petco|oracle|t-mobile|tropicana|comerica|kauffman/.test(v)) return 'Pitcher-friendly';
        return 'Neutral';
      }
    }
    return null;
  }

  // Aggregate per (bucket, version).
  const bucketsMap = new Map<string, Map<number, {
    total: number; tp: number; fp: number; fn: number; tn: number;
    hr_seen: Set<number>; hr_in_top10: number;
  }>>();
  let totalClassified = 0;
  let unclassified = 0;

  for (const row of preds) {
    const label = bucketize(row);
    if (!label) { unclassified += 1; continue; }
    totalClassified += 1;
    let byVer = bucketsMap.get(label);
    if (!byVer) { byVer = new Map(); bucketsMap.set(label, byVer); }
    let cell = byVer.get(row.model_version);
    if (!cell) {
      cell = { total: 0, tp: 0, fp: 0, fn: 0, tn: 0, hr_seen: new Set(), hr_in_top10: 0 };
      byVer.set(row.model_version, cell);
    }
    cell.total += 1;
    if (row.classification === 'TP') cell.tp += 1;
    else if (row.classification === 'FP') cell.fp += 1;
    else if (row.classification === 'FN') cell.fn += 1;
    else if (row.classification === 'TN') cell.tn += 1;
    if (row.homered === true && !cell.hr_seen.has(row.player_id)) {
      cell.hr_seen.add(row.player_id);
      if (row.rank != null && row.rank <= 10) cell.hr_in_top10 += 1;
    }
  }

  const buckets: ResearchSegmentBucket[] = Array.from(bucketsMap.entries())
    .map(([label, byVer]) => ({
      label,
      per_version: versions.map((v) => {
        const cell = byVer.get(v.version) ?? { total: 0, tp: 0, fp: 0, fn: 0, tn: 0, hr_seen: new Set<number>(), hr_in_top10: 0 };
        const recall = cell.tp + cell.fn > 0 ? cell.tp / (cell.tp + cell.fn) : 0;
        const precision = cell.tp + cell.fp > 0 ? cell.tp / (cell.tp + cell.fp) : 0;
        const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        return {
          version: v.version, name: v.name,
          total_player_days: cell.total,
          tp: cell.tp, fp: cell.fp, fn: cell.fn, tn: cell.tn,
          recall, precision, f1,
          top10_coverage: cell.hr_seen.size > 0 ? cell.hr_in_top10 / cell.hr_seen.size : 0,
          total_hrs_in_bucket: cell.hr_seen.size,
          hrs_in_top10: cell.hr_in_top10,
        };
      }),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    segment: opts.segment,
    buckets,
    total_player_days_classified: totalClassified,
    unclassified,
    note: opts.segment === 'park_factor'
      ? 'Park factor uses a hand-coded venue keyword list (no quantitative park-factor ingest yet). Treat as directional only.'
      : opts.segment === 'pitcher_hand'
        ? 'Player\'s team determines side; pitcher_hand comes from the opposing probable pitcher. Skipped rows: probable pitcher TBD.'
        : 'Joined with games table on game_pk. Skipped rows: game missing or weather not yet enriched.',
  };
}

/** Captured dates available in learning_predictions — useful for the
 *  HistoricalDay page's date picker. */
export async function fetchCapturedDates(opts: { limit?: number } = {}): Promise<string[]> {
  const PAGE_SIZE = 1000;
  const dates = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabase
      .from('learning_predictions')
      .select('target_date')
      .order('target_date', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as { target_date: string }[];
    for (const r of rows) dates.add(r.target_date);
    if (rows.length < PAGE_SIZE) break;
  }
  const sorted = Array.from(dates).sort().reverse();
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
}

// =============================================================================
//  Version Performance Calendar (Priority 1)
// =============================================================================

/** Simple per-(date, version) row for the calendar's headline table.
 *  Counts distinct HR hitters, then how many landed in each Top-N slice. */
export interface CalendarVersionRow {
  version: number;
  name: string;
  is_active: boolean;
  is_retired: boolean;
  top3_hits: number;
  top5_hits: number;
  top10_hits: number;
  top25_hits: number;
  /** Snapshot rows recorded for this version this date (proxy for "did it run"). */
  players_scored: number;
}

export interface CalendarDayResult {
  date: string;
  total_hr_hitters: number;
  versions: CalendarVersionRow[];
  /** Full learning_predictions rows for the date — used to power the
   *  expandable per-version pick list. Keyed by version. */
  picks_by_version: Map<number, LearningPredictionRow[]>;
}

/** Load per-date, per-version calendar summary + the underlying picks
 *  for expandable rows. One page-side aggregation over
 *  learning_predictions + model_versions. */
export async function fetchVersionCalendar(date: string): Promise<CalendarDayResult> {
  const [versions, preds] = await Promise.all([
    fetchModelVersions(),
    fetchAllVersionsForDate(date),
  ]);

  // Distinct HR hitters that day (dedup across versions — same underlying HR list).
  const distinctHrIds = new Set<number>();
  for (const p of preds) {
    if (p.homered === true) distinctHrIds.add(p.player_id);
  }

  // For each (version), tally hit counts in each Top-N bucket.
  const picksByVer = new Map<number, LearningPredictionRow[]>();
  for (const p of preds) {
    const arr = picksByVer.get(p.model_version) ?? [];
    arr.push(p);
    picksByVer.set(p.model_version, arr);
  }

  const rows: CalendarVersionRow[] = versions.map((v) => {
    const list = picksByVer.get(v.version) ?? [];
    let t3 = 0, t5 = 0, t10 = 0, t25 = 0;
    for (const p of list) {
      if (p.homered !== true || p.rank == null) continue;
      if (p.rank <= 3) t3 += 1;
      if (p.rank <= 5) t5 += 1;
      if (p.rank <= 10) t10 += 1;
      if (p.rank <= 25) t25 += 1;
    }
    return {
      version: v.version, name: v.name,
      is_active: v.active, is_retired: !!v.retired,
      top3_hits: t3, top5_hits: t5, top10_hits: t10, top25_hits: t25,
      players_scored: list.length,
    };
  });

  return {
    date,
    total_hr_hitters: distinctHrIds.size,
    versions: rows,
    picks_by_version: picksByVer,
  };
}

/** Rolling-window per-version summary. */
export interface CalendarRollingRow {
  version: number;
  name: string;
  is_active: boolean;
  is_retired: boolean;
  days_tested: number;
  avg_top3: number;
  avg_top5: number;
  avg_top10: number;
  avg_top25: number;
  best_day: { date: string; top10_hits: number } | null;
  worst_day: { date: string; top10_hits: number; hr_hitters: number } | null;
  /** Days this version had strictly more Top-10 hits than the reference
   *  version (v1 by default). */
  days_beating_core: number;
  /** Days both were tested and could be compared. */
  days_compared: number;
}

/** Rolling-window per-version rollup + comparison to a "core" version. */
export async function fetchVersionRolling(opts: {
  from: string; to: string; coreVersion?: number;
}): Promise<CalendarRollingRow[]> {
  const coreVersion = opts.coreVersion ?? 1;
  const versions = await fetchModelVersions();

  // Stream learning_predictions in the window.
  const PAGE_SIZE = 1000;
  const all: LearningPredictionRow[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabase
      .from('learning_predictions')
      .select('target_date, player_id, model_version, rank, homered')
      .gte('target_date', opts.from)
      .lte('target_date', opts.to)
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as LearningPredictionRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  // Group by (version, date).
  type DayCell = { top3: number; top5: number; top10: number; top25: number; hr_hitters: Set<number> };
  const byVerDate = new Map<string, DayCell>();
  for (const p of all) {
    const key = `${p.model_version}:${p.target_date}`;
    let cell = byVerDate.get(key);
    if (!cell) {
      cell = { top3: 0, top5: 0, top10: 0, top25: 0, hr_hitters: new Set() };
      byVerDate.set(key, cell);
    }
    if (p.homered === true) {
      cell.hr_hitters.add(p.player_id);
      if (p.rank != null) {
        if (p.rank <= 3) cell.top3 += 1;
        if (p.rank <= 5) cell.top5 += 1;
        if (p.rank <= 10) cell.top10 += 1;
        if (p.rank <= 25) cell.top25 += 1;
      }
    }
  }

  // Roll up per version.
  return versions.map((v) => {
    const days = Array.from(byVerDate.entries())
      .filter(([k]) => k.startsWith(`${v.version}:`))
      .map(([k, cell]) => ({ date: k.split(':')[1], cell }));

    if (days.length === 0) {
      return {
        version: v.version, name: v.name,
        is_active: v.active, is_retired: !!v.retired,
        days_tested: 0,
        avg_top3: 0, avg_top5: 0, avg_top10: 0, avg_top25: 0,
        best_day: null, worst_day: null,
        days_beating_core: 0, days_compared: 0,
      };
    }

    const sum3 = days.reduce((s, d) => s + d.cell.top3, 0);
    const sum5 = days.reduce((s, d) => s + d.cell.top5, 0);
    const sum10 = days.reduce((s, d) => s + d.cell.top10, 0);
    const sum25 = days.reduce((s, d) => s + d.cell.top25, 0);

    let bestDay: CalendarRollingRow['best_day'] = null;
    let worstDay: CalendarRollingRow['worst_day'] = null;
    for (const { date, cell } of days) {
      if (!bestDay || cell.top10 > bestDay.top10_hits) {
        bestDay = { date, top10_hits: cell.top10 };
      }
      if (cell.hr_hitters.size >= 5 && (!worstDay || cell.top10 < worstDay.top10_hits)) {
        worstDay = { date, top10_hits: cell.top10, hr_hitters: cell.hr_hitters.size };
      }
    }

    // Days beating core (default v1).
    let daysBeating = 0, daysCompared = 0;
    for (const { date, cell } of days) {
      const coreCell = byVerDate.get(`${coreVersion}:${date}`);
      if (!coreCell) continue;
      daysCompared += 1;
      if (cell.top10 > coreCell.top10) daysBeating += 1;
    }

    return {
      version: v.version, name: v.name,
      is_active: v.active, is_retired: !!v.retired,
      days_tested: days.length,
      avg_top3: sum3 / days.length,
      avg_top5: sum5 / days.length,
      avg_top10: sum10 / days.length,
      avg_top25: sum25 / days.length,
      best_day: bestDay,
      worst_day: worstDay,
      days_beating_core: daysBeating,
      days_compared: daysCompared,
    };
  });
}

// =============================================================================
//  Hits tab (mig 021) — read-only fetchers isolated from the HR pipeline
// =============================================================================

/** One row served to the /hits page. Flattened from hit_target_universe
 *  or hit_target_snapshots (both tables share the same core columns —
 *  we merge the shape client-side so components don't care which source). */
export interface HitBoardRow {
  target_date: string;
  player_id: number;
  player_name: string;
  team: string;
  opponent: string | null;
  game_pk: number | null;

  batting_order_slot: number | null;
  lineup_status: string;
  opposing_starter_id: number | null;
  opposing_starter_hand: string | null;

  hit_prob_1plus: number | null;
  hit_score_1plus: number | null;
  rank_1plus: number | null;
  team_rank_1plus: number | null;
  confidence_1plus: string | null;
  contributions_1plus_json: Record<string, unknown> | null;

  hit_prob_2plus: number | null;
  hit_score_2plus: number | null;
  rank_2plus: number | null;
  team_rank_2plus: number | null;
  confidence_2plus: string | null;
  contributions_2plus_json: Record<string, unknown> | null;

  flags: string[];
  model_config_id_1plus: string;
  model_config_hash_1plus: string;
  model_config_id_2plus: string;
  model_config_hash_2plus: string;

  /** True when this row came from hit_target_snapshots — meaning the
   *  outcome fields below MAY have data. Live-view rows carry nulls. */
  is_snapshot_row: boolean;
  snapshot_type: 'pregame' | 'simulated' | null;
  hits: number | null;
  at_bats: number | null;
  hit_1plus: boolean | null;
  hit_2plus: boolean | null;
  doubles: number | null;
  triples: number | null;
  outcome_enriched_at: string | null;
}

export interface HitBoardBundle {
  date: string;
  source: 'universe' | 'snapshots';
  model_version: number;
  rows: HitBoardRow[];
  /** For snapshot-source bundles: 'pregame' when the row was written
   *  before first pitch, 'simulated' when reconstructed after the
   *  fact via backfill:hit-snapshots. Null when reading the live
   *  universe (which has no snapshot_type concept). */
  snapshot_type: 'pregame' | 'simulated' | null;
  /** Bundle-level outcome flag — true when at least one row has
   *  outcome_enriched_at set. Drives success highlighting + Top-N
   *  summary rendering on the /hits page. */
  outcomes_enriched: boolean;
  /** Model identity + validation state — the /hits page reads this to
   *  decide whether to show the EXPERIMENTAL badge. */
  model_1plus_id: string | null;
  model_1plus_hash: string | null;
  model_1plus_is_validated: boolean;
  model_2plus_id: string | null;
  model_2plus_hash: string | null;
  model_2plus_is_validated: boolean;
}

/** Detect whether a config id string denotes an experimental config.
 *  The producer of the row is the source of truth (hitModels.ts) but
 *  we don't want to import that here — the id string prefix is a
 *  reliable proxy since every experimental config id starts with
 *  'experimental_'. */
function isExperimentalConfigId(id: string | null): boolean {
  return typeof id === 'string' && id.startsWith('experimental_');
}

/**
 * Load one date's Hits board. Prefers hit_target_universe (live view)
 * when target_date == today; falls back to hit_target_snapshots for
 * past dates so the board reflects the frozen pregame audit record.
 *
 * `dateIsToday` should be true when the caller has already anchored the
 * page date at the Pacific-anchored today. When true and the universe
 * returns rows, we use those; otherwise we read snapshots (which for
 * today would exist AFTER Phase 4.7 has run).
 */
export async function fetchHitTargetsForDate(
  date: string,
  opts: { modelVersion?: number; preferSnapshots?: boolean } = {},
): Promise<HitBoardBundle> {
  const modelVersion = opts.modelVersion ?? 1;
  const preferSnapshots = !!opts.preferSnapshots;

  // Try snapshots first for past dates OR when caller forced it.
  const trySnapshotsFirst = preferSnapshots;

  async function readUniverse(): Promise<HitBoardRow[]> {
    const { data, error } = await supabase
      .from('hit_target_universe')
      .select(
        'target_date, player_id, player_name, team, opponent, game_pk, ' +
        'batting_order_slot, lineup_status, opposing_starter_id, opposing_starter_hand, ' +
        'hit_prob_1plus, hit_score_1plus, rank_1plus, team_rank_1plus, ' +
        'confidence_1plus, contributions_1plus_json, ' +
        'hit_prob_2plus, hit_score_2plus, rank_2plus, team_rank_2plus, ' +
        'confidence_2plus, contributions_2plus_json, ' +
        'flags, model_config_id_1plus, model_config_hash_1plus, ' +
        'model_config_id_2plus, model_config_hash_2plus',
      )
      .eq('target_date', date)
      .eq('model_version', modelVersion);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`hit_target_universe read: ${error.message}`);
    }
    return ((data ?? []) as unknown as Array<Omit<HitBoardRow, 'is_snapshot_row' | 'snapshot_type' | 'hits' | 'at_bats' | 'hit_1plus' | 'hit_2plus' | 'doubles' | 'triples' | 'outcome_enriched_at'>>)
      .map((r) => ({
        ...r,
        is_snapshot_row: false,
        snapshot_type: null,
        hits: null, at_bats: null, hit_1plus: null, hit_2plus: null,
        doubles: null, triples: null, outcome_enriched_at: null,
      }));
  }

  async function readSnapshots(): Promise<HitBoardRow[]> {
    const { data, error } = await supabase
      .from('hit_target_snapshots')
      .select(
        'target_date, player_id, player_name, team, opponent, game_pk, ' +
        'batting_order_slot, lineup_status, opposing_starter_id, opposing_starter_hand, ' +
        'hit_prob_1plus, hit_score_1plus, rank_1plus, team_rank_1plus, ' +
        'confidence_1plus, contributions_1plus_json, ' +
        'hit_prob_2plus, hit_score_2plus, rank_2plus, team_rank_2plus, ' +
        'confidence_2plus, contributions_2plus_json, ' +
        'flags, model_config_id_1plus, model_config_hash_1plus, ' +
        'model_config_id_2plus, model_config_hash_2plus, ' +
        'snapshot_type, ' +
        'hits, at_bats, hit_1plus, hit_2plus, doubles, triples, outcome_enriched_at',
      )
      .eq('target_date', date)
      .eq('model_version', modelVersion);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`hit_target_snapshots read: ${error.message}`);
    }
    return ((data ?? []) as unknown as HitBoardRow[]).map((r) => ({ ...r, is_snapshot_row: true }));
  }

  let rows: HitBoardRow[] = [];
  let source: 'universe' | 'snapshots' = 'universe';
  if (trySnapshotsFirst) {
    rows = await readSnapshots();
    source = 'snapshots';
    if (rows.length === 0) { rows = await readUniverse(); source = 'universe'; }
  } else {
    rows = await readUniverse();
    source = 'universe';
    if (rows.length === 0) { rows = await readSnapshots(); source = 'snapshots'; }
  }

  const sample = rows[0] ?? null;
  // Bundle-level snapshot_type: rows written on the same date/version
  // share the same snapshot_type by design (writer stamps one value
  // per run). Read from the first snapshot row when the source is
  // snapshots; null for live-universe reads.
  const snapshot_type: HitBoardBundle['snapshot_type'] =
    source === 'snapshots' ? (sample?.snapshot_type ?? null) : null;
  const outcomes_enriched = rows.some((r) => r.outcome_enriched_at != null);
  return {
    date,
    source,
    model_version: modelVersion,
    rows,
    snapshot_type,
    outcomes_enriched,
    model_1plus_id: sample?.model_config_id_1plus ?? null,
    model_1plus_hash: sample?.model_config_hash_1plus ?? null,
    model_1plus_is_validated: !isExperimentalConfigId(sample?.model_config_id_1plus ?? null),
    model_2plus_id: sample?.model_config_id_2plus ?? null,
    model_2plus_hash: sample?.model_config_hash_2plus ?? null,
    model_2plus_is_validated: !isExperimentalConfigId(sample?.model_config_id_2plus ?? null),
  };
}
