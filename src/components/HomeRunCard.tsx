import { Link } from 'react-router-dom';
import type { HomeRunRow } from '../lib/supabase';
import WeatherLine, { type WeatherLineProps } from './WeatherLine';

export default function HomeRunCard({
  hr,
  asOf,
  weather,
  showWeatherDebug,
}: {
  hr: HomeRunRow;
  asOf?: string;
  /** Per-game weather payload (temp/wind/condition + weather_updated_at).
   *  When omitted or missing fields, WeatherLine renders "Weather pending". */
  weather?: WeatherLineProps | null;
  /** Forward the temporary debug toggle from the parent page. */
  showWeatherDebug?: boolean;
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
        {/* Always render — WeatherLine handles pending / dome / live. */}
        <WeatherLine {...(weather ?? {})} showDebug={showWeatherDebug} />
      </div>
      <div className="subtle" style={{ textAlign: 'right' }}>
        {hr.distance != null && <div>{Math.round(hr.distance)} ft</div>}
        {hr.exit_velocity != null && <div>{hr.exit_velocity} mph</div>}
      </div>
    </div>
  );
}
