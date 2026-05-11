import type { TeamHr } from '../lib/stats';

interface TeamLeaderboardProps {
  title: string;
  rows: TeamHr[];
  limit?: number;
}

export default function TeamLeaderboard({ title, rows, limit = 15 }: TeamLeaderboardProps) {
  const top = rows.slice(0, limit);
  return (
    <div className="panel">
      <h2>{title}</h2>
      {top.length === 0 ? (
        <div className="empty">No data yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th className="num">HR</th>
                <th className="num">Hitters</th>
              </tr>
            </thead>
            <tbody>
              {top.map((t, i) => (
                <tr key={t.team}>
                  <td className="num">{i + 1}</td>
                  <td>{t.team}</td>
                  <td className="num">{t.hrs}</td>
                  <td className="num">{t.unique_hitters}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
