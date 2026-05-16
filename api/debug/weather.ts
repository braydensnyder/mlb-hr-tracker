/**
 * /api/debug/weather — DB ground truth for weather columns.
 *
 * The user couldn't tell whether weather was missing in Supabase or just
 * hidden by the UI. This endpoint cuts through the ambiguity: it reads
 * `games` for a date and reports, per game and in aggregate, exactly
 * what's stored in the weather columns.
 *
 *   GET /api/debug/weather?date=2026-05-15
 *
 * Auth: requires the same Bearer CRON_SECRET as /api/cron/update so the
 * route isn't open to the public internet. The token is already configured
 * in the Vercel project for the cron, so the same `Authorization: Bearer
 * <CRON_SECRET>` header works for both.
 *
 * Response shape (compact, designed to skim in a terminal or browser):
 *   {
 *     ok: true, date, mlbToday, fetchedAt,
 *     totals: { games, withTemp, withWind, withCondition,
 *               withWeatherUpdatedAt, dome, pending },
 *     freshness: { latestWeatherUpdatedAt, oldestWeatherUpdatedAt },
 *     games: [
 *       { game_pk, away, home, status, weather_temp_f, weather_wind_mph,
 *         weather_wind_dir, weather_condition, weather_updated_at,
 *         classification: 'live' | 'dome' | 'pending' }
 *       ...
 *     ]
 *   }
 */
import { supabaseAdmin } from '../../scripts/lib/supabaseAdmin.js';
import { mlbToday, mlbDateContext, formatMlbDateContext } from '../../scripts/lib/mlbDate.js';

interface VercelReqLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}
interface VercelResLike {
  status(code: number): VercelResLike;
  setHeader(name: string, value: string): VercelResLike;
  json(body: unknown): VercelResLike;
  end(body?: string): VercelResLike;
}

const ROOF_RX = /roof closed|dome|indoor/i;

function isAuthorized(req: VercelReqLike): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const raw = req.headers['authorization'] ?? req.headers['Authorization'];
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  return authHeader === `Bearer ${secret}`;
}

function pickDate(req: VercelReqLike): string {
  const raw = req.query['date'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return mlbToday();
}

function classify(temp: number | null, wind: number | null, condition: string | null): 'live' | 'dome' | 'pending' {
  if (condition && ROOF_RX.test(condition)) return 'dome';
  if (temp == null && wind == null && !condition) return 'pending';
  return 'live';
}

export default async function handler(req: VercelReqLike, res: VercelResLike): Promise<void> {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method && req.method !== 'GET') {
    res.status(405).json({ ok: false, route: 'debug-weather', error: `Method ${req.method} not allowed — use GET` });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({
      ok: false,
      route: 'debug-weather',
      error: 'Unauthorized — send "Authorization: Bearer <CRON_SECRET>".',
    });
    return;
  }

  const date = pickDate(req);
  const dateContext = mlbDateContext();
  console.log(`[debug-weather] ${formatMlbDateContext(dateContext)} → date=${date}`);

  try {
    const { data, error } = await supabaseAdmin
      .from('games')
      .select(
        'game_pk, game_date, away_team, home_team, status, ' +
          'weather, weather_temp_f, weather_wind_mph, weather_wind_dir, weather_updated_at',
      )
      .eq('game_date', date)
      .order('game_pk', { ascending: true });

    if (error) {
      res.status(500).json({
        ok: false,
        route: 'debug-weather',
        date,
        error: error.message,
      });
      return;
    }

    type Row = {
      game_pk: number;
      game_date: string;
      away_team: string;
      home_team: string;
      status: string;
      weather: { condition?: string } | null;
      weather_temp_f: number | null;
      weather_wind_mph: number | null;
      weather_wind_dir: string | null;
      weather_updated_at: string | null;
    };
    const rows = (data ?? []) as unknown as Row[];

    const totals = {
      games: rows.length,
      withTemp: 0,
      withWind: 0,
      withCondition: 0,
      withWeatherUpdatedAt: 0,
      dome: 0,
      pending: 0,
      live: 0,
    };
    let latest: string | null = null;
    let oldest: string | null = null;

    const games = rows.map((g) => {
      const condition = g.weather?.condition ?? null;
      if (g.weather_temp_f != null) totals.withTemp++;
      if (g.weather_wind_mph != null) totals.withWind++;
      if (condition) totals.withCondition++;
      if (g.weather_updated_at) {
        totals.withWeatherUpdatedAt++;
        if (!latest || g.weather_updated_at > latest) latest = g.weather_updated_at;
        if (!oldest || g.weather_updated_at < oldest) oldest = g.weather_updated_at;
      }
      const classification = classify(g.weather_temp_f, g.weather_wind_mph, condition);
      if (classification === 'dome') totals.dome++;
      else if (classification === 'pending') totals.pending++;
      else totals.live++;
      return {
        game_pk: g.game_pk,
        away: g.away_team,
        home: g.home_team,
        status: g.status,
        weather_condition: condition,
        weather_temp_f: g.weather_temp_f,
        weather_wind_mph: g.weather_wind_mph,
        weather_wind_dir: g.weather_wind_dir,
        weather_updated_at: g.weather_updated_at,
        classification,
      };
    });

    res.status(200).json({
      ok: true,
      route: 'debug-weather',
      date,
      mlbToday: dateContext.mlbTargetDate,
      utcDate: dateContext.utcDate,
      ptDate: dateContext.ptDate,
      utcPtMismatch: dateContext.utcPtMismatch,
      fetchedAt: new Date().toISOString(),
      totals,
      freshness: {
        latestWeatherUpdatedAt: latest,
        oldestWeatherUpdatedAt: oldest,
      },
      games,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      route: 'debug-weather',
      date,
      error: msg,
    });
  }
}
