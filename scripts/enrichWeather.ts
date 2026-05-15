/**
 * enrichWeather — fills the weather columns on `games` rows from the
 * MLB live feed's `gameData.weather` block.
 *
 * Columns populated (all added in migration 004):
 *   weather           jsonb       — the raw feed weather object
 *   weather_temp_f    numeric     — temperature °F
 *   weather_wind_mph  numeric     — wind speed mph (0 for Calm)
 *   weather_wind_dir  text        — wind direction phrase ("Out To CF", ...)
 *
 * Why the MLB feed and not an external weather API: the feed already
 * carries ballpark weather (MLB sources it for broadcast), it needs no
 * API key, and we're already fetching feeds elsewhere in the pipeline.
 * The tradeoff is that weather only appears a few hours before first
 * pitch — games further out simply have no weather block yet, and this
 * script skips them. It re-runs every cron tick so weather lands as
 * soon as MLB publishes it.
 *
 * Idempotent + safe:
 *   - Only scans games in the date window.
 *   - By default re-fetches games whose `weather_temp_f` is still NULL.
 *     Pass `refreshAll: true` to re-pull weather for every game (useful
 *     for in-progress games where conditions changed).
 *   - A per-game failure is logged and skipped; never throws out of the loop.
 *
 * CLI flags (via runEnrichWeather.ts):
 *   --start YYYY-MM-DD   default: today
 *   --end YYYY-MM-DD     default: today + 1 day
 *   --delay N            ms between API calls (default 200)
 *   --limit N            cap how many games to process this run
 *   --refresh-all        re-pull weather even when already set
 *   --dry-run            no writes
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { extractWeather } from './extractWeather.js';
import { withRetry } from './lib/retry.js';

export interface EnrichWeatherOptions {
  start?: string;
  end?: string;
  delayMs?: number;
  limit?: number;
  /** When true, re-fetch weather for every game in the window, not just
   *  those still missing it. */
  refreshAll?: boolean;
  dryRun?: boolean;
}

export interface EnrichWeatherResult {
  start: string;
  end: string;
  gamesScanned: number;
  weatherFilled: number;
  /** Games whose feed had no weather block yet (future games — skipped). */
  noWeatherYet: number;
  failures: { game_pk: number; error: string }[];
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface GameRowMin {
  game_pk: number;
  game_date: string;
  weather_temp_f: number | null;
}

const PAGE = 1000;

async function listGames(start: string, end: string, refreshAll: boolean): Promise<GameRowMin[]> {
  const out: GameRowMin[] = [];
  for (let page = 0; ; page++) {
    let q = supabaseAdmin
      .from('games')
      .select('game_pk, game_date, weather_temp_f')
      .gte('game_date', start)
      .lte('game_date', end)
      .order('game_date', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    // Default: only games still missing weather. refreshAll: every game.
    if (!refreshAll) q = q.is('weather_temp_f', null);
    const { data, error } = await q;
    if (error) throw new Error(`list games failed: ${error.message}`);
    const rows = (data ?? []) as GameRowMin[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function enrichWeather(opts: EnrichWeatherOptions = {}): Promise<EnrichWeatherResult> {
  const today = todayISO();
  const start = opts.start ?? today;
  const end = opts.end ?? addDays(today, 1);
  const delayMs = opts.delayMs ?? 200;
  const refreshAll = !!opts.refreshAll;
  const dryRun = !!opts.dryRun;

  console.log(
    `[enrichWeather] scanning games ${start} → ${end}` +
      `${refreshAll ? ' (refresh-all)' : ' (missing-only)'}${dryRun ? ' (dry-run)' : ''}`,
  );

  let candidates = await listGames(start, end, refreshAll);
  console.log(`[enrichWeather] ${candidates.length} game(s) to check`);

  if (typeof opts.limit === 'number' && opts.limit > 0 && opts.limit < candidates.length) {
    console.log(`[enrichWeather] --limit ${opts.limit} → first ${opts.limit}`);
    candidates = candidates.slice(0, opts.limit);
  }

  const result: EnrichWeatherResult = {
    start,
    end,
    gamesScanned: candidates.length,
    weatherFilled: 0,
    noWeatherYet: 0,
    failures: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const g = candidates[i];
    try {
      const feed = await withRetry(() => fetchGameFeed(g.game_pk));
      const weather = extractWeather(feed);

      if (!weather) {
        // No weather block in the feed yet — normal for games hours out.
        result.noWeatherYet++;
        if (i % 25 === 0) {
          console.log(`  ${g.game_pk} (${g.game_date}) → no weather block yet (skipped)`);
        }
      } else if (dryRun) {
        result.weatherFilled++;
        if (i % 25 === 0) {
          console.log(
            `  [dry-run] ${g.game_pk} (${g.game_date}) → ${weather.temp_f ?? '?'}°F, ` +
              `wind ${weather.wind_mph ?? '?'} ${weather.wind_dir ?? ''}`,
          );
        }
      } else {
        const { error: uErr } = await supabaseAdmin
          .from('games')
          .update({
            weather: weather.raw,
            weather_temp_f: weather.temp_f,
            weather_wind_mph: weather.wind_mph,
            weather_wind_dir: weather.wind_dir,
          })
          .eq('game_pk', g.game_pk);
        if (uErr) throw new Error(`update games failed: ${uErr.message}`);
        result.weatherFilled++;
        if (i % 25 === 0) {
          console.log(
            `  ${g.game_pk} (${g.game_date}) → ${weather.temp_f ?? '?'}°F, ` +
              `wind ${weather.wind_mph ?? '?'} mph ${weather.wind_dir ?? ''}`.trim(),
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ game_pk: g.game_pk, error: msg });
      console.error(`  ${g.game_pk} FAILED (non-fatal): ${msg}`);
    }
    if (i < candidates.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log('[enrichWeather] DONE', {
    gamesScanned: result.gamesScanned,
    weatherFilled: result.weatherFilled,
    noWeatherYet: result.noWeatherYet,
    failures: result.failures.length,
  });
  return result;
}
