/**
 * enrichProbablePitchers — fallback that fills `home/away_probable_pitcher_*`
 * on `games` rows where the schedule API didn't return one.
 *
 * Why this exists: `enrich:schedule` pulls from /v1/schedule with
 * hydrate=probablePitcher. For games announced very late, MLB returns
 * null. For *past* games the live feed has either:
 *   1. gameData.probablePitchers.{home,away}     (probable as of game time)
 *   2. liveData.boxscore.teams.{home,away}.pitchers[0]  (actual starter — most reliable for past games)
 * We try them in that order and update the games row.
 *
 * Handedness is resolved inline via /v1/people/{id} if not already known.
 *
 * Idempotent: only touches games where the relevant probable pitcher field
 * is currently NULL. Safe to interrupt and re-run.
 *
 * CLI flags (via runEnrichProbablePitchers.ts):
 *   --start YYYY-MM-DD   default: today - 7 days
 *   --end YYYY-MM-DD     default: today + 1 day
 *   --delay N            ms between API calls (default 250)
 *   --limit N            cap how many games to process this run
 *   --dry-run            no writes
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { getPersonRaw } from './lib/mlb.js';
import { withRetry } from './lib/retry.js';

export interface EnrichProbablePitchersOptions {
  start?: string;
  end?: string;
  delayMs?: number;
  limit?: number;
  dryRun?: boolean;
}

export interface EnrichProbablePitchersResult {
  start: string;
  end: string;
  gamesScanned: number;
  homeFilled: number;
  awayFilled: number;
  handsResolved: number;
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

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' ? u : null;
}

interface PitcherInfo {
  id: number | null;
  name: string | null;
  hand: string | null;
}

/**
 * Pull probable pitcher from a game live feed, trying the schedule-style
 * field first then falling back to the actual starter from the boxscore.
 */
function extractProbable(feed: any, side: 'home' | 'away'): PitcherInfo {
  // 1. gameData.probablePitchers.home/away — populated for most past games
  const pp = feed?.gameData?.probablePitchers?.[side];
  if (pp?.id) {
    return { id: Number(pp.id), name: pp?.fullName ?? null, hand: null };
  }
  // 2. liveData.boxscore.teams.{home,away}.pitchers[0] — actual starting pitcher
  const pitcherIds: number[] = feed?.liveData?.boxscore?.teams?.[side]?.pitchers ?? [];
  if (pitcherIds.length > 0) {
    const starterId = Number(pitcherIds[0]);
    // Look up the person's name in the boxscore players section
    const playerKey = `ID${starterId}`;
    const playerRow = feed?.liveData?.boxscore?.teams?.[side]?.players?.[playerKey];
    const name = playerRow?.person?.fullName ?? null;
    const hand = normHand(playerRow?.person?.pitchHand?.code);
    return { id: starterId, name, hand };
  }
  return { id: null, name: null, hand: null };
}

interface GameRowMin {
  game_pk: number;
  game_date: string;
  home_probable_pitcher_id: number | null;
  away_probable_pitcher_id: number | null;
  home_probable_pitcher_hand: string | null;
  away_probable_pitcher_hand: string | null;
}

const PAGE = 1000;

