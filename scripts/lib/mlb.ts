/**
 * Tiny wrapper around the public MLB Stats API.
 * Docs (unofficial): https://statsapi.mlb.com/api/v1/
 */

const BASE = process.env.MLB_API_BASE ?? 'https://statsapi.mlb.com/api';

export class MlbApiError extends Error {
  status?: number;
  url?: string;
  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'MlbApiError';
    this.status = status;
    this.url = url;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'hr-tracker/0.1 (+https://github.com)' },
  });
  if (!res.ok) {
    throw new MlbApiError(`MLB API ${res.status} for ${url}`, res.status, url);
  }
  return (await res.json()) as T;
}

/** /v1/schedule for a single date.
 *
 * `hydrate=probablePitcher(note)` — returns the probable pitcher object inline
 *   on each `teams.{home,away}.probablePitcher`. The `(note)` modifier asks
 *   MLB to include extra context AND, importantly, makes the field show up
 *   reliably across all gameTypes (regular season, exhibition, playoff).
 * `hydrate=team`        — fills team info even when the response would
 *                         otherwise short-circuit it.
 * `hydrate=venue`       — venue name + id.
 * `hydrate=linescore`   — sometimes nudges MLB to return more game metadata.
 */
export function getScheduleRaw(date: string) {
  return getJson<any>(
    `/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note),team,venue,linescore`,
  );
}

/** /v1.1/game/<pk>/feed/live — full play-by-play feed for a game. */
export function getGameFeedRaw(gamePk: number) {
  return getJson<any>(`/v1.1/game/${gamePk}/feed/live`);
}

/** /v1/people/{id} — used by enrich:handedness to fill batSide / pitchHand. */
export function getPersonRaw(personId: number) {
  return getJson<any>(`/v1/people/${personId}`);
}
