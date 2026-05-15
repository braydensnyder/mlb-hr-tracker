import { Link } from 'react-router-dom';
import type { HomeRunRow } from '../lib/supabase';

export default function HomeRunCard({
  hr,
  asOf,
  weather,
}: {
  hr: HomeRunRow;
  asOf?: string;
  /** Pre-formatted weather line for the game this HR was hit in
   *  (e.g. "82°F • Wind 12 mph out to LF"). Optional — omitted when the
   *  game has no weather data on file yet. */
  weather?: string | null;
}) {
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
        {weather && (
          <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
            🌤 {weather}
          </div>
        )}
      </div>
      <div className="subtle" style={{ textAlign: 'right' }}>
        {hr.distance != null && <div>{Math.round(hr.distance)} ft</div>}
        {hr.exit_velocity != null && <div>{hr.exit_velocity} mph</div>}
      </div>
    </div>
  );
}
