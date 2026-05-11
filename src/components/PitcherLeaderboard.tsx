import type { PitcherAllowed } from '../lib/stats';

interface Props {
  title: string;
  rows: PitcherAllowed[];
  limit?: number;
  emptyText?: string;
}

/**
 * Pitcher HR-allowed leaderboard.
 *
 * "Last 3 / 5 starts" is approximated as "the pitcher's most recent 3 / 5
 * distinct game-dates on which they gave up at least one HR." We don't
 * track every appearance, just HR events — this is the closest correct
 * answer using only `home_runs` as the source of truth.
 */
export default function PitcherLeaderboard({ title, rows, limit = 15, emptyText = 'No pitcher data yet.' }: Props) {
  const top = rows.slice(0, limit);
  return (
    <div className="panel">
      <h2>{title}</h2>
      {top.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Pitcher</th>
                <th>Hand</th>
                <th>Team</th>
                <th className="num">Season</th>
                <th className="num">L3 starts*</th>
                <th className="num">L5 starts*</th>
                <th className="num">L14d</th>
              </tr>
            </thead>
            <tbody>
              {top.map((p, i) => (
                <tr key={p.pitcher_id}>
                  <td className="num">{i + 1}</td>
                  <td>{p.pitcher_name}</td>
                  <td>{p.pitcher_throws ?? '—'}</td>
                  <td><span className="pill">{p.team}</span></td>
                  <td className="num">{p.season_allowed}</td>
                  <td className="num">{p.allowed_last_3_starts}</td>
                  <td className="num">{p.allowed_last_5_starts}</td>
                  <td className="num">{p.allowed_last_14_days}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="subtle" style={{ marginTop: 6, fontSize: 11 }}>
            * "L3/L5 starts" = the pitcher's most recent 3/5 game-dates that gave up at least one HR.
            We don't track non-HR appearances, so this is an approximation of recent form.
          </div>
        </div>
      )}
    </div>
  );
}
