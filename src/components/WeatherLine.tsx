/**
 * WeatherLine — the single source of truth for "render weather on a card".
 *
 * Always renders SOMETHING. The whole reason this component exists is the
 * audit complaint that weather was invisible everywhere because callers
 * relied on `formatWeatherLine()` returning null and then hid the row:
 *
 *   {weatherLine && <div>{weatherLine}</div>}    ← the bug
 *
 * Three render states, never collapsed away:
 *   - LIVE     — weather data present.        "78°F • Wind 9 mph out to RF"
 *   - DOME     — condition is a roof phrase.  "Dome/roof neutral"
 *   - PENDING  — no temp / wind / condition.  "Weather pending"
 *
 * Also surfaces a "Updated 6:14 PM" suffix when weather_updated_at is set,
 * and a temporary debug line `weather_updated_at: <iso | null>` so we can
 * tell apart "missing in DB" from "missing in the UI" by eye.
 */
import React from 'react';

export interface WeatherLineProps {
  condition?: string | null;
  temp_f?: number | null;
  wind_mph?: number | null;
  wind_dir?: string | null;
  /** ISO timestamp of the most recent successful enrichWeather write. */
  weather_updated_at?: string | null;
  /** Temporary debug helper — when true, render the literal
   *  `weather_updated_at: <value>` line under the formatted weather. */
  showDebug?: boolean;
  /** Layout knob — `inline` strips the icon for tight tabular contexts. */
  variant?: 'card' | 'inline';
}

const ROOF_RX = /roof closed|dome|indoor/i;

/** Mirrors stats.formatWeatherLine() but never returns null — instead it
 *  classifies into a state the caller renders consistently. */
export function classifyWeather(p: {
  condition?: string | null;
  temp_f?: number | null;
  wind_mph?: number | null;
  wind_dir?: string | null;
}): { kind: 'live'; text: string } | { kind: 'dome'; text: string } | { kind: 'pending' } {
  const condition = p.condition ?? null;
  const temp = p.temp_f ?? null;
  const windMph = p.wind_mph ?? null;
  const windDir = p.wind_dir ?? null;

  const isDome = condition != null && ROOF_RX.test(condition);
  if (isDome) {
    // Indoors — wind is a non-factor; surface temp if present, else just label.
    return {
      kind: 'dome',
      text: temp != null ? `Dome/roof neutral • ${temp}°F` : 'Dome/roof neutral',
    };
  }

  // No usable signal at all → pending.
  if (temp == null && windMph == null && !condition) {
    return { kind: 'pending' };
  }

  const parts: string[] = [];
  if (temp != null) parts.push(`${temp}°F`);
  if (windMph != null && windDir) {
    if (/^calm$/i.test(windDir) || windMph === 0) {
      parts.push('Calm');
    } else {
      // "out to RF" / "in from LF" — match the user's spec
      parts.push(`Wind ${windMph} mph ${windDir.toLowerCase()}`);
    }
  } else if (windMph != null) {
    parts.push(`Wind ${windMph} mph`);
  }
  if (parts.length === 0 && condition) parts.push(condition);
  return { kind: 'live', text: parts.join(' • ') };
}

function fmtUpdated(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // "6:14 PM"
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function WeatherLine(props: WeatherLineProps) {
  const cls = classifyWeather(props);
  const updated = fmtUpdated(props.weather_updated_at ?? null);
  const variant = props.variant ?? 'card';
  const showIcon = variant === 'card';

  // Color tokens — pending is muted so the card doesn't shout when MLB
  // hasn't published yet; live is the normal subtle color; dome stays
  // mid-tone since it IS data, just neutral.
  const baseColor =
    cls.kind === 'pending' ? 'var(--muted, #888)' : undefined;

  const body =
    cls.kind === 'pending'
      ? 'Weather pending'
      : cls.kind === 'dome'
      ? cls.text
      : `Weather: ${cls.text}`;

  return (
    <div
      className="weather-line"
      style={{
        fontSize: 12,
        marginTop: 4,
        color: baseColor,
      }}
    >
      <span className="subtle" style={{ color: baseColor }}>
        {showIcon ? '🌤 ' : ''}
        {body}
        {updated && cls.kind === 'live' ? ` • Updated ${updated}` : ''}
        {updated && cls.kind === 'dome' ? ` • Updated ${updated}` : ''}
      </span>
      {props.showDebug && (
        <div
          className="subtle"
          style={{
            fontSize: 10,
            marginTop: 2,
            color: 'var(--muted, #777)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
          title="Temporary debug — remove once weather pipeline is verified."
        >
          weather_updated_at: {props.weather_updated_at ?? 'null'}
        </div>
      )}
    </div>
  );
}
