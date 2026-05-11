/**
 * rebuildAllSummaries() — full recalculation of player_daily_summary from
 * the raw home_runs table.
 *
 * Use this when:
 *   - You suspect the cache is stale (the dashboard/player page won't be
 *     affected because they read from home_runs directly, but downstream
 *     consumers of player_daily_summary might).
 *   - You backfilled a long range and want to materialize per-day snapshots
 *     for every HR-date.
 *   - You changed the rebuild logic and want a clean recompute.
 *
 * Strategy:
 *   1. Find every distinct game_date that appears in home_runs.
 *   2. (Optional, default ON) wipe player_daily_summary entirely first.
 *   3. For each date, call rebuildPlayerSummaries(date), which writes one
 *      row per (player_id, date) for players who actually hit on that date.
 *
 * Idempotent: safe to re-run. If you DON'T pass `--no-wipe`, you get a
 * deterministic, from-scratch recompute.
 */
import { rebuildPlayerSummaries } from './rebuildPlayerSummaries.js';
import { supabaseAdmin } from './lib/supabaseAdmin.js';

export interface RebuildAllOptions {
  /** Wipe player_daily_summary before rebuilding. Default true. */
  wipe?: boolean;
  /** ms to sleep between dates so we don't slam the DB. Default 50. */
  delayMs?: number;
}

export interface RebuildAllResult {
  datesProcessed: number;
  rowsWritten: number;
  failures: { date: string; error: string }[];
}

const PAGE_SIZE = 1000;

async function listDistinctGameDates(): Promise<string[]> {
  // Supabase has no DISTINCT, so we page through and dedup in memory.
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('game_date')
      .order('game_date', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`list game_date failed: ${error.message}`);
    const rows = (data ?? []) as { game_date: string }[];
    for (const r of rows) seen.add(r.game_date);
    if (rows.length < PAGE_SIZE) break;
  }
  return Array.from(seen).sort();
}

async function wipeSummaries(): Promise<number> {
  // Supabase requires a filter on delete; .neq on a non-null column matches all rows.
  const { error, count } = await supabaseAdmin
    .from('player_daily_summary')
    .delete({ count: 'exact' })
    .neq('player_id', -1);
  if (error) throw new Error(`wipe player_daily_summary failed: ${error.message}`);
  return count ?? 0;
}

export async function rebuildAllSummaries(
  opts: RebuildAllOptions = {},
): Promise<RebuildAllResult> {
  const wipe = opts.wipe ?? true;
  const delayMs = opts.delayMs ?? 50;

  console.log(`[rebuildAllSummaries] starting (wipe=${wipe}, delayMs=${delayMs})`);

  const dates = await listDistinctGameDates();
  console.log(`[rebuildAllSummaries] found ${dates.length} distinct HR dates in home_runs`);

  if (wipe) {
    const removed = await wipeSummaries();
    console.log(`[rebuildAllSummaries] wiped ${removed} existing rows from player_daily_summary`);
  }

  const result: RebuildAllResult = {
    datesProcessed: 0,
    rowsWritten: 0,
    failures: [],
  };

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const tag = `[${i + 1}/${dates.length}] ${d}`;
    try {
      const r = await rebuildPlayerSummaries(d);
      result.datesProcessed++;
      result.rowsWritten += r.playersWritten;
      console.log(`${tag} → ${r.playersWritten} player rows`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ date: d, error: msg });
      console.error(`${tag} FAILED: ${msg}`);
    }
    if (i < dates.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log('[rebuildAllSummaries] DONE', {
    datesProcessed: result.datesProcessed,
    rowsWritten: result.rowsWritten,
    failures: result.failures.length,
  });
  return result;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
