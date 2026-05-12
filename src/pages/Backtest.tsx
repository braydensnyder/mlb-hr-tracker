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
import { supabase, type HomeRunRow, type HrTargetSnapshotRow } from '../lib/supabase';
import { useRevalidationKey } from '../lib/useRevalidationKey';

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(s: string, d: number): string {
  const [y, m, dd] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}

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
    Promise.all([fetchSnapshot(date), fetchHrsOn(date)])
      .then(([s, h]) => {
        if (cancelled) return;
        setSnapshot(s);
        setHrs(h);
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

function SnapshotTypeBadge({ type }: { type: 'live' | 'simulated' | undefined }) {
  if (!type) return null;
  const isLive = type === 'live';
  return (
    <span
      title={
        isLive
          ? 'Honest pre-game snapshot — taken before first pitch.'
          : 'Simulated historical backfill — approximates what the model would have said using data ≤ target_date - 1.'
      }
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        background: isLive ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255, 122, 24, 0.15)',
        color: isLive ? 'var(--good)' : 'var(--accent)',
        border: `1px solid ${isLive ? 'var(--good)' : 'var(--accent)'}`,
      }}
    >
      {isLive ? '● Live pre-game' : '○ Simulated historical'}
    </span>
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
