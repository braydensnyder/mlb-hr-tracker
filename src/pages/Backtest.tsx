/**
 * /backtest — "Did yesterday's HR target ranking actually hit?"
 *
 * For the selected date, load:
 *   1. The persisted snapshot from `hr_target_snapshots` (the ranking that
 *      was made before games started).
 *   2. Every HR in `home_runs` for that date.
 *
 * Join in memory: each snapshot row is a hit ✓ if the player has ≥1 HR
 * row on that date, else a miss ✗. Compute hit rate for Top 3 / 5 / 10.
 *
 * Mobile responsive — uses the same `.table-wrap` and KPI patterns as the
 * rest of the app. No new styling.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, fetchDataLastUpdated, type HomeRunRow, type HrTargetSnapshotRow } from '../lib/supabase';
import { mlbToday, addDays } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import {
  computeBacktestPerformance,
  computeMissAnalysis,
  type BacktestPerformance,
  type MissRow,
} from '../lib/stats';

// Pacific calendar date — see src/lib/mlbDate.ts.
const todayISO = mlbToday;

async function fetchSnapshot(targetDate: string): Promise<HrTargetSnapshotRow[]> {
  const { data, error } = await supabase
    .from('hr_target_snapshots')
    .select('*')
    .eq('target_date', targetDate)
    .order('rank', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as HrTargetSnapshotRow[];
}

async function fetchHrsOn(date: string): Promise<HomeRunRow[]> {
  const { data, error } = await supabase
    .from('home_runs')
    .select('*')
    .eq('game_date', date);
  if (error) throw new Error(error.message);
  return (data ?? []) as HomeRunRow[];
}

interface ResolvedRow extends HrTargetSnapshotRow {
  hit: boolean;
  hrs_today: number;
}

function hitRate(rows: ResolvedRow[], cutoff: number) {
  const slice = rows.slice(0, cutoff);
  const hits = slice.filter((r) => r.hit).length;
  return { hits, total: slice.length };
}

export default function Backtest() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialDate = searchParams.get('date') ?? addDays(todayISO(), -1);
  const [date, setDateState] = useState<string>(initialDate);

  const [snapshot, setSnapshot] = useState<HrTargetSnapshotRow[]>([]);
  const [hrs, setHrs] = useState<HomeRunRow[]>([]);
  const [dataLastUpdated, setDataLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setDate(d: string) {
    setDateState(d);
    const next = new URLSearchParams(searchParams);
    next.set('date', d);
    setSearchParams(next, { replace: true });
  }

  // Auto-revalidation key — bumps on tab-visible + hourly.
  const refreshKey = useRevalidationKey();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchSnapshot(date), fetchHrsOn(date), fetchDataLastUpdated()])
      .then(([s, h, lu]) => {
        if (cancelled) return;
        setSnapshot(s);
        setHrs(h);
        setDataLastUpdated(lu);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, refreshKey]);

  // ---- join snapshot rows with HRs for the date ----
  const resolved: ResolvedRow[] = useMemo(() => {
    const hrsByPlayer = new Map<number, number>();
    for (const h of hrs) {
      hrsByPlayer.set(h.player_id, (hrsByPlayer.get(h.player_id) ?? 0) + 1);
    }
    return snapshot.map((s) => {
      const n = hrsByPlayer.get(s.player_id) ?? 0;
      return { ...s, hit: n > 0, hrs_today: n };
    });
  }, [snapshot, hrs]);

  const rate3 = hitRate(resolved, 3);
  const rate5 = hitRate(resolved, 5);
  const rate10 = hitRate(resolved, 10);

  // ---- Task #166: hit-rate buckets w/ random baseline + lift ----
  // We compute the buckets here rather than memoizing because both
  // inputs (snapshot, hrs) already trigger a re-render when they change.
  const performance: BacktestPerformance | null = useMemo(() => {
    if (snapshot.length === 0) return null;
    return computeBacktestPerformance(
      date,
      snapshot.map((s) => ({ rank: s.rank, player_id: s.player_id, player_name: s.player_name })),
      hrs.map((h) => ({ player_id: h.player_id, player_name: h.player_name })),
      [10, 25, 50],
    );
  }, [snapshot, hrs, date]);

  // ---- Task #166: miss analysis — homered, ranked > 50 (or unranked) ----
  // Phase 1 passes an empty liveTargets array — the miss row carries the
  // snapshot rank + player name only. Phase 2 will recompute live HrTargets
  // for the date to fill in weather / pitcher / park signals per miss.
  const misses: MissRow[] = useMemo(() => {
    if (snapshot.length === 0 || hrs.length === 0) return [];
    return computeMissAnalysis(
      hrs.map((h) => ({ player_id: h.player_id, player_name: h.player_name })),
      snapshot.map((s) => ({ rank: s.rank, player_id: s.player_id, player_name: s.player_name })),
      [],
      { cutoff: 50 },
    );
  }, [snapshot, hrs]);

  const today = todayISO();
  const yesterday = addDays(today, -1);

  return (
    <>
      <div className="kpi-strip" style={{ marginBottom: 12 }}>
        <Kpi label="Date" value={date} />
        <Kpi label="Targets snapshot" value={snapshot.length} />
        <Kpi label="HRs on date" value={hrs.length} />
        <Kpi label="Top 10 hits" value={`${rate10.hits} / ${rate10.total}`} />
      </div>

      <TimestampPanel
        snapshotGeneratedAt={snapshot[0]?.snapshot_date ?? null}
        snapshotType={snapshot[0]?.snapshot_type}
        dataLastUpdated={dataLastUpdated}
      />

      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-presets" style={{ alignSelf: 'flex-start' }}>
          <button type="button" onClick={() => setDate(yesterday)} aria-pressed={date === yesterday}>Yesterday</button>
          <button type="button" onClick={() => setDate(today)} aria-pressed={date === today}>Today</button>
        </div>
        <label>
          <span>Custom date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <Link to="/targets" style={{ alignSelf: 'end', marginLeft: 'auto', fontSize: 13 }}>HR Targets →</Link>
      </div>

      <div
        className="panel"
        style={{ marginBottom: 16, background: 'var(--panel-2)', borderColor: 'var(--accent)' }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--accent-2)' }}>Backtest — Saved Snapshot only.</strong>{' '}
          This page reads exclusively from the persisted{' '}
          <code>hr_target_snapshots</code> table for <strong>{date}</strong> —{' '}
          <em>never</em> Live Preview. The ranking shown was locked in at
          snapshot time, then joined against <code>home_runs</code> for that
          same date to compute hit rates. ✓ means the player hit ≥1 HR; ✗ means they did not.
          {snapshot.length > 0 && snapshot[0].snapshot_date && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span>
                <strong style={{ color: 'var(--good)' }}>Snapshot generated at:</strong>{' '}
                <span style={{ color: 'var(--text)' }}>
                  {new Date(snapshot[0].snapshot_date).toLocaleString()}
                </span>{' '}
                <span className="subtle">(target_date {date})</span>
              </span>
              <SnapshotTypeBadge type={snapshot[0].snapshot_type} />
            </div>
          )}
          <div style={{ marginTop: 6 }} className="subtle" >
            Snapshots are generated automatically by <code>update:daily</code> (today
            + tomorrow, skip-if-exists) and manually by{' '}
            <code>npm run snapshot:targets -- {date} --force</code>. Past dates that
            were never snapshotted will be empty here.
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading backtest for {date}…</div>}

      {/* Hit-rate KPIs */}
      <div className="kpi-strip" style={{ marginBottom: 16 }}>
        <HitRateCell label="Top 3" hits={rate3.hits} total={rate3.total} />
        <HitRateCell label="Top 5" hits={rate5.hits} total={rate5.total} />
        <HitRateCell label="Top 10" hits={rate10.hits} total={rate10.total} />
        <HitRateCell label="All" hits={resolved.filter((r) => r.hit).length} total={resolved.length} />
      </div>

      {/* ---- Task #166: Daily performance — lift vs random ---- */}
      {performance && (
        <PerformancePanel perf={performance} />
      )}

      {/* ---- Task #166: Miss analysis — players who homered outside Top 50 ---- */}
      {misses.length > 0 && (
        <MissPanel misses={misses} cutoff={50} />
      )}

      {!loading && snapshot.length === 0 && !error && (
        <div className="panel">
          <h2>No snapshot for {date}</h2>
          <p className="subtle">
            No persisted HR Targets snapshot exists for this date. To generate one
            (for past dates, this approximates what the model would have said using
            data on file as of {addDays(date, -1)}):
          </p>
          <pre style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 8, fontSize: 12, overflowX: 'auto' }}>
            npm run snapshot:targets -- {date}
          </pre>
        </div>
      )}

      {resolved.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              Top 10 HR Targets — {date}
              <SnapshotTypeBadge type={resolved[0]?.snapshot_type} />
            </h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              Sorted by rank (as recorded in the snapshot)
            </span>
          </div>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Game</th>
                  <th className="num">Heat</th>
                  <th>Result</th>
                  <th className="num">HRs</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {resolved.slice(0, 10).map((r) => (
                  <tr
                    key={`${r.player_id}-${r.game_pk}`}
                    style={{ background: r.hit ? 'rgba(74, 222, 128, 0.08)' : undefined }}
                  >
                    <td className="num">{r.rank}</td>
                    <td>
                      <Link
                        className="player-link"
                        to={`/player/${r.player_id}?asOf=${date}`}
                      >
                        {r.player_name}
                      </Link>
                    </td>
                    <td><span className="pill">{r.team}</span></td>
                    <td className="subtle" style={{ fontSize: 12 }}>vs {r.opponent}</td>
                    <td className="num">{Number(r.heat_score).toFixed(1)}</td>
                    <td>
                      {r.hit ? (
                        <span style={{ color: 'var(--good)', fontWeight: 700 }}>✓ HR</span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>✗ —</span>
                      )}
                    </td>
                    <td className="num">{r.hrs_today}</td>
                    <td className="subtle" style={{ fontSize: 12 }}>{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {resolved.length > 10 && (
        <div className="panel">
          <h2>Ranks 11 — {resolved.length}</h2>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Game</th>
                  <th className="num">Heat</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {resolved.slice(10).map((r) => (
                  <tr key={`${r.player_id}-${r.game_pk}`}>
                    <td className="num">{r.rank}</td>
                    <td>
                      <Link
                        className="player-link"
                        to={`/player/${r.player_id}?asOf=${date}`}
                      >
                        {r.player_name}
                      </Link>
                    </td>
                    <td><span className="pill">{r.team}</span></td>
                    <td className="subtle" style={{ fontSize: 12 }}>vs {r.opponent}</td>
                    <td className="num">{Number(r.heat_score).toFixed(1)}</td>
                    <td>
                      {r.hit ? (
                        <span style={{ color: 'var(--good)' }}>✓</span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>✗</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

function SnapshotTypeBadge({ type }: { type: 'live' | 'simulated' | 'live-preview' | undefined }) {
  if (!type) return null;
  // Three discrete states the user requested:
  //   'live'         → DB snapshot_type='live'      → "Pre-game"
  //   'simulated'    → DB snapshot_type='simulated' → "Simulated historical"
  //   'live-preview' → no saved snapshot in DB      → "Live preview"
  const config = {
    'live':         { label: '● Pre-game',              color: 'var(--good)',    bg: 'rgba(74, 222, 128, 0.15)', tip: 'Honest pre-game snapshot — taken before first pitch on target_date.' },
    'simulated':    { label: '○ Simulated historical', color: 'var(--accent)',  bg: 'rgba(255, 122, 24, 0.15)', tip: 'Simulated historical backfill — approximates what the model would have said using data ≤ target_date - 1.' },
    'live-preview': { label: '◇ Live preview',          color: 'var(--muted)',   bg: 'rgba(133, 147, 184, 0.15)', tip: 'Live model output — not saved. May change as data updates.' },
  }[type];
  return (
    <span
      title={config.tip}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        background: config.bg,
        color: config.color,
        border: `1px solid ${config.color}`,
      }}
    >
      {config.label}
    </span>
  );
}

function TimestampPanel({
  snapshotGeneratedAt,
  snapshotType,
  dataLastUpdated,
}: {
  snapshotGeneratedAt: string | null;
  snapshotType: 'live' | 'simulated' | 'live-preview' | undefined;
  dataLastUpdated: string | null;
}) {
  const fmt = (s: string | null) =>
    s ? new Date(s).toLocaleString() : <span className="subtle">—</span>;
  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        padding: 10,
        marginBottom: 12,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <div title="When the persisted Top-N snapshot for this date was written to hr_target_snapshots. Backtest reads exclusively from this row — never a live recompute.">
        <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Saved Snapshot generated at
        </div>
        <div style={{ marginTop: 2 }}>{fmt(snapshotGeneratedAt)}</div>
      </div>
      <div title="Honest pre-game snapshot ('live') or historical backfill ('simulated').">
        <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Snapshot type
        </div>
        <div style={{ marginTop: 2 }}>
          {snapshotType ? <SnapshotTypeBadge type={snapshotType} /> : <span className="subtle">—</span>}
        </div>
      </div>
      <div title="Most recent home_runs.created_at — when the data layer last received a HR row.">
        <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Data last updated at
        </div>
        <div style={{ marginTop: 2 }}>{fmt(dataLastUpdated)}</div>
      </div>
    </div>
  );
}

function HitRateCell({ label, hits, total }: { label: string; hits: number; total: number }) {
  const pct = total > 0 ? Math.round((hits / total) * 100) : 0;
  return (
    <div className="kpi" style={{ background: hits > 0 && total > 0 ? 'var(--panel-2)' : undefined }}>
      <div className="kpi-label">{label} hit rate</div>
      <div className="kpi-value">
        {hits} / {total}
        {total > 0 && (
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}>
            ({pct}%)
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Task #166: Daily performance — Top N hit-rate + random lift
// ============================================================
function PerformancePanel({ perf }: { perf: BacktestPerformance }) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>
        Model performance — Top 10 / 25 / 50 vs random baseline
      </h2>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 12 }}>
        Base rate: <strong>{perf.hr_hitters_total}</strong> distinct HR-hitters
        out of <strong>{perf.random_denominator}</strong> ranked players today
        ={' '}
        <strong>{(perf.random_base_rate * 100).toFixed(1)}%</strong>. Total HRs:{' '}
        <strong>{perf.total_hrs}</strong>. Random baseline = the chance that a
        randomly picked player from the model's ranked pool would have homered.
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cutoff</th>
              <th className="num">Hits</th>
              <th className="num">Hit rate</th>
              <th className="num">Expected (random)</th>
              <th className="num">Lift vs random</th>
            </tr>
          </thead>
          <tbody>
            {perf.buckets.map((b) => {
              const liftPct = b.lift_vs_random != null ? b.lift_vs_random * 100 : null;
              const liftColor =
                liftPct == null
                  ? 'var(--muted)'
                  : liftPct > 0
                  ? 'var(--good, #4cd97a)'
                  : liftPct < 0
                  ? '#ff8d8d'
                  : 'var(--muted)';
              return (
                <tr key={b.topN}>
                  <td><strong>Top {b.topN}</strong></td>
                  <td className="num">{b.hits} / {b.ranked}</td>
                  <td className="num">{(b.hit_rate * 100).toFixed(1)}%</td>
                  <td className="num subtle">{b.expected_random_hits.toFixed(1)}</td>
                  <td className="num" style={{ color: liftColor, fontWeight: 600 }}>
                    {liftPct == null
                      ? '—'
                      : `${liftPct > 0 ? '+' : ''}${liftPct.toFixed(0)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="subtle" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
        Read: lift +80% means the model's Top-N had 80% more HR-hitters than a
        random pick from the same pool would have produced. Negative lift = the
        model is worse than random for that cutoff on this date. One day is noise
        — look at the trend across many days before drawing conclusions.
      </div>
    </div>
  );
}

// ============================================================
// Task #166: Miss analysis — homered but ranked > 50
// ============================================================
function MissPanel({ misses, cutoff }: { misses: MissRow[]; cutoff: number }) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>
        Miss analysis — homered but ranked outside Top {cutoff}
      </h2>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>
        Players the model passed on who hit HRs today. <strong>{misses.length}</strong>{' '}
        miss{misses.length === 1 ? '' : 'es'}. Sort: most-snubbed first (highest
        snapshot rank, or "unranked"). Look for patterns — if many misses had
        high season HR + cold L7d, the cold penalty might be too aggressive.
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Team</th>
              <th>Snapshot rank</th>
              <th className="num">Heat</th>
              <th className="num">Season HR</th>
              <th className="num">L7d</th>
              <th className="num">Streak</th>
              <th>Signals on file</th>
            </tr>
          </thead>
          <tbody>
            {misses.map((m) => (
              <tr key={m.player_id}>
                <td>
                  <Link className="player-link" to={`/player/${m.player_id}`}>
                    {m.player_name}
                  </Link>
                </td>
                <td>{m.team ? <span className="pill">{m.team}</span> : '—'}</td>
                <td className="subtle" style={{ fontSize: 12 }}>
                  {m.snapshot_rank != null ? `#${m.snapshot_rank}` : 'unranked'}
                </td>
                <td className="num">
                  {m.signals.heat_score != null ? m.signals.heat_score.toFixed(1) : '—'}
                </td>
                <td className="num">{m.signals.season_hr}</td>
                <td className="num">{m.signals.hrs_l7d}</td>
                <td className="num">{m.signals.hr_streak}</td>
                <td className="subtle" style={{ fontSize: 11, lineHeight: 1.4 }}>
                  <SignalTags m={m} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="subtle" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
        Signals shown are from the LIVE HrTarget computation if available.
        Empty signals mean the player wasn't in today's matchup pool (e.g. spot
        starter, traded, no probable pitcher resolved). Use this view to feed
        scoring changes — frequent miss patterns are the strongest tuning signal.
      </div>
    </div>
  );
}

/** Pulls a short list of badge-like signal tags off a miss row. */
function SignalTags({ m }: { m: MissRow }) {
  const tags: { label: string; tone: 'good' | 'bad' | 'neutral' }[] = [];
  if (m.signals.is_elite_power) tags.push({ label: 'Elite power', tone: 'good' });
  if ((m.signals.season_hr ?? 0) >= 15) tags.push({ label: `${m.signals.season_hr} HR`, tone: 'good' });
  if ((m.signals.hrs_l7d ?? 0) >= 2) tags.push({ label: `Hot L7d (${m.signals.hrs_l7d})`, tone: 'good' });
  if ((m.signals.hr_streak ?? 0) >= 2) tags.push({ label: `${m.signals.hr_streak}d streak`, tone: 'good' });
  if (m.signals.weather_included) {
    const t = m.signals.weather_temp_boost ?? 0;
    const w = m.signals.weather_wind_boost ?? 0;
    if (t + w > 0) tags.push({ label: `Weather +${t + w}`, tone: 'good' });
    if (t + w < 0) tags.push({ label: `Weather ${t + w}`, tone: 'bad' });
  }
  if ((m.signals.pitcher_l14d_allowed ?? 0) >= 3) tags.push({ label: `Pitcher ${m.signals.pitcher_l14d_allowed} HR L14d`, tone: 'good' });
  if (m.signals.venue_l14d_rank != null && m.signals.venue_l14d_rank <= 5) tags.push({ label: `Top-${m.signals.venue_l14d_rank} park`, tone: 'good' });
  if (m.live_target == null) tags.push({ label: 'Not in today\'s pool', tone: 'neutral' });
  if (tags.length === 0) tags.push({ label: 'No live signals', tone: 'neutral' });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {tags.map((t) => (
        <span
          key={t.label}
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            borderRadius: 999,
            fontSize: 10,
            background:
              t.tone === 'good' ? 'rgba(64,200,120,0.14)' :
              t.tone === 'bad'  ? 'rgba(255,110,110,0.14)' :
                                  'rgba(160,160,160,0.14)',
            border:
              t.tone === 'good' ? '1px solid rgba(64,200,120,0.45)' :
              t.tone === 'bad'  ? '1px solid rgba(255,110,110,0.45)' :
                                  '1px solid rgba(160,160,160,0.45)',
            color:
              t.tone === 'good' ? 'var(--good, #4cd97a)' :
              t.tone === 'bad'  ? '#ff8d8d' :
                                  'var(--muted)',
          }}
        >
          {t.label}
        </span>
      ))}
    </div>
  );
}
