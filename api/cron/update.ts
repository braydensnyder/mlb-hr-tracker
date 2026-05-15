/**
 * api/cron/update — the SINGLE smart hourly cron endpoint.
 *
 * vercel.json fires this once an hour (`7 * * * *`). The endpoint then
 * decides — from the wall clock + the `cron_state` row — HOW MUCH work
 * to do, so one hourly cron stays cheap most of the time and only does
 * heavy rebuilds a few times a day:
 *
 *   - light  — hourly tick: ingest live/final HRs, refresh statuses +
 *              weather. No heavy enrichments / snapshots / summaries.
 *   - full   — every ~6h: wide schedule pull, all enrichments, summary
 *              rebuilds. First full of the UTC day = morning baseline
 *              (force-rebuilds today's snapshot).
 *   - night  — once/day post-games: finalize results + nightly snapshot.
 *
 * Safeguards:
 *   - Bearer CRON_SECRET auth.
 *   - Atomic DB lock (cron_state.running) prevents overlapping runs;
 *     a stale lock (>15 min) is auto-stolen.
 *   - updateDaily isolates every step — one failing API never fails
 *     the whole run.
 *
 * Manual override: ?mode=light|full|night|daily|morning|live runs that
 * mode directly (still takes the lock). Handy for testing.
 *
 * GET (Vercel Cron) and POST (manual curl) both supported.
 */
import { updateDaily, type UpdateMode } from '../../scripts/updateDaily.js';
import {
  acquireCronLock,
  releaseCronLock,
  readCronState,
  decideMode,
} from '../../scripts/lib/cronState.js';

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

export const config = {
  maxDuration: 300,
};

const VALID_MODES: UpdateMode[] = ['light', 'full', 'night', 'daily', 'morning', 'live'];

function isAuthorized(req: VercelReqLike): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const raw = req.headers['authorization'] ?? req.headers['Authorization'];
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  return authHeader === `Bearer ${secret}`;
}

