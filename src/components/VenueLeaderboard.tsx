import type { VenueStats } from '../lib/stats';

interface Props {
  rows: VenueStats[];
  title?: string;
  limit?: number;
}

/**
 * Ballpark HR friendliness based purely on stored data: rank by L14d HRs,
 * then season volume. We do NOT incorporate park factors from outside
 * sources — this is "what our DB says."
 */
export default function VenueLeaderboard({ rows, title = 'Ballparks — HR friendliness', limit = 12 }: Props) {
  const top = rows.slice(0, limit);
  return (
    <div className="panel">
      <h2>{title}</h2>
      {top.length === 0 ? (
        <div className="empty">
          No venue data yet. Run <code>npm run enrich:venues</code> to backfill.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Venue</th>
                <th className="num">L7d</th>
                <th className="num">L14d</th>
                <th className="num">Season</th>
                <th>Teams seen</th>
              </tr>
            </thead>
            <tbody>
              {top.map((v, i) => (
                <tr key={v.venue_name}>
                  <td className="num">{i + 1}</td>
                  <td>{v.venue_name}</td>
                  <td className="num">{v.l7d}</td>
                  <td className="num">{v.l14d}</td>
                  <td className="num">{v.season}</td>
                  <td className="subtle" style={{ fontSize: 12 }}>
                    {v.teams_seen.slice(0, 4).join(', ')}
                    {v.teams_seen.length > 4 && ` +${v.teams_seen.length - 4}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="subtle" style={{ marginTop: 6, fontSize: 11 }}>
            Ranked by L14d HRs. Counts include both teams' HRs at that venue.
          </div>
        </div>
      )}
    </div>
  );
}
