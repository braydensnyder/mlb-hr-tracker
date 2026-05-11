/**
 * snapshotRange — generate HR target snapshots for every date in a range.
 *
 * Idempotent: each date is skipped if a snapshot already exists, unless
 * `--force` is passed to overwrite. Each individual call goes through the
 * same `snapshotHrTargets` path the live `update:daily` uses, so the math
 * is identical.
 *
 * Auto-tagging:
 *   - Past dates → snapshot_type = 'simulated'   (this is a backfill)
 *   - Future dates / today (pre-game) → 'live'   (clean pre-game snapshot)
 *   - Today after some games started → 'simulated' (informed by same-day results)
 *
 * Per-day failures are non-fatal — one bad date doesn't block the range.
 *
 * CLI flags (via runSnapshotRange.ts):
 *   --start YYYY-MM-DD   required
 *   --end   YYYY-MM-DD   required (inclusive)
 *   --force              overwrite existing snapshots in the range
 *   --limit N            top N rows per snapshot (default 50)
 *   --delay N            ms between dates (default 100ms — keeps DB load gentle)
 */
import { snapshotHrTargets, type SnapshotResult } from './snapshotHrTargets.js';

export interface SnapshotRangeOptions {
  start: string;
  end: string;
  force?: boolean;
  limit?: number;
  delayMs?: number;
}

export interface SnapshotRangeResult {
  start: string;
  end: string;
  datesAttempted: number;
  datesSucceeded: number;
  datesSkipped: number;
  rowsInsertedTotal: number;
  byType: { live: number; simulated: number };
  failures: { date: string; error: string }[];
}

function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function enumerateDates(start: string, end: string): string[] {
  if (start > end) throw new Error(`start (${start}) is after end (${end})`);
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export async function snapshotRange(opts: SnapshotRangeOptions): Promise<SnapshotRangeResult> {
  const start = opts.start;
  const end = opts.end;
  const force = !!opts.force;
  const limit = opts.limit;
  const delayMs = opts.delayMs ?? 100;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error(`--start needs YYYY-MM-DD`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end))   throw new Error(`--end needs YYYY-MM-DD`);

  const dates = enumerateDates(start, end);
  console.log(`[snapshotRange] ${dates.length} date(s) ${start} → ${end} (force=${force}, limit=${limit ?? 'default'})`);

  const result: SnapshotRangeResult = {
    start, end,
    datesAttempted: dates.length,
    datesSucceeded: 0,
    datesSkipped: 0,
    rowsInsertedTotal: 0,
    byType: { live: 0, simulated: 0 },
    failures: [],
  };

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const tag = `[${i + 1}/${dates.length}] ${d}`;
    try {
      const r: SnapshotResult = await snapshotHrTargets(d, { force, limit });
      if (r.skipped) {
        result.datesSkipped++;
        console.log(`${tag} skipped (existing snapshot; pass --force to overwrite)`);
      } else {
        result.datesSucceeded++;
        result.rowsInsertedTotal += r.inserted;
        if (r.snapshot_type === 'live') result.byType.live += r.inserted;
        else if (r.snapshot_type === 'simulated') result.byType.simulated += r.inserted;
        console.log(`${tag} → ${r.inserted} rows (type=${r.snapshot_type ?? 'unknown'})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ date: d, error: msg });
      console.error(`${tag} FAILED: ${msg}`);
    }
    if (i < dates.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log('[snapshotRange] DONE', {
    datesAttempted: result.datesAttempted,
    datesSucceeded: result.datesSucceeded,
    datesSkipped: result.datesSkipped,
    rowsInsertedTotal: result.rowsInsertedTotal,
    byType: result.byType,
    failures: result.failures.length,
  });
  return result;
}
