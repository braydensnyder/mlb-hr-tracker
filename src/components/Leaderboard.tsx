import { Link } from 'react-router-dom';

/**
 * Generic player leaderboard. Pass it any array of objects shaped like
 * `LeaderRow` plus a metricLabel for the header. The dashboard maps the
 * outputs of stats.ts (HotHitter, RangeHr, SeasonLeader) into this shape.
 */
export interface LeaderRow {
  player_id: number;
  player_name: string;
  team: string;
  metric: number;
  /** Optional secondary number to display (e.g. season total). */
  extra?: number | string | null;
}

interface LeaderboardProps {
  title: string;
  rows: LeaderRow[];
  metricLabel: string;
  extraLabel?: string;
  limit?: number;
  emptyText?: string;
  /** When set, player links point to /player/:id?asOf={asOf} */
  asOf?: string;
}

export default function Leaderboard({
  title,
  rows,
  metricLabel,
  extraLabel,
  limit = 10,
  emptyText = 'No data yet.',
  asOf,
}: LeaderboardProps) {
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
                <th>Player</th>
                <th>Team</th>
                <th className="num">{metricLabel}</th>
                {extraLabel && <th className="num">{extraLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {top.map((p, i) => (
                <tr key={`${p.player_id}-${i}`}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <Link
                      className="player-link"
                      to={asOf ? `/player/${p.player_id}?asOf=${asOf}` : `/player/${p.player_id}`}
                    >
                      {p.player_name}
                    </Link>
                  </td>
                  <td><span className="pill">{p.team}</span></td>
                  <td className="num">{p.metric}</td>
                  {extraLabel && <td className="num">{p.extra ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
