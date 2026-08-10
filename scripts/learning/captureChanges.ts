/**
 * captureChanges — detect what moved between snapshot time and now.
 *
 * Compares the frozen game_state_at_snapshot rows for a date against the
 * current games + odds_snapshots state. Any meaningful delta is appended
 * to snapshot_changes so the UI can distinguish "model was wrong" from
 * "info changed after the pick."
 *
 * Meaningful deltas:
 *   - lineup_confirmed: baseline=false, now=true (lineups posted)
 *   - probable_pitcher: home or away probable pitcher id changed
 *   - weather_temp: |Δ| ≥ 3°F
 *   - weather_wind: |Δ| ≥ 3 mph
 *   - odds_move: |ΔAmerican| ≥ 30 pts on the latest odds_snapshots row
 *
 * Idempotent: each detection is a fresh log entry, but we dedupe by
 * (target_date, change_type, game_pk/player_id, to_value) so re-runs
 * within a few minutes don't spam the log.
 *
 * Meant to be called by the cron on the `full` tier (~every 6h) once
 * the morning snapshot exists. Manual CLI also supported:
 *   npm run learning:capture-changes -- 2026-06-27
 *   npm run learning:capture-changes -- today
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';

interface GameStateRow {
  target_date: string;
  game_pk: number;
  captured_at: string;
  lineups_confirmed: boolean | null;
  home_probable_pitcher_id: number | null;
  away_probable_pitcher_id: number | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
}
interface GameRow {
  game_pk: number;
  lineups_confirmed: boolean | null;
  home_probable_pitcher_id: number | null;
  away_probable_pitcher_id: number | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
}

export interface ChangeCaptureResult {
  date: string;
  games_compared: number;
  changes_written: number;
  changes_by_type: Record<string, number>;
  baseline_missing: boolean;
  skipped: string[];
}

const WEATHER_TEMP_DELTA_MIN = 3;    // °F
const WEATHER_WIND_DELTA_MIN = 3;    // mph
const ODDS_DELTA_MIN = 30;           // American points

async function loadBaseline(date: string): Promise<GameStateRow[]> {
  const { data, error } = await supabaseAdmin
    .from('game_state_at_snapshot')
    .select('*')
    .eq('target_date', date);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(`game_state_at_snapshot: ${error.message}`);
  }
  return (data ?? []) as GameStateRow[];
}

async function loadCurrentGames(date: string): Promise<Map<number, GameRow>> {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('game_pk, lineups_confirmed, home_probable_pitcher_id, away_probable_pitcher_id, weather_temp_f, weather_wind_mph, weather_wind_dir')
    .eq('game_date', date);
  if (error) throw new Error(`games: ${error.message}`);
  const m = new Map<number, GameRow>();
  for (const r of (data ?? []) as GameRow[]) m.set(r.game_pk, r);
  return m;
}

interface ChangeToWrite {
  target_date: string;
  game_pk: number | null;
  player_id: number | null;
  change_type: string;
  from_value: unknown;
  to_value: unknown;
  delta_note: string;
}

export async function captureChangesForDate(date: string): Promise<ChangeCaptureResult> {
  console.log(`[captureChanges] scanning ${date}…`);

  const baseline = await loadBaseline(date);
  if (baseline.length === 0) {
    console.warn(`[captureChanges] no game_state_at_snapshot rows for ${date} — skipping. (Apply migration 016 or ensure snapshotHrTargets ran.)`);
    return {
      date, games_compared: 0, changes_written: 0,
      changes_by_type: {}, baseline_missing: true, skipped: [],
    };
  }

  const currentGames = await loadCurrentGames(date);
  const changes: ChangeToWrite[] = [];
  const skipped: string[] = [];

  for (const base of baseline) {
    const cur = currentGames.get(base.game_pk);
    if (!cur) {
      skipped.push(`game ${base.game_pk} not in current games — skipped`);
      continue;
    }

    // 1. Lineup confirmed
    if (base.lineups_confirmed === false && cur.lineups_confirmed === true) {
      changes.push({
        target_date: date, game_pk: base.game_pk, player_id: null,
        change_type: 'lineup_confirmed',
        from_value: false, to_value: true,
        delta_note: 'lineup posted after snapshot',
      });
    }

    // 2. Probable pitcher swap (either side)
    if (base.home_probable_pitcher_id !== cur.home_probable_pitcher_id) {
      changes.push({
        target_date: date, game_pk: base.game_pk, player_id: null,
        change_type: 'probable_pitcher',
        from_value: { side: 'home', id: base.home_probable_pitcher_id },
        to_value: { side: 'home', id: cur.home_probable_pitcher_id },
        delta_note: `home probable ${base.home_probable_pitcher_id ?? 'TBD'} → ${cur.home_probable_pitcher_id ?? 'TBD'}`,
      });
    }
    if (base.away_probable_pitcher_id !== cur.away_probable_pitcher_id) {
      changes.push({
        target_date: date, game_pk: base.game_pk, player_id: null,
        change_type: 'probable_pitcher',
        from_value: { side: 'away', id: base.away_probable_pitcher_id },
        to_value: { side: 'away', id: cur.away_probable_pitcher_id },
        delta_note: `away probable ${base.away_probable_pitcher_id ?? 'TBD'} → ${cur.away_probable_pitcher_id ?? 'TBD'}`,
      });
    }

    // 3. Weather temperature
    if (base.weather_temp_f != null && cur.weather_temp_f != null) {
      const d = cur.weather_temp_f - base.weather_temp_f;
      if (Math.abs(d) >= WEATHER_TEMP_DELTA_MIN) {
        changes.push({
          target_date: date, game_pk: base.game_pk, player_id: null,
          change_type: 'weather_temp',
          from_value: base.weather_temp_f, to_value: cur.weather_temp_f,
          delta_note: `${d > 0 ? '+' : ''}${d.toFixed(0)}°F`,
        });
      }
    }

    // 4. Weather wind
    if (base.weather_wind_mph != null && cur.weather_wind_mph != null) {
      const d = cur.weather_wind_mph - base.weather_wind_mph;
      const dirChanged = (base.weather_wind_dir ?? '') !== (cur.weather_wind_dir ?? '');
      if (Math.abs(d) >= WEATHER_WIND_DELTA_MIN || dirChanged) {
        changes.push({
          target_date: date, game_pk: base.game_pk, player_id: null,
          change_type: 'weather_wind',
          from_value: { mph: base.weather_wind_mph, dir: base.weather_wind_dir },
          to_value: { mph: cur.weather_wind_mph, dir: cur.weather_wind_dir },
          delta_note: `${d > 0 ? '+' : ''}${d.toFixed(0)} mph${dirChanged ? ` (dir ${base.weather_wind_dir ?? '—'} → ${cur.weather_wind_dir ?? '—'})` : ''}`,
        });
      }
    }
  }

  // 5. Odds moves — only if odds_snapshots exists.
  try {
    // Load all odds rows for the date, take min/max per (player, book)…
    // simplification: compare first vs last snapshot_time per player.
    const { data, error } = await supabaseAdmin
      .from('odds_snapshots')
      .select('player_id, american_odds, snapshot_time')
      .eq('target_date', date)
      .order('snapshot_time', { ascending: true });
    if (error) {
      if (!/does not exist|schema cache/i.test(error.message)) {
        console.warn(`[captureChanges] odds fetch warning: ${error.message}`);
      }
    } else {
      const byPlayer = new Map<number, { first: number; last: number }>();
      for (const r of (data ?? []) as { player_id: number | null; american_odds: number }[]) {
        if (r.player_id == null) continue;
        const cur = byPlayer.get(r.player_id);
        if (!cur) byPlayer.set(r.player_id, { first: r.american_odds, last: r.american_odds });
        else cur.last = r.american_odds;
      }
      for (const [pid, o] of byPlayer) {
        const d = o.last - o.first;
        if (Math.abs(d) >= ODDS_DELTA_MIN) {
          changes.push({
            target_date: date, game_pk: null, player_id: pid,
            change_type: 'odds_move',
            from_value: o.first, to_value: o.last,
            delta_note: `${o.first > 0 ? '+' : ''}${o.first} → ${o.last > 0 ? '+' : ''}${o.last}`,
          });
        }
      }
    }
  } catch (e) {
    console.warn(`[captureChanges] odds fetch failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  // Dedupe: same (date, type, game_pk||player_id, to_value string) collapses.
  const seen = new Set<string>();
  const deduped = changes.filter((c) => {
    const key = `${c.change_type}|${c.game_pk ?? 'g?'}|${c.player_id ?? 'p?'}|${JSON.stringify(c.to_value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Insert.
  let written = 0;
  const byType: Record<string, number> = {};
  if (deduped.length > 0) {
    const rows = deduped.map((c) => ({ ...c, detected_at: new Date().toISOString() }));
    const { error, count } = await supabaseAdmin
      .from('snapshot_changes')
      .insert(rows, { count: 'exact' });
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        console.warn(`[captureChanges] snapshot_changes table missing — apply migration 016.`);
      } else {
        throw new Error(`snapshot_changes insert: ${error.message}`);
      }
    } else {
      written = count ?? rows.length;
      for (const c of deduped) byType[c.change_type] = (byType[c.change_type] ?? 0) + 1;
    }
  }

  console.log(`[captureChanges] ${date}: compared ${baseline.length} games, wrote ${written} change(s) ${Object.keys(byType).length ? `(${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`);

  return {
    date,
    games_compared: baseline.length,
    changes_written: written,
    changes_by_type: byType,
    baseline_missing: false,
    skipped,
  };
}

async function main() {
  const arg = process.argv[2] ?? mlbToday();
  const date = arg === 'today' ? mlbToday() : arg === 'yesterday' ? mlbAddDays(mlbToday(), -1) : arg;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${arg}. Use YYYY-MM-DD | today | yesterday.`);
  }
  const result = await captureChangesForDate(date);
  console.log('[captureChanges] result:', JSON.stringify(result, null, 2));
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    console.error('[captureChanges] FAILED:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
