import { Link } from 'react-router-dom';
import type { HandednessSplit, PlayerHandednessSplit } from '../lib/stats';

export function LeagueHandednessPanel({ split }: { split: HandednessSplit }) {
  const known = split.total_known;
  const pctKnown = known + split.total_unknown > 0
    ? Math.round((known / (known + split.total_unknown)) * 100)
    : 0;

  return (
    <div className="panel">
      <h2>HRs by pitcher hand (filtered)</h2>
      {known === 0 ? (
        <div className="empty">
          No handedness data yet. Run <code>npm run enrich:handedness</code> to backfill.
        </div>
      ) : (
        <>
          <div className="grid" style={{ marginTop: 8, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <div className="panel" style={{ background: 'var(--panel-2)' }}>
              <h2>vs LHP</h2>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{split.vs_lhp}</div>
            </div>
            <div className="panel" style={{ background: 'var(--panel-2)' }}>
              <h2>vs RHP</h2>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{split.vs_rhp}</div>
            </div>
          </div>
          <div className="subtle" style={{ marginTop: 8, fontSize: 12 }}>
            {pctKnown}% of HRs in this view have pitcher handedness recorded.
            {split.total_unknown > 0 && <> {split.total_unknown} HRs lack data.</>}
          </div>
        </>
      )}
    </div>
  );
}

export function PlayerHandednessPanel({
  rows,
  title = 'Player handedness splits',
  limit = 15,
  asOf,
}: {
  rows: PlayerHandednessSplit[];
  title?: string;
  limit?: number;
  asOf?: string;
}) {
  const top = rows.filter((r) => r.vs_lhp + r.vs_rhp > 0).slice(0, limit);
  return (
    <div className="panel">
      <h2>{title}</h2>
      {top.length === 0 ? (
        <div className="empty">
          No handedness data yet. Run <code>npm run enrich:handedness</code> to backfill.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Bats</th>
                <th>Team</th>
                <th className="num">vs LHP</th>
                <th className="num">vs RHP</th>
                <th className="num">L30d L</th>
                <th className="num">L30d R</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.player_id}>
                  <td>
                    <Link className="player-link" to={asOf ? `/player/${r.player_id}?asOf=${asOf}` : `/player/${r.player_id}`}>
                      {r.player_name}
                    </Link>
                  </td>
                  <td>{r.bat_side ?? '—'}</td>
                  <td><span className="pill">{r.team}</span></td>
                  <td className="num">{r.vs_lhp}</td>
                  <td className="num">{r.vs_rhp}</td>
                  <td className="num">{r.vs_lhp_l30d}</td>
                  <td className="num">{r.vs_rhp_l30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
