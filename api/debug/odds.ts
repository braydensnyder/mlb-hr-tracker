/**
 * /api/debug/odds — read-only inspector for the odds-snapshot pipeline.
 *
 * Answers the six debug questions in one HTTP call so the operator can
 * triage without grepping Vercel logs:
 *
 *   1. Did the cron try to take a snapshot? → check `decision` in response
 *   2. Did ODDS_API_KEY load? → `env.ODDS_API_KEY_present` boolean
 *   3. Did the API return events? → call /api/debug/odds?probe_api=1
 *   4. Did rows get inserted? → `counts_by_type` per date
 *   5. Did the window logic skip? → `decision.reason`
 *   6. Are rows filtered out? → sample rows + unmatched player count
 *
 *   GET /api/debug/odds?date=YYYY-MM-DD
 *   GET /api/debug/odds?date=YYYY-MM-DD&probe_api=1   ← extra: ping The Odds API for event count
 *
 * Auth: same Bearer CRON_SECRET as /api/cron/update.
 */
import { supabaseAdmin } from '../../scripts/lib/supabaseAdmin.js';
import { mlbToday, mlbDateContext } from '../../scripts/lib/mlbDate.js';
import { decideOddsSnapshot } from '../../scripts/lib/oddsCron.js';
import { listMlbEvents } from '../../scripts/lib/oddsApi.js';

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

function isAuthorized(req: VercelReqLike): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const raw = req.headers['authorization'] ?? req.headers['Authorization'];
  const authHeader = Array.isArray(raw) ? raw[0] : raw;
  return authHeader === `Bearer ${secret}`;
}

function pickDate(req: VercelReqLike): string {
  const raw = req.query['date'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return mlbToday();
}

/** Build the same UTC bounds snapshotOdds uses so the probe matches the
 *  real fetch behavior exactly. Mirrors scripts/snapshotOdds.ts. */
function ptDayUtcBounds(date: string): { fromIso: string; toIso: string } {
  const dayStartPt = new Date(`${date}T00:00:00-07:00`);
  const dayEndPt = new Date(`${date}T23:59:59-07:00`);
  const fromIso = new Date(dayStartPt.getTime() - 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
  const toIso = new Date(dayEndPt.getTime() + 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
  return { fromIso, toIso };
}

export default async function handler(req: VercelReqLike, res: VercelResLike): Promise<void> {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method && req.method !== 'GET') {
    res.status(405).json({ ok: false, route: 'debug-odds', error: `Method ${req.method} not allowed — use GET` });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({
      ok: false,
      route: 'debug-odds',
      error: 'Unauthorized — send "Authorization: Bearer <CRON_SECRET>".',
    });
    return;
  }

  const date = pickDate(req);
  const now = new Date();
  const dateContext = mlbDateContext(now);

  // ---- ENV check ----
  const env = {
    ODDS_API_KEY_present: !!process.env.ODDS_API_KEY,
    SUPABASE_URL_present: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    CRON_SECRET_present: !!process.env.CRON_SECRET,
  };

  // ---- decideOddsSnapshot for "right now" — answers "would the cron fire?" ----
  let decision: Awaited<ReturnType<typeof decideOddsSnapshot>>;
  try {
    decision = await decideOddsSnapshot(now, date);
  } catch (err) {
    decision = { type: null, reason: `decideOddsSnapshot threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ---- DB counts for this date, per snapshot_type ----
  type CountByType = { snapshot_type: string; row_count: number };
  const countsByType: CountByType[] = [];
  for (const t of ['morning', 'midday', 'pregame', 'manual'] as const) {
    try {
      const { count, error } = await supabaseAdmin
        .from('odds_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('target_date', date)
        .eq('snapshot_type', t);
      if (error) {
        countsByType.push({ snapshot_type: t, row_count: -1 });
      } else {
        countsByType.push({ snapshot_type: t, row_count: count ?? 0 });
      }
    } catch {
      countsByType.push({ snapshot_type: t, row_count: -1 });
    }
  }

  // ---- Distinct books + sample of latest snapshot rows for this date ----
  let distinctBooks: string[] = [];
  let samplePlayers: Array<{ player_name: string; team: string | null; book: string; american_odds: number; implied_prob: number; snapshot_type: string }> = [];
  let latestSnapshotTime: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('odds_snapshots')
      .select('player_name, team, book, american_odds, implied_prob, snapshot_type, snapshot_time')
      .eq('target_date', date)
      .order('snapshot_time', { ascending: false })
      .limit(50);
    const rows = (data ?? []) as Array<{ player_name: string; team: string | null; book: string; american_odds: number; implied_prob: number; snapshot_type: string; snapshot_time: string }>;
    distinctBooks = Array.from(new Set(rows.map((r) => r.book)));
    samplePlayers = rows.slice(0, 10).map((r) => ({
      player_name: r.player_name,
      team: r.team,
      book: r.book,
      american_odds: r.american_odds,
      implied_prob: r.implied_prob,
      snapshot_type: r.snapshot_type,
    }));
    latestSnapshotTime = rows[0]?.snapshot_time ?? null;
  } catch {
    /* leave defaults */
  }

  // ---- Optional probe of The Odds API itself ----
  let apiProbe: { ok: boolean; events_returned: number; first_events?: string[]; error?: string } | null = null;
  const probeRequested = (Array.isArray(req.query['probe_api']) ? req.query['probe_api'][0] : req.query['probe_api']) === '1';
  if (probeRequested) {
    if (!env.ODDS_API_KEY_present) {
      apiProbe = { ok: false, events_returned: 0, error: 'ODDS_API_KEY not set' };
    } else {
      try {
        const { fromIso, toIso } = ptDayUtcBounds(date);
        const events = await listMlbEvents(fromIso, toIso);
        apiProbe = {
          ok: true,
          events_returned: events.length,
          first_events: events.slice(0, 5).map((e) => `${e.id} ${e.away_team} @ ${e.home_team}`),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        apiProbe = { ok: false, events_returned: 0, error: msg };
      }
    }
  }

  // ---- Total row count for the date (across all snapshot_types / books) ----
  let totalRows = 0;
  try {
    const { count } = await supabaseAdmin
      .from('odds_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('target_date', date);
    totalRows = count ?? 0;
  } catch {
    /* leave 0 */
  }

  res.status(200).json({
    ok: true,
    route: 'debug-odds',
    now: dateContext.cronStartedAt,
    target_date: date,
    pt_date: dateContext.ptDate,
    utc_date: dateContext.utcDate,
    pt_hour: new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' }).format(now),
    env,
    decision_now: decision,
    db: {
      total_rows_for_date: totalRows,
      counts_by_type: countsByType,
      distinct_books: distinctBooks,
      latest_snapshot_time: latestSnapshotTime,
      sample_first_10_rows: samplePlayers,
    },
    api_probe: apiProbe,
    hint: probeRequested
      ? null
      : 'Add ?probe_api=1 to make a live The Odds API call (costs 1 credit) to verify events are returned.',
    force_snapshot_url_example:
      'curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-domain>/api/cron/update?force_odds=morning" — bypasses window check, takes snapshot now.',
  });
}
