/**
 * enrichPitcherStarts — backfill the `pitcher_starts` table for games
 * that don't have any starter rows yet.
 *
 * For each candidate game_pk:
 *   1. Fetch the live feed (with retry)
 *   2. extractPitcherStarts(feed) — finds players with pitching.gamesStarted ≥ 1
 *   3. Upsert pitcher_starts rows
 *
 * Idempotent: a game is "candidate" only if NO pitcher_starts row exists
 * for it yet. Re-running is safe.
 *
 * CLI flags:
 *   --start YYYY-MM-DD   default: today - 30 days
 *   --end YYYY-MM-DD     default: today
 *   --delay N            ms between feed fetches (default 250)
 *   --limit N            cap games to process this run
 *   --dry-run            no writes
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { extractPitcherStarts } from './extractPitcherStarts.js';
import { withRetry } from './lib/retry.js';

export interface EnrichPitcherStartsOptions {
  start?: string;
  end?: string;
  delayMs?: number;
  limit?: number;
  dryRun?: boolean;
}

export interface EnrichPitcherStartsResult {
  start: string;
  end: string;
  candidateGames: number;
  gamesProcessed: number;
  startsInserted: number;
  failures: { game_pk: number; error: string }[];
}

const PAGE = 1000;

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(s: string, d: number): string {
  const [y, m, dd] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function listAllGamePksInRange(start: string, end: string): Promise<number[]> {
  const out: number[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('games')
      .select('game_pk')
      .gte('game_date', start)
      .lte('game_date', end)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list games failed: ${error.message}`);
    const rows = (data ?? []) as { game_pk: number }[];
    out.push(...rows.map((r) => r.game_pk));
    if (rows.length < PAGE) break;
  }
  return out;
}

async function listAlreadyHaveStarts(): Promise<Set<number>> {
  const seen = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('pitcher_starts')
      .select('game_id')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list pitcher_starts failed: ${error.message}`);
    const rows = (data ?? []) as { game_id: number }[];
    for (const r of rows) seen.add(r.game_id);
    if (rows.length < PAGE) break;
  }
  return seen;
}

export async function enrichPitcherStarts(opts: EnrichPitcherStartsOptions = {}): Promise<EnrichPitcherStartsResult> {
  const today = todayISO();
  const start = opts.start ?? addDays(today, -30);
  const end = opts.end ?? today;
  const delayMs = opts.delayMs ?? 250;
  const dryRun = !!opts.dryRun;

  console.log(`[enrichPitcherStarts] scanning games ${start} → ${end}${dryRun ? ' (dry-run)' : ''}`);

  const [allInRange, already] = await Promise.all([
    listAllGamePksInRange(start, end),
    listAlreadyHaveStarts(),
  ]);

  let pending = allInRange.filter((pk) => !already.has(pk));
  console.log(`[enrichPitcherStarts] ${allInRange.length} games in range; ${already.size} already have starter rows; ${pending.length} to process`);

  if (typeof opts.limit === 'number' && opts.limit > 0 && opts.limit < pending.length) {
    console.log(`[enrichPitcherStarts] --limit ${opts.limit} → first ${opts.limit}`);
    pending = pending.slice(0, opts.limit);
  }

  const result: EnrichPitcherStartsResult = {
    start,
    end,
    candidateGames: pending.length,
    gamesProcessed: 0,
    startsInserted: 0,
    failures: [],
  };

  for (let i = 0; i < pending.length; i++) {
    const gamePk = pending[i];
    try {
      const feed = await withRetry(() => fetchGameFeed(gamePk));
      const starts = extractPitcherStarts(feed);

      if (starts.length === 0) {
        if (i % 25 === 0) console.log(`  ${gamePk} → no starters in feed (not yet played?)`);
      } else if (dryRun) {
        if (i % 25 === 0) console.log(`  [dry-run] ${gamePk} → would insert ${starts.length} starter row(s)`);
        result.startsInserted += starts.length;
      } else {
        const { error: upErr } = await supabaseAdmin
          .from('pitcher_starts')
          .upsert(starts, { onConflict: 'game_id,pitcher_id' });
        if (upErr) throw new Error(`upsert failed: ${upErr.message}`);
        result.startsInserted += starts.length;
        if (i % 25 === 0) console.log(`  ${gamePk} → ${starts.length} starter(s) (HR allowed: ${starts.map((s) => s.home_runs_allowed).join('+')})`);
      }
      result.gamesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ game_pk: gamePk, error: msg });
      console.error(`  ${gamePk} FAILED: ${msg}`);
    }
    if (i < pending.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log('[enrichPitcherStarts] DONE', {
    candidateGames: result.candidateGames,
    gamesProcessed: result.gamesProcessed,
    startsInserted: result.startsInserted,
    failures: result.failures.length,
  });
  return result;
}
