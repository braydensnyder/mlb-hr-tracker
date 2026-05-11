import { Link } from 'react-router-dom';
import type { BackToBack, MultiHrGame } from '../lib/stats';

export function BackToBackPanel({ rows, limit = 20, asOf }: { rows: BackToBack[]; limit?: number; asOf?: string }) {
  const top = rows.slice(0, limit);
  return (
    <div className="panel">
      <h2>Back-to-back HR games</h2>
      <p className="subtle" style={{ marginTop: -6 }}>
        Players who homered on consecutive calendar days (most recent pair).
      </p>
      {top.length === 0 ? (
        <div className="empty">No back-to-back HR games in this window.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Team</th>
                <th>Dates</th>
                <th className="num">Streak</th>
                <th className="num">HRs</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.player_id}>
                  <td>
                    <Link
                      className="player-link"
                      to={asOf ? `/player/${r.player_id}?asOf=${asOf}` : `/player/${r.player_id}`}
                    >
                      {r.player_name}
                    </Link>
                  </td>
                  <td><span className="pill">{r.team}</span></td>
                  <td className="subtle">{r.date_a} → {r.date_b}</td>
                  <td className="num">{r.current_streak_len}</td>
                  <td className="num">{r.hrs_in_streak}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MultiHrPanel({ rows, limit = 20, asOf }: { rows: MultiHrGame[]; limit?: number; asOf?: string }) {
  const top = rows.slice(0, limit);
  return (
    <div className="panel">
      <h2>2+ HR games in last 5</h2>
      <p className="subtle" style={{ marginTop: -6 }}>
        Players with at least one multi-HR game among their last 5 game dates.
      </p>
      {top.length === 0 ? (
        <div className="empty">No multi-HR games in this window.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Team</th>
                <th className="num">Multi games</th>
                <th>Recent multi-HR dates</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.player_id}>
                  <td>
                    <Link
                      className="player-link"
                      to={asOf ? `/player/${r.player_id}?asOf=${asOf}` : `/player/${r.player_id}`}
                    >
                      {r.player_name}
                    </Link>
                  </td>
                  <td><span className="pill">{r.team}</span></td>
                  <td className="num">{r.multi_hr_games.length}</td>
                  <td className="subtle">
                    {r.multi_hr_games.map((g) => `${g.date} (${g.hrs})`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
