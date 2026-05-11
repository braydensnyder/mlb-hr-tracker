import { Link } from 'react-router-dom';
import type { HomeRunRow } from '../lib/supabase';

export default function HomeRunCard({ hr, asOf }: { hr: HomeRunRow; asOf?: string }) {
  const href = asOf ? `/player/${hr.player_id}?asOf=${asOf}` : `/player/${hr.player_id}`;
  return (
    <div
      className="panel"
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
    >
      <div>
        <Link className="player-link" to={href}>
          {hr.player_name}
        </Link>{' '}
        <span className="subtle">— {hr.team} vs {hr.opponent}</span>
        <div className="subtle">
          {hr.inning != null ? `Inn ${hr.inning} · ` : ''}
          {hr.pitcher_name ? `off ${hr.pitcher_name}` : ''}
        </div>
      </div>
      <div className="subtle" style={{ textAlign: 'right' }}>
        {hr.distance != null && <div>{Math.round(hr.distance)} ft</div>}
        {hr.exit_velocity != null && <div>{hr.exit_velocity} mph</div>}
      </div>
    </div>
  );
}
