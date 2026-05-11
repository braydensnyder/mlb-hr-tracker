interface FiltersProps {
  /** The single "as of" date the dashboard pivots around. */
  asOfDate: string;
  onAsOfDateChange: (d: string) => void;

  team: string;
  teams: string[];
  onTeamChange: (t: string) => void;

  search: string;
  onSearchChange: (s: string) => void;

  /** Quick "shift the date" buttons (yesterday / today). */
  onShiftDays?: (delta: number) => void;
  onJumpToToday?: () => void;
  onReset?: () => void;
}

export default function Filters(props: FiltersProps) {
  const {
    asOfDate,
    onAsOfDateChange,
    team,
    teams,
    onTeamChange,
    search,
    onSearchChange,
    onShiftDays,
    onJumpToToday,
    onReset,
  } = props;

  return (
    <div className="filters">
      <label>
        <span>As of date</span>
        <input
          type="date"
          value={asOfDate}
          onChange={(e) => onAsOfDateChange(e.target.value)}
        />
      </label>
      <label>
        <span>Team</span>
        <select value={team} onChange={(e) => onTeamChange(e.target.value)}>
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Player search</span>
        <input
          type="search"
          placeholder="e.g. Judge"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </label>

      {onShiftDays && (
        <div className="filter-presets">
          <button type="button" onClick={() => onShiftDays(-1)} aria-label="Previous day">
            ◀ Day
          </button>
          {onJumpToToday && (
            <button type="button" onClick={onJumpToToday}>Today</button>
          )}
          <button type="button" onClick={() => onShiftDays(1)} aria-label="Next day">
            Day ▶
          </button>
        </div>
      )}

      {onReset && (
        <button type="button" className="btn-reset" onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}
