/**
 * enrichHandedness — backfill batter_side and pitcher_throws on existing
 * home_runs rows.
 *
 * For new HRs the extractor (extractHomeRuns.ts) already populates these
 * from the play feed. This script handles historical rows that predate
 * that change.
 *
 * Strategy:
 *   1. Find every distinct batter player_id whose home_runs rows have
 *      NULL batter_side. Fetch /v1/people/{id}, read batSide.code, and
 *      bulk-update those rows.
 *   2. Same for distinct pitcher_id with NULL pitcher_throws.
 *
 * Idempotent: only touches rows where the column is currently NULL.
 *
 * CLI flags (via runEnrichHandedness.ts):
 *   --delay N      ms between API calls (default 200)
 *   --limit N      cap how many *people* to look up this run (across both passes)
 *   --dry-run      report only, no writes
 *   --pitchers-only / --batters-only   skip the other pass
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { getPersonRaw } from './lib/mlb.js';
import { withRetry } from './lib/retry.js';

export interface EnrichHandednessOptions {
  delayMs?: number;
  limit?: number;
  dryRun?: boolean;
  pitchersOnly?: boolean;
  battersOnly?: boolean;
}

export interface EnrichHandednessResult {
  battersScanned: number;
  pitchersScanned: number;
  battersResolved: number;
  pitchersResolved: number;
  rowsUpdated: number;
  failures: { id: number; kind: 'bat' | 'pitch'; error: string }[];
}

const PAGE = 1000;

async function listDistinctIds(idCol: 'player_id' | 'pitcher_id', nullCol: 'batter_side' | 'pitcher_throws'): Promise<number[]> {
  const ids = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select(idCol)
      .is(nullCol, null)
      .not(idCol, 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list ${idCol} failed: ${error.message}`);
    const rows = (data ?? []) as Record<string, number>[];
    for (const r of rows) {
      const v = r[idCol];
      if (typeof v === 'number') ids.add(v);
    }
    if (rows.length < PAGE) break;
  }
  return Array.from(ids).sort((a, b) => a - b);
}

async function resolveHand(personId: number, kind: 'bat' | 'pitch'): Promise<string | null> {
  const data = await withRetry(() => getPersonRaw(personId));
  const person = data?.people?.[0];
  const code: string | undefined =
    kind === 'bat' ? person?.batSide?.code : person?.pitchHand?.code;
  if (!code) return null;
  const u = code.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}

async function applyBatterSide(playerId: number, side: string): Promise<number> {
  const { error, count } = await supabaseAdmin
    .from('home_runs')
    .update({ batter_side: side }, { count: 'exact' })
    .eq('player_id', playerId)
    .is('batter_side', null);
  if (error) throw new Error(`update batter_side failed for ${playerId}: ${error.message}`);
  return count ?? 0;
}

async function applyPitcherThrows(pitcherId: number, hand: string): Promise<number> {
  const { error, count } = await supabaseAdmin
    .from('home_runs')
    .update({ pitcher_throws: hand }, { count: 'exact' })
    .eq('pitcher_id', pitcherId)
    .is('pitcher_throws', null);
  if (error) throw new Error(`update pitcher_throws failed for ${pitcherId}: ${error.message}`);
  return count ?? 0;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function enrichHandedness(opts: EnrichHandednessOptions = {}): Promise<EnrichHandednessResult> {
  const delayMs = opts.delayMs ?? 200;
  const dryRun = !!opts.dryRun;
  const result: EnrichHandednessResult = {
    battersScanned: 0,
    pitchersScanned: 0,
    battersResolved: 0,
    pitchersResolved: 0,
    rowsUpdated: 0,
    failures: [],
  };

  const remaining = () => (typeof opts.limit === 'number' ? opts.limit - (result.battersScanned + result.pitchersScanned) : Infinity);

  // ---- batters ----
  if (!opts.pitchersOnly && remaining() > 0) {
    const batters = await listDistinctIds('player_id', 'batter_side');
    const slice = typeof opts.limit === 'number' ? batters.slice(0, Math.min(batters.length, remaining())) : batters;
    console.log(`[enrichHandedness] ${batters.length} batters need batter_side (processing ${slice.length})`);
    for (let i = 0; i < slice.length; i++) {
      const id = slice[i];
      result.battersScanned++;
      try {
        const side = await resolveHand(id, 'bat');
        if (!side) {
          if (i % 50 === 0) console.log(`  batter ${id} → no batSide`);
          continue;
        }
        if (dryRun) {
          if (i % 50 === 0) console.log(`  [dry-run] batter ${id} → would set ${side}`);
          result.battersResolved++;
          continue;
        }
        const n = await applyBatterSide(id, side);
        result.battersResolved++;
        result.rowsUpdated += n;
        if (i % 25 === 0) console.log(`  batter ${id} → ${side} (${n} rows)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failures.push({ id, kind: 'bat', error: msg });
        console.error(`  batter ${id} FAILED: ${msg}`);
      }
      if (i < slice.length - 1 && delayMs > 0) await sleep(delayMs);
    }
  }

  // ---- pitchers ----
  if (!opts.battersOnly && remaining() > 0) {
    const pitchers = await listDistinctIds('pitcher_id', 'pitcher_throws');
    const slice = typeof opts.limit === 'number' ? pitchers.slice(0, Math.min(pitchers.length, remaining())) : pitchers;
    console.log(`[enrichHandedness] ${pitchers.length} pitchers need pitcher_throws (processing ${slice.length})`);
    for (let i = 0; i < slice.length; i++) {
      const id = slice[i];
      result.pitchersScanned++;
      try {
        const hand = await resolveHand(id, 'pitch');
        if (!hand) {
          if (i % 50 === 0) console.log(`  pitcher ${id} → no pitchHand`);
          continue;
        }
        if (dryRun) {
          if (i % 50 === 0) console.log(`  [dry-run] pitcher ${id} → would set ${hand}`);
          result.pitchersResolved++;
          continue;
        }
        const n = await applyPitcherThrows(id, hand);
        result.pitchersResolved++;
        result.rowsUpdated += n;
        if (i % 25 === 0) console.log(`  pitcher ${id} → ${hand} (${n} rows)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failures.push({ id, kind: 'pitch', error: msg });
        console.error(`  pitcher ${id} FAILED: ${msg}`);
      }
      if (i < slice.length - 1 && delayMs > 0) await sleep(delayMs);
    }
  }

  console.log('[enrichHandedness] DONE', {
    battersScanned: result.battersScanned,
    pitchersScanned: result.pitchersScanned,
    battersResolved: result.battersResolved,
    pitchersResolved: result.pitchersResolved,
    rowsUpdated: result.rowsUpdated,
    failures: result.failures.length,
  });
  return result;
}