async function listMissingProbables(start: string, end: string): Promise<GameRowMin[]> {
  const out: GameRowMin[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('games')
      .select('game_pk, game_date, home_probable_pitcher_id, away_probable_pitcher_id, home_probable_pitcher_hand, away_probable_pitcher_hand')
      .gte('game_date', start)
      .lte('game_date', end)
      .or('home_probable_pitcher_id.is.null,away_probable_pitcher_id.is.null,home_probable_pitcher_hand.is.null,away_probable_pitcher_hand.is.null')
      .order('game_date', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list missing probables failed: ${error.message}`);
    const rows = (data ?? []) as GameRowMin[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Cache for /v1/people lookups during one run. */
async function resolveHand(id: number, kind: 'pitch', cache: Map<number, string | null>): Promise<string | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  try {
    const data = await withRetry(() => getPersonRaw(id));
    const code = data?.people?.[0]?.pitchHand?.code;
    const hand = normHand(code);
    cache.set(id, hand);
    return hand;
  } catch {
    cache.set(id, null);
    return null;
  }
}

export async function enrichProbablePitchers(opts: EnrichProbablePitchersOptions = {}): Promise<EnrichProbablePitchersResult> {
  const today = todayISO();
  const start = opts.start ?? addDays(today, -7);
  const end = opts.end ?? addDays(today, 1);
  const delayMs = opts.delayMs ?? 250;
  const dryRun = !!opts.dryRun;

  console.log(`[enrichProbablePitchers] scanning games ${start} → ${end}${dryRun ? ' (dry-run)' : ''}`);

  let candidates = await listMissingProbables(start, end);
  console.log(`[enrichProbablePitchers] ${candidates.length} games have at least one missing probable field`);

  if (typeof opts.limit === 'number' && opts.limit > 0 && opts.limit < candidates.length) {
    console.log(`[enrichProbablePitchers] --limit ${opts.limit} → first ${opts.limit}`);
    candidates = candidates.slice(0, opts.limit);
  }

  const result: EnrichProbablePitchersResult = {
    start,
    end,
    gamesScanned: candidates.length,
    homeFilled: 0,
    awayFilled: 0,
    handsResolved: 0,
    failures: [],
  };

  const handCache = new Map<number, string | null>();

  for (let i = 0; i < candidates.length; i++) {
    const g = candidates[i];
    try {
      const feed = await withRetry(() => fetchGameFeed(g.game_pk));
      const home = g.home_probable_pitcher_id == null
        ? extractProbable(feed, 'home')
        : { id: g.home_probable_pitcher_id, name: null, hand: g.home_probable_pitcher_hand };
      const away = g.away_probable_pitcher_id == null
        ? extractProbable(feed, 'away')
        : { id: g.away_probable_pitcher_id, name: null, hand: g.away_probable_pitcher_hand };

      // Resolve handedness when we have an id but no hand
      if (home.id != null && !home.hand) {
        home.hand = await resolveHand(home.id, 'pitch', handCache);
        if (home.hand) result.handsResolved++;
      }
      if (away.id != null && !away.hand) {
        away.hand = await resolveHand(away.id, 'pitch', handCache);
        if (away.hand) result.handsResolved++;
      }

      const updates: Record<string, unknown> = {};
      if (g.home_probable_pitcher_id == null && home.id != null) {
        updates.home_probable_pitcher_id = home.id;
        updates.home_probable_pitcher_name = home.name;
        result.homeFilled++;
      }
      if (g.away_probable_pitcher_id == null && away.id != null) {
        updates.away_probable_pitcher_id = away.id;
        updates.away_probable_pitcher_name = away.name;
        result.awayFilled++;
      }
      if (g.home_probable_pitcher_hand == null && home.hand) {
        updates.home_probable_pitcher_hand = home.hand;
      }
      if (g.away_probable_pitcher_hand == null && away.hand) {
        updates.away_probable_pitcher_hand = away.hand;
      }

      if (Object.keys(updates).length === 0) {
        if (i % 25 === 0) console.log(`  ${g.game_pk} (${g.game_date}) → nothing extractable`);
      } else if (dryRun) {
        if (i % 25 === 0) console.log(`  [dry-run] ${g.game_pk} (${g.game_date}) → would set:`, updates);
      } else {
        const { error: uErr } = await supabaseAdmin
          .from('games')
          .update(updates)
          .eq('game_pk', g.game_pk);
        if (uErr) throw new Error(`update games failed: ${uErr.message}`);
        if (i % 25 === 0) console.log(`  ${g.game_pk} (${g.game_date}) → set ${Object.keys(updates).join(', ')}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ game_pk: g.game_pk, error: msg });
      console.error(`  ${g.game_pk} FAILED: ${msg}`);
    }
    if (i < candidates.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log('[enrichProbablePitchers] DONE', {
    gamesScanned: result.gamesScanned,
    homeFilled: result.homeFilled,
    awayFilled: result.awayFilled,
    handsResolved: result.handsResolved,
    failures: result.failures.length,
  });
  return result;
}
