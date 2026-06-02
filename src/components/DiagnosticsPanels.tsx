/**
 * Diagnostics panels for the redesigned HR Targets main page (task #206+):
 *
 *   PoolCoveragePanel       — daily + 7d/14d/30d coverage rollups
 *   NearMissesPanel         — HR hitters at rank 51-100, 101+, unranked
 *   ExclusionReasonsPanel   — WHY HR hitters fell outside the actionable Top 50
 *   BestHistoricalPoolPanel — hindsight pool reconstruction
 *
 * These read pre-computed outputs from stats.ts. No business logic here.
 */
import { useState } from 'react';
import type {
  PoolCoverageResult,
  CoverageWindow,
  NearMissResult,
  NearMissPlayer,
  ExclusionReasonsResult,
  BestPoolResult,
} from '../lib/stats';

function pct(n: number, d = 0): string { return `${(n * 100).toFixed(d)}%`; }

// =============================================================================
//  Pool Coverage
// =============================================================================

export function PoolCoveragePanel({ coverage, loading }: {
  coverage: PoolCoverageResult | null;
  loading: boolean;
}) {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <Header
        title="Pool Coverage"
        sub="Is the model even considering the right players?"
      />
      {loading ? (
        <p className="subtle" style={{ fontSize: 13 }}>Loading historical snapshots…</p>
      ) : !coverage ? (
        <p className="subtle" style={{ fontSize: 13 }}>No historical data available.</p>
      ) : (
        <>
          <div className="diag-kpis">
            <KpiTile label="7-day coverage" win={coverage.l7d} />
            <KpiTile label="14-day coverage" win={coverage.l14d} />
            <KpiTile label="30-day coverage" win={coverage.l30d} />
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>
              Per-day breakdown ({coverage.days.length} days)
            </summary>
            <div className="diag-table-wrap" style={{ marginTop: 8 }}>
              <table className="diag-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">HR hitters</th>
                    <th className="num">Inside pool</th>
                    <th className="num">Outside pool</th>
                    <th className="num">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.days.slice().reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td className="num">{d.total_hr_hitters}</td>
                      <td className="num diag-good">{d.inside_pool}</td>
                      <td className="num diag-bad">{d.outside_pool}</td>
                      <td className={`num ${d.coverage_rate >= 0.7 ? 'diag-good' : d.coverage_rate >= 0.5 ? '' : 'diag-bad'}`}>
                        {pct(d.coverage_rate, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="subtle" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
            {coverage.note}
          </p>
        </>
      )}
      <DiagStyles />
    </section>
  );
}

function KpiTile({ label, win }: { label: string; win: CoverageWindow }) {
  const rate = win.coverage_rate;
  const tone = rate >= 0.7 ? 'good' : rate >= 0.5 ? 'mid' : 'bad';
  return (
    <div className={`diag-kpi diag-kpi--${tone}`}>
      <div className="diag-kpi-label">{label}</div>
      <div className="diag-kpi-value">{pct(rate, 1)}</div>
      <div className="diag-kpi-sub">
        {win.inside_pool} / {win.total_hr_hitters} HR hitters · {win.days_in_window}d
      </div>
    </div>
  );
}

// =============================================================================
//  Near Misses
// =============================================================================

export function NearMissesPanel({ misses, loading, asOf }: {
  misses: NearMissResult | null;
  loading: boolean;
  asOf: string;
}) {
  const [tab, setTab] = useState<'51_100' | '101_plus' | 'unranked'>('51_100');
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <Header
        title="Near Misses"
        sub="HR hitters the model ranked outside Top 50."
      />
      {loading ? (
        <p className="subtle" style={{ fontSize: 13 }}>Loading near-miss data…</p>
      ) : !misses ? (
        <p className="subtle" style={{ fontSize: 13 }}>No data available.</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', fontSize: 12, opacity: 0.75 }}>
            <span>
              <strong>{misses.total_near_misses}</strong> near misses across{' '}
              <strong>{misses.total_hr_hitters}</strong> HR hitters in the last {misses.window_days}d
            </span>
          </div>

          <div className="diag-tabs" style={{ marginTop: 8 }}>
            <TabBtn active={tab === '51_100'} count={misses.ranked_51_100.count} onClick={() => setTab('51_100')}>Rank 51–100</TabBtn>
            <TabBtn active={tab === '101_plus'} count={misses.ranked_101_plus.count} onClick={() => setTab('101_plus')}>Rank 101+</TabBtn>
            <TabBtn active={tab === 'unranked'} count={misses.unranked.count} onClick={() => setTab('unranked')}>Unranked</TabBtn>
          </div>

          <NearMissList
            players={tab === '51_100' ? misses.ranked_51_100.players :
                     tab === '101_plus' ? misses.ranked_101_plus.players :
                     misses.unranked.players}
            asOf={asOf}
          />
        </>
      )}
      <DiagStyles />
    </section>
  );
}

