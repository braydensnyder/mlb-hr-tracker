/**
 * enrichLineups — fills home_lineup / away_lineup / lineups_confirmed on
 * `games` rows from the MLB live feed's batting orders (migration 012).
 *
 * Like weather, lineups only exist a few hours before first pitch, so we
 * re-run every cron tick: pending games get re-checked until their order
 * posts. Once a game is Final we stop re-fetching it (the order is moot).
 *
 * Idempotent + isolated: a per-game fetch failure is logged and skipped.
 *
 * Verbose logs (per the user's request) — surfaces:
 *   - lineups confirmed this run
 *   - games still pending (no order posted yet)
 *   - postponed / dead games
 *   - per-game fetch failures
 *
 * CLI flags (via runEnrichLineups.ts):
 *   --start YYYY-MM-DD   default: today
 *   --end YYYY-MM-DD     default: today + 1 day
 *   --delay N            ms between API calls (default 200)
 *   --limit N            cap games processed this run
 *   --dry-run            no writes
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { extractLineups, isDeadGameStatus } from './extractLineups.js';
import { withRetry } from './lib/retry.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

export interface EnrichLineupsOptions {
  start?: string;
  end?: string;
  delayMs?: number;
  limit?: number;
  dryRun?: boolean;
}

export interface EnrichLineupsResult {
  start: string;
  end: string;
  gamesScanned: number;
  lineupsConfirmed: number;
  stillPending: number;
  deadGames: number;
  failures: { game_pk: number; error: string }[];
}

const todayISO = mlbToday;
const addDays = mlbAddDays;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PAGE = 1000;

interface GameRowMin {
  game_pk: number;
  game_date: string;
  status: string;
  lineups_confirmed: boolean | null;
}

/** Games we still need to check: not final, and lineups not yet confirmed.
 *  Once confirmed OR final, we skip to save API calls. */
async function listGames(start: string, end: string): Promise<GameRowMin[]> {
  const out: GameRowMin[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('games')
      .select('game_pk, game_date, status, lineups_confirmed')
      .gte('game_date', start)
      .lte('game_date', end)
      .order('game_date', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list games failed: ${error.message}`);
    const rows = (data ?? []) as GameRowMin[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const FINAL_STATUSES = new Set(['Final', 'Game Over', 'Completed Early']);

export async function enrichLineups(opts: EnrichLineupsOptions = {}): Promise<EnrichLineupsResult> {
  const today = todayISO();
  const start = opts.start ?? today;
  const end = opts.end ?? addDays(today, 1);
  const delayMs = opts.delayMs ?? 200;
  const dryRun = !!opts.dryRun;

  console.log(`\n[enrichLineups] === START === window ${start} → ${end}${dryRun ? ' (dry-run)' : ''}`);

  let games = await listGames(start, end);
  // Skip games already final OR already confirmed — their lineup won't change.
  const before = games.length;
  games = games.filter((g) => !FINAL_STATUSES.has(g.status) && !g.lineups_confirmed);
  console.log(`[enrichLineups] ${before} games in window, ${games.length} need a lineup check (rest final/confirmed)`);

  if (typeof opts.limit === 'number' && opts.limit > 0 && opts.limit < games.length) {
    games = games.slice(0, opts.limit);
    console.log(`[enrichLineups] --limit ${opts.limit} applied`);
  }

  const result: EnrichLineupsResult = {
    start, end, gamesScanned: games.length,
    lineupsConfirmed: 0, stillPending: 0, deadGames: 0, failures: [],
  };

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    try {
      const feed = await withRetry(() => fetchGameFeed(g.game_pk));
      const lu = extractLineups(feed);
      if (!lu) { result.stillPending++; continue; }

      if (isDeadGameStatus(lu.status)) {
        result.deadGames++;
        console.log(`[enrichLineups]  ⊘ ${g.game_pk} (${g.game_date}) status="${lu.status}" → dead game, players will be hidden`);
      } else if (lu.lineups_confirmed) {
        result.lineupsConfirmed++;
        console.log(`[enrichLineups]  ✓ ${g.game_pk} (${g.game_date}) lineups CONFIRMED (${lu.home_lineup.length}+${lu.away_lineup.length} starters)`);
      } else {
        result.stillPending++;
        if (i % 10 === 0) console.log(`[enrichLineups]  … ${g.game_pk} (${g.game_date}) lineup pending (status="${lu.status}")`);
      }

      if (!dryRun) {
        const { error: uErr } = await supabaseAdmin
          .from('games')
          .update({
            home_lineup: lu.home_lineup,
            away_lineup: lu.away_lineup,
            lineups_confirmed: lu.lineups_confirmed,
            lineups_updated_at: new Date().toISOString(),
            // Keep status fresh too — postponed games flip here.
            status: lu.status ?? g.status,
          })
          .eq('game_pk', g.game_pk);
        if (uErr) throw new Error(`update failed: ${uErr.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ game_pk: g.game_pk, error: msg });
      console.error(`[enrichLineups]  ✗ ${g.game_pk} FAILED (non-fatal): ${msg}`);
    }
    if (i < games.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log('[enrichLineups] === DONE ===', {
    gamesScanned: result.gamesScanned,
    lineupsConfirmed: result.lineupsConfirmed,
    stillPending: result.stillPending,
    deadGames: result.deadGames,
    failures: result.failures.length,
  });
  return result;
}