/** Optional manual override — ?mode=... runs that mode directly. */
function parseModeOverride(req: VercelReqLike): UpdateMode | null {
  const raw = req.query['mode'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && (VALID_MODES as string[]).includes(v) ? (v as UpdateMode) : null;
}

export default async function handler(req: VercelReqLike, res: VercelResLike): Promise<void> {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method && req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, route: 'cron-update', error: `Method ${req.method} not allowed — use GET or POST` });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({
      ok: false,
      route: 'cron-update',
      error:
        'Unauthorized — send "Authorization: Bearer <CRON_SECRET>". ' +
        (process.env.CRON_SECRET
          ? 'Header missing or wrong value.'
          : 'CRON_SECRET is not set in this Vercel environment.'),
    });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({
      ok: false,
      route: 'cron-update',
      error:
        'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel env. ' +
        'Set both in Project → Settings → Environment Variables.',
    });
    return;
  }

  // ---- SAFEGUARD: prevent overlapping runs ----
  const gotLock = await acquireCronLock();
  if (!gotLock) {
    // Another run is in flight (and its lock is fresh). Skip cleanly —
    // do NOT release a lock we don't hold.
    res.status(200).json({
      ok: true,
      route: 'cron-update',
      mode: 'skipped-locked',
      message: 'Another cron run is in progress — skipped this tick to avoid overlap.',
    });
    return;
  }

  // Capture stdout so the response carries the operator-friendly log.
  const capturedLines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const captureLine = (level: 'log' | 'warn' | 'error', args: unknown[]): void => {
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    capturedLines.push(level === 'log' ? text : `[${level}] ${text}`);
  };
  console.log = (...args: unknown[]) => { captureLine('log', args); originalLog(...args); };
  console.warn = (...args: unknown[]) => { captureLine('warn', args); originalWarn(...args); };
  console.error = (...args: unknown[]) => { captureLine('error', args); originalError(...args); };

  // Decide the tier. A ?mode= override wins; otherwise decideMode()
  // picks light / full / night from the clock + cron_state.
  const override = parseModeOverride(req);
  let tier: UpdateMode;
  let forceSnapshot: boolean;
  let decisionReason: string;
  if (override) {
    tier = override;
    // Manual full → force the snapshot rebuild (operator intent).
    forceSnapshot = override === 'full' || override === 'morning' || override === 'night';
    decisionReason = `manual override ?mode=${override}`;
  } else {
    const state = await readCronState();
    const decision = decideMode(new Date(), state);
    tier = decision.tier;
    forceSnapshot = decision.forceSnapshot;
    decisionReason = decision.reason;
  }

  const heavyRan = tier === 'full' || tier === 'night' || tier === 'morning' || tier === 'daily';
  const nightRan = tier === 'night';

  try {
    console.log(`[cron] decided tier=${tier} (${decisionReason})`);
    const result = await updateDaily(tier, { forceSnapshot });

    const greppable = capturedLines.filter((l) =>
      /\[cron\]|decided tier|active mode|created snapshot|snapshot overwritten|snapshot already exists, skipped|no snapshot writes|live preview updated|results processed|live games checked|finals newly processed|home runs ingested|duplicates skipped|latest HR created_at|snapshot diagnostics/i.test(l),
    );

    const s = result.summary;
    res.status(200).json({
      ok: result.failures.length === 0,
      route: 'cron-update',
      mode: s.mode,
      decisionReason,
      forceSnapshot,
      message:
        result.failures.length === 0
          ? `update:${s.mode} completed cleanly`
          : `update:${s.mode} completed with ${result.failures.length} failure(s)`,
      today: result.today,
      yesterday: result.yesterday,
      scheduleWindow: result.scheduleWindow,
      durationMs: result.totalDurationMs,
      stepCount: result.steps.length,
      failureCount: result.failures.length,
      failures: result.failures,
      // The flat, dashboard-friendly metric block.
      gamesChecked: s.gamesChecked,
      liveGamesProcessed: s.liveGamesProcessed,
      finalGamesProcessed: s.finalGamesProcessed,
      HRsInserted: s.HRsInserted,
      duplicatesSkipped: s.duplicatesSkipped,
      weatherUpdated: s.weatherUpdated,
      summariesRebuilt: s.summariesRebuilt,
      snapshotsCreated: s.snapshotsCreated,
      snapshotsSkipped: s.snapshotsSkipped,
      lastUpdatedAt: s.lastUpdatedAt,
      actualResults: {
        today: summarizeProcess(result.actualResults.today),
        yesterday: summarizeProcess(result.actualResults.yesterday),
      },
      logSummary: greppable.slice(-60),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      route: 'cron-update',
      mode: tier,
      decisionReason,
      error: msg,
      logSummary: capturedLines.slice(-30),
    });
  } finally {
    // Always release the lock + record what ran, even if updateDaily threw.
    try {
      await releaseCronLock({
        tier: tier === 'morning' || tier === 'daily' ? 'full' : (tier === 'live' ? 'light' : tier as 'light' | 'full' | 'night'),
        heavyRan,
        nightRan,
      });
    } catch {
      /* non-fatal */
    }
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/** Compact processDate roll-up for the response JSON. */
function summarizeProcess(r: import('../../scripts/processDate.js').ProcessDateResult | null) {
  return r
    ? {
        date: r.date,
        totalGames: r.totalGames,
        liveGamesChecked: r.liveGamesChecked,
        finalGamesProcessed: r.finalGamesProcessed,
        alreadyProcessed: r.alreadyProcessed,
        pendingPregame: r.pendingPregame,
        homeRunsInserted: r.homeRunsInserted,
        duplicatesSkipped: r.duplicatesSkipped,
        pitcherStartsInserted: r.pitcherStartsInserted,
        latestHrCreatedAt: r.latestHrCreatedAt,
      }
    : null;
}