function TabBtn({ children, active, count, onClick }: { children: React.ReactNode; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`diag-tab ${active ? 'diag-tab--active' : ''}`}
    >
      {children} <span className="diag-tab-count">{count}</span>
    </button>
  );
}

function NearMissList({ players, asOf }: { players: NearMissPlayer[]; asOf: string }) {
  if (players.length === 0) {
    return <p className="subtle" style={{ fontSize: 13, marginTop: 10 }}>— none in this bucket —</p>;
  }
  // Cap the display so the panel stays scannable — full list is in the data.
  const display = players.slice(0, 30);
  return (
    <div className="diag-table-wrap" style={{ marginTop: 8 }}>
      <table className="diag-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Player</th>
            <th>Team</th>
            <th className="num">Rank</th>
            <th className="num">Heat</th>
          </tr>
        </thead>
        <tbody>
          {display.map((p) => (
            <tr key={`${p.date}-${p.player_id}`}>
              <td>{p.date}</td>
              <td>
                <a href={`/player/${p.player_id}?asOf=${asOf}`} className="player-link">
                  {p.player_name}
                </a>
              </td>
              <td>{p.team || '—'}</td>
              <td className="num">{p.rank ?? '—'}</td>
              <td className="num">{p.heat_score?.toFixed(0) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {players.length > display.length && (
        <p className="subtle" style={{ fontSize: 11, marginTop: 6, textAlign: 'right' }}>
          Showing {display.length} of {players.length}
        </p>
      )}
    </div>
  );
}

// =============================================================================
//  Exclusion Reasons
// =============================================================================

export function ExclusionReasonsPanel({ reasons, loading }: {
  reasons: ExclusionReasonsResult | null;
  loading: boolean;
}) {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <Header
        title="Exclusion Reasons"
        sub="Why HR hitters fell outside the actionable Top 50."
      />
      {loading ? (
        <p className="subtle" style={{ fontSize: 13 }}>Loading exclusion analysis…</p>
      ) : !reasons || reasons.total_excluded === 0 ? (
        <p className="subtle" style={{ fontSize: 13 }}>No HR hitters fell outside the Top 50 in this window.</p>
      ) : (
        <>
          <p className="subtle" style={{ fontSize: 12 }}>
            <strong>{reasons.total_excluded}</strong> HR hitters were outside the Top 50 across{' '}
            <strong>{reasons.total_hr_hitters}</strong> total HRs in the last {reasons.window_days}d.
            Categorized below. A single player can trigger multiple reasons.
          </p>
          <div className="diag-reason-grid" style={{ marginTop: 8 }}>
            {reasons.aggregates.map((a) => (
              <div key={a.reason} className={`diag-reason-tile diag-reason--${a.reason.split('_')[0]}`}>
                <div className="diag-reason-count">{a.count}</div>
                <div className="diag-reason-label">{a.label}</div>
                <div className="diag-reason-share">{pct(a.share, 0)}</div>
              </div>
            ))}
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>
              Per-player exclusion list ({reasons.excluded.length})
            </summary>
            <div className="diag-table-wrap" style={{ marginTop: 8 }}>
              <table className="diag-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Player</th>
                    <th>Team</th>
                    <th className="num">Rank</th>
                    <th className="num">Heat</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {reasons.excluded.slice(0, 100).map((e) => (
                    <tr key={`${e.date}-${e.player_id}`}>
                      <td>{e.date}</td>
                      <td>{e.player_name}</td>
                      <td>{e.team || '—'}</td>
                      <td className="num">{e.rank ?? '—'}</td>
                      <td className="num">{e.heat_score?.toFixed(0) ?? '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {e.reasons.map((r) => (
                            <span key={r} className={`diag-chip diag-chip--${r.split('_')[0]}`}>
                              {labelize(r)}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <DiagStyles />
    </section>
  );
}

function labelize(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// =============================================================================
//  Best Historical Pool
// =============================================================================

export function BestHistoricalPoolPanel({ pool, loading }: {
  pool: BestPoolResult | null;
  loading: boolean;
}) {
  const [selectedIdx, setSelectedIdx] = useState<number>(-1); // -1 = aggregate view
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <Header
        title="Best Historical Pool"
        sub="Hindsight research — which rank-51–100 HR hitters could the pool have promoted?"
        warn="Hindsight only — NOT a live prediction."
      />
      {loading ? (
        <p className="subtle" style={{ fontSize: 13 }}>Loading reconstruction…</p>
      ) : !pool ? (
        <p className="subtle" style={{ fontSize: 13 }}>No data available.</p>
      ) : (
        <>
          <div className="diag-kpis">
            <div className="diag-kpi diag-kpi--mid">
              <div className="diag-kpi-label">Current pool coverage</div>
              <div className="diag-kpi-value">{pct(pool.current_pool_coverage, 1)}</div>
              <div className="diag-kpi-sub">Top 50 / {pool.window_days}d</div>
            </div>
            <div className="diag-kpi diag-kpi--good">
              <div className="diag-kpi-label">Reconstructed coverage</div>
              <div className="diag-kpi-value">{pct(pool.reconstructed_pool_coverage, 1)}</div>
              <div className="diag-kpi-sub">if we promoted rank 51–100 HRs</div>
            </div>
            <div className="diag-kpi">
              <div className="diag-kpi-label">Players gained</div>
              <div className="diag-kpi-value">{pool.total_gained}</div>
              <div className="diag-kpi-sub">over {pool.days.length} days</div>
            </div>
          </div>

          <div className="diag-card" style={{ marginTop: 10, borderLeft: '3px solid #ffb86c' }}>
            <h5 style={{ margin: 0, fontSize: 13, color: '#ffd28c' }}>📊 Repeated patterns across {pool.days.length} days</h5>
            <p className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
              Signals shared by gained HR hitters that show up on ≥ 2 days. These are profiles the model is consistently underweighting at the pool edge.
            </p>
            {pool.recurring.length === 0 ? (
              <p className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                No signal appeared on multiple days — either window too short or no clear pattern.
              </p>
            ) : (
              <div className="diag-table-wrap" style={{ marginTop: 6 }}>
                <table className="diag-table">
                  <thead>
                    <tr>
                      <th>Signal</th>
                      <th className="num">Days present</th>
                      <th className="num">Players gained</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.recurring.map((r) => (
                      <tr key={r.signal}>
                        <td><strong>{r.label}</strong></td>
                        <td className="num">{r.days_present}/{r.total_days}</td>
                        <td className="num">{r.player_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {pool.days.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>
                Per-day reconstruction
              </summary>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <select
                  value={selectedIdx}
                  onChange={(e) => setSelectedIdx(Number(e.target.value))}
                  style={{ background: '#0c0e14', color: '#cfe', border: '1px solid #2a2d36', borderRadius: 6, padding: '4px 8px', fontSize: 13 }}
                >
                  <option value={-1}>— pick a day —</option>
                  {pool.days.slice().reverse().map((d) => (
                    <option key={d.date} value={pool.days.indexOf(d)}>
                      {d.date} ({pct(d.current_coverage, 0)} → {pct(d.reconstructed_coverage, 0)}, +{d.gained.length})
                    </option>
                  ))}
                </select>
              </div>
              {selectedIdx >= 0 && pool.days[selectedIdx] && (
                <BestPoolDayDetail day={pool.days[selectedIdx]} />
              )}
            </details>
          )}

          <p className="subtle" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>{pool.note}</p>
        </>
      )}
      <DiagStyles />
    </section>
  );
}

function BestPoolDayDetail({ day }: { day: BestPoolResult['days'][number] }) {
  return (
    <div className="diag-card" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h5 style={{ margin: 0, fontSize: 13 }}>{day.date}</h5>
        <span className="subtle" style={{ fontSize: 11 }}>
          {day.current_hr_hits_in_pool} → {day.reconstructed_hr_hits_in_pool} HRs in pool ·
          {' '}{pct(day.current_coverage, 0)} → {pct(day.reconstructed_coverage, 0)}
        </span>
      </div>
      {day.gained.length === 0 ? (
        <p className="subtle" style={{ fontSize: 12, marginTop: 6 }}>No edge HR hitters this day.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'grid', gap: 4 }}>
          {day.gained.map((g) => (
            <li key={g.player_id} style={{ fontSize: 12 }}>
              <strong>{g.player_name}</strong>{' '}
              <span className="subtle">({g.team})</span>{' '}
              {g.signals.length > 0 && (
                <span>—{' '}
                  {g.signals.map((s) => (
                    <span key={s} className="diag-chip diag-chip--good" style={{ marginRight: 3 }}>
                      {labelize(s)}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =============================================================================
//  Shared bits
// =============================================================================

function Header({ title, sub, warn }: { title: string; sub: string; warn?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        {warn && (
          <span style={{
            fontSize: 10, color: '#ffb86c', textTransform: 'uppercase',
            letterSpacing: 0.06, fontWeight: 600,
          }}>{warn}</span>
        )}
      </div>
      <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function DiagStyles() {
  return (
    <style>{`
      .diag-kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 8px;
      }
      .diag-kpi {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-left: 3px solid #aab1c0;
        border-radius: 8px;
        padding: 8px 12px;
      }
      .diag-kpi--good { border-left-color: #6bd482; }
      .diag-kpi--mid  { border-left-color: #ffd28c; }
      .diag-kpi--bad  { border-left-color: #e07a7a; }
      .diag-kpi-label { font-size: 11px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
      .diag-kpi-value { font-size: 20px; font-weight: 700; color: #cfe; margin-top: 2px; }
      .diag-kpi-sub { font-size: 10.5px; opacity: 0.65; margin-top: 2px; }

      .diag-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
      .diag-tab {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        color: #cfe; padding: 4px 10px; border-radius: 6px;
        font-size: 12px; cursor: pointer;
      }
      .diag-tab--active {
        background: #2d3a52; border-color: #4a6fa5; color: #fff;
      }
      .diag-tab-count {
        display: inline-block; margin-left: 4px; padding: 0 6px;
        background: rgba(255,255,255,0.1); border-radius: 999px; font-size: 10px;
      }

      .diag-table-wrap { overflow-x: auto; }
      .diag-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .diag-table th, .diag-table td {
        text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330);
        white-space: nowrap;
      }
      .diag-table th.num, .diag-table td.num { text-align: right; }
      .diag-good { color: #6bd482; }
      .diag-bad  { color: #e07a7a; }

      .diag-reason-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 8px;
      }
      .diag-reason-tile {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 8px 10px;
        text-align: center;
      }
      .diag-reason-tile.diag-reason--cold { border-top: 3px solid #4cc7ff; }
      .diag-reason-tile.diag-reason--low  { border-top: 3px solid #ffd28c; }
      .diag-reason-tile.diag-reason--not  { border-top: 3px solid #e07a7a; }
      .diag-reason-tile.diag-reason--lineup { border-top: 3px solid #c084fc; }
      .diag-reason-tile.diag-reason--missing { border-top: 3px solid #aab1c0; }
      .diag-reason-tile.diag-reason--weak { border-top: 3px solid #ff7a18; }
      .diag-reason-tile.diag-reason--bad { border-top: 3px solid #ff8d8d; }
      .diag-reason-tile.diag-reason--odds { border-top: 3px solid #4cd97a; }
      .diag-reason-count { font-size: 22px; font-weight: 700; color: #cfe; }
      .diag-reason-label { font-size: 11px; opacity: 0.85; margin-top: 2px; }
      .diag-reason-share { font-size: 10.5px; opacity: 0.6; margin-top: 1px; }

      .diag-chip {
        display: inline-block; padding: 1px 6px; border-radius: 999px;
        font-size: 10px; font-weight: 600; white-space: nowrap;
        background: rgba(192,132,252,0.12); border: 1px solid rgba(192,132,252,0.35); color: #c084fc;
      }
      .diag-chip--cold { background: rgba(76,199,255,0.12); border-color: rgba(76,199,255,0.35); color: #4cc7ff; }
      .diag-chip--not  { background: rgba(224,122,122,0.12); border-color: rgba(224,122,122,0.35); color: #e07a7a; }
      .diag-chip--low  { background: rgba(255,210,140,0.12); border-color: rgba(255,210,140,0.35); color: #ffd28c; }
      .diag-chip--good { background: rgba(64,200,120,0.14); border-color: rgba(64,200,120,0.45); color: var(--good, #4cd97a); }

      .diag-card {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 10px 12px;
      }
    `}</style>
  );
}
