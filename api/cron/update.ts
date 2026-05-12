/**
 * api/cron/update — Vercel Cron entry point for the HR Tracker update
 * pipeline. The smoke test (api/cron/update.js) confirmed routing
 * works; this version layers back on the real logic:
 *
 *   1. Bearer-CRON_SECRET auth
 *   2. Required-env check (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 *   3. updateDaily() call — same pipeline as `npm run update:daily`
 *   4. JSON response with operator-friendly log summary
 *
 * GET (Vercel Cron) and POST (manual testing) both supported.
 *
 * Mode override — supply ?mode=morning or ?mode=night. Default "daily".
 *
 * Service-role secrets are server-only — never leaked to the frontend
 * bundle. vercel.json pins maxDuration=300 so the multi-minute update
 * fits inside one invocation (requires Vercel Pro).
 */
import { updateDaily, type UpdateMode } from '../../scripts/updateDaily.js';

// Inline shape that matches Vercel's Node-runtime request/response.
// Avoids depending on @vercel/node devDep — runtime objects satisfy
// these shapes naturally.
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

function isAuthorized(req: VercelReqLike): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // refuse rather than serve unguarded
  const raw = req.headers['authorization'] ?? req.headers['Authorization'];
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  return authHeader === `Bearer ${secret}`;
}

function parseMode(req: VercelReqLike): UpdateMode {
  const raw = req.query['mode'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'morning' || v === 'live' || v === 'night' || v === 'daily') return v;
  return 'daily';
}

export default async function handler(req: VercelReqLike, res: VercelResLike): Promise<void> {
  // Force JSON on every code path. Belt-and-suspenders so a thrown
  // error or CDN edge case can't accidentally serve HTML.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  // Vercel Cron uses GET. Manual testing typically uses POST. Both ok.
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

  const mode = parseMode(req);

  // Capture stdout so the response includes the operator-friendly log
  // phrases — easier than scrolling Vercel's function logs.
  const capturedLines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const captureLine = (level: 'log' | 'warn' | 'error', args: unknown[]): void => {
    const text = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    capturedLines.push(level === 'log' ? text : `[${level}] ${text}`);
  };
  console.log = (...args: unknown[]) => { captureLine('log', args); originalLog(...args); };
  console.warn = (...args: unknown[]) => { captureLine('warn', args); originalWarn(...args); };
  console.error = (...args: unknown[]) => { captureLine('error', args); originalError(...args); };

  try {
    const result = await updateDaily(mode);

    const greppable = capturedLines.filter((l) =>
      /active mode|created snapshot|snapshot overwritten|snapshot already exists, skipped|live mode — preserving|live preview updated|results processed|snapshot diagnostics/i.test(l),
    );

    res.status(200).json({
      ok: result.failures.length === 0,
      route: 'cron-update',
      mode: result.mode,
      message:
        result.failures.length === 0
          ? `update:${result.mode} completed cleanly`
          : `update:${result.mode} completed with ${result.failures.length} failure(s)`,
      today: result.today,
      yesterday: result.yesterday,
      scheduleWindow: result.scheduleWindow,
      durationMs: result.totalDurationMs,
      stepCount: result.steps.length,
      failureCount: result.failures.length,
      failures: result.failures,
      logSummary: greppable.slice(-50),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      route: 'cron-update',
      mode,
      error: msg,
      logSummary: capturedLines.slice(-30),
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}
