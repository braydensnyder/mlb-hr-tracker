/**
 * oddsApi — thin client for The Odds API (https://the-odds-api.com).
 *
 * We use exactly TWO endpoints for Phase 1:
 *   1. GET /v4/sports/baseball_mlb/events
 *        — list event_ids on a date window. 1 credit per call.
 *   2. GET /v4/sports/baseball_mlb/events/{eventId}/odds
 *        — per-event HR-prop odds for all books in regions=us.
 *        — 1 credit per event call.
 *
 * That means one full snapshot ≈ 1 + (games today) credits. With 15
 * games and 3 snapshots/day, that's ~48 credits/day. The free tier
 * grants 500 credits/month (~16 days). Plan accordingly or upgrade.
 *
 * Auth: ODDS_API_KEY env var.
 *
 * Market keys:
 *   - 'batter_home_runs' — Yes/No (or Over/Under 0.5) "will player X
 *     hit ≥1 HR in this game". This is the prop we care about.
 *
 * Player matching: the API returns `outcomes[].description` with the
 * full player name. We normalize and let the caller match against the
 * `players` catalog. When no match exists we still store the row with
 * player_id=null so we can fix matching later without re-fetching.
 */

const BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'baseball_mlb';
const HR_MARKET = 'batter_home_runs';

export interface OddsApiError {
  status: number;
  message: string;
  /** True when the response signaled "out of quota" — caller may want to
   *  back off / log differently. */
  outOfQuota: boolean;
}

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;       // ISO timestamp (UTC)
  home_team: string;
  away_team: string;
}

export interface OddsApiOutcome {
  /** "Yes" / "No" (DK) or "Over" / "Under" (FanDuel). We treat both
   *  "Yes" and "Over" as the "to-homer" leg. */
  name: string;
  /** Player full name. */
  description?: string;
  /** American odds when oddsFormat=american. */
  price: number;
  /** Point — typically 0.5 for HR yes/no. */
  point?: number;
}

export interface OddsApiBookmaker {
  key: string;       // 'draftkings' | 'fanduel' | ...
  title: string;     // 'DraftKings' | ...
  last_update: string;
  markets: { key: string; outcomes: OddsApiOutcome[] }[];
}

export interface OddsApiEventOdds {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

export interface OddsApiClientOptions {
  /** Override the API key — defaults to process.env.ODDS_API_KEY. */
  apiKey?: string;
  /** Comma-separated book keys. Pass undefined for all US books. */
  bookmakers?: string[];
  /** Regions; default 'us'. */
  regions?: 'us' | 'us2' | 'uk' | 'eu' | 'au';
}

function requireApiKey(opts: OddsApiClientOptions): string {
  const key = opts.apiKey ?? process.env.ODDS_API_KEY;
  if (!key) {
    throw new Error(
      'ODDS_API_KEY is not set. Add it to your local .env and to Vercel ' +
        '(Project → Settings → Environment Variables) before running odds snapshots.',
    );
  }
  return key;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    const outOfQuota = /quota|usage limit|exceeded/i.test(body);
    const err: OddsApiError = {
      status: res.status,
      message: body || `HTTP ${res.status}`,
      outOfQuota,
    };
    throw err;
  }
  return (await res.json()) as T;
}

/** List MLB events whose commence_time falls in [fromIso, toIso] (inclusive). */
export async function listMlbEvents(
  fromIso: string,
  toIso: string,
  opts: OddsApiClientOptions = {},
): Promise<OddsApiEvent[]> {
  const key = requireApiKey(opts);
  const url =
    `${BASE}/sports/${SPORT}/events` +
    `?apiKey=${encodeURIComponent(key)}` +
    `&commenceTimeFrom=${encodeURIComponent(fromIso)}` +
    `&commenceTimeTo=${encodeURIComponent(toIso)}`;
  return get<OddsApiEvent[]>(url);
}

/** Fetch HR-prop odds for one event across the requested books / region. */
export async function fetchEventHrOdds(
  eventId: string,
  opts: OddsApiClientOptions = {},
): Promise<OddsApiEventOdds> {
  const key = requireApiKey(opts);
  const region = opts.regions ?? 'us';
  let url =
    `${BASE}/sports/${SPORT}/events/${encodeURIComponent(eventId)}/odds` +
    `?apiKey=${encodeURIComponent(key)}` +
    `&regions=${encodeURIComponent(region)}` +
    `&markets=${encodeURIComponent(HR_MARKET)}` +
    `&oddsFormat=american`;
  if (opts.bookmakers && opts.bookmakers.length > 0) {
    url += `&bookmakers=${encodeURIComponent(opts.bookmakers.join(','))}`;
  }
  return get<OddsApiEventOdds>(url);
}

/**
 * Flatten an event's odds payload into one row per (book, player) for
 * the "to homer" leg (Yes / Over @ 0.5). Discards Unders / Nos.
 */
export interface FlatOddsRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  book: string;          // bookmaker key, lowercase
  book_title: string;
  player_name: string;
  american_odds: number;
  last_update: string;
}

export function flattenEventOdds(evt: OddsApiEventOdds): FlatOddsRow[] {
  const out: FlatOddsRow[] = [];
  for (const bm of evt.bookmakers ?? []) {
    for (const m of bm.markets ?? []) {
      if (m.key !== HR_MARKET) continue;
      for (const o of m.outcomes ?? []) {
        const isYesLeg = /^(yes|over)$/i.test(o.name ?? '');
        if (!isYesLeg) continue;
        const playerName = (o.description ?? '').trim();
        if (!playerName) continue;
        if (!Number.isFinite(o.price)) continue;
        out.push({
          event_id: evt.id,
          commence_time: evt.commence_time,
          home_team: evt.home_team,
          away_team: evt.away_team,
          book: bm.key,
          book_title: bm.title,
          player_name: playerName,
          american_odds: Math.trunc(o.price),
          last_update: bm.last_update,
        });
      }
    }
  }
  return out;
}
