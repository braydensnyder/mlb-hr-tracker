/**
 * api/cron/update — minimal smoke test.
 *
 * GOAL: prove Vercel is recognizing this file as a serverless function
 * and routing /api/cron/update to it (instead of falling through to the
 * SPA rewrite that returns index.html).
 *
 * Behavior: returns JSON { ok: true, route: "cron-update" } for any
 * GET request. No auth, no update pipeline, no env reads — anything
 * that could possibly fail the build is removed.
 *
 * After this is confirmed working via:
 *   curl -v https://mlb-hr-tracker.vercel.app/api/cron/update
 * (expected: HTTP/2 200, content-type: application/json) we layer the
 * Bearer-CRON_SECRET auth and the updateDaily() call back on top.
 */

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, route: 'cron-update', error: 'Use GET or POST' });
    return;
  }

  res.status(200).json({ ok: true, route: 'cron-update' });
}
