/**
 * extractWeather(gameFeed) — pull `gameData.weather` out of a
 * /v1.1/game/<pk>/feed/live response and normalize it.
 *
 * The MLB feed gives weather as:
 *   gameData.weather = {
 *     condition: "Partly Cloudy" | "Roof Closed" | "Dome" | ...,
 *     temp: "72",                       // °F, as a string
 *     wind: "8 mph, Out To CF" | "Calm, 0 mph" | "12 mph, In From LF"
 *   }
 *
 * Weather is only populated once MLB has it — typically a few hours
 * before first pitch. For games further out the block is absent or
 * empty; we return null and the caller skips gracefully.
 */

export interface WeatherInfo {
  /** Raw condition string from the feed, e.g. "Partly Cloudy", "Roof Closed". */
  condition: string | null;
  /** Temperature in °F. null when not reported. */
  temp_f: number | null;
  /** Wind speed in mph. 0 for "Calm". null when not reported. */
  wind_mph: number | null;
  /** Wind direction phrase, e.g. "Out To CF", "In From LF", "L To R", "Calm". */
  wind_dir: string | null;
  /** The raw weather object from the feed — stored as jsonb for future use. */
  raw: unknown;
}

/** Conditions that mean the game is played indoors / wind is a non-factor. */
const DOME_CONDITIONS = ['roof closed', 'dome', 'indoor'];

export function isDomeCondition(condition: string | null | undefined): boolean {
  if (!condition) return false;
  const c = condition.trim().toLowerCase();
  return DOME_CONDITIONS.some((d) => c.includes(d));
}

/**
 * Parse the MLB wind string. Examples seen in the feed:
 *   "8 mph, Out To CF"   → { mph: 8,  dir: "Out To CF" }
 *   "12 mph, In From LF" → { mph: 12, dir: "In From LF" }
 *   "Calm, 0 mph"        → { mph: 0,  dir: "Calm" }
 *   "5 mph, L To R"      → { mph: 5,  dir: "L To R" }
 *   ""                   → { mph: null, dir: null }
 */
export function parseWind(wind: string | null | undefined): { mph: number | null; dir: string | null } {
  if (!wind || typeof wind !== 'string') return { mph: null, dir: null };
  const s = wind.trim();
  if (!s) return { mph: null, dir: null };

  // "Calm, 0 mph" — special-case so dir reads "Calm" not "0 mph"
  if (/^calm/i.test(s)) return { mph: 0, dir: 'Calm' };

  // Pull the first number as the mph.
  const mphMatch = s.match(/(\d+(?:\.\d+)?)\s*mph/i);
  const mph = mphMatch ? Number(mphMatch[1]) : null;

  // The direction is everything that isn't the "N mph" token, comma-trimmed.
  let dir = s
    .replace(/\d+(?:\.\d+)?\s*mph/i, '')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  if (!dir) dir = null as unknown as string;

  return { mph: Number.isFinite(mph as number) ? mph : null, dir: dir || null };
}

export function extractWeather(gameFeed: any): WeatherInfo | null {
  const w = gameFeed?.gameData?.weather;
  if (!w || typeof w !== 'object') return null;

  const condition: string | null =
    typeof w.condition === 'string' && w.condition.trim() ? w.condition.trim() : null;

  const tempRaw = w.temp;
  const temp_f =
    tempRaw != null && tempRaw !== '' && Number.isFinite(Number(tempRaw))
      ? Number(tempRaw)
      : null;

  const { mph, dir } = parseWind(w.wind);

  // If literally nothing is present, treat as "no weather yet".
  if (condition == null && temp_f == null && mph == null) return null;

  return {
    condition,
    temp_f,
    wind_mph: mph,
    wind_dir: dir,
    raw: w,
  };
}
