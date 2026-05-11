/**
 * Which MLB Stats API gameType codes count as "real MLB" for HR Tracker.
 *
 * Skipping non-MLB types at ingest prevents future ingestion of WBC,
 * All-Star, exhibition, and intrasquad rows whose team/opponent strings
 * carry country names ("United States", "Japan") that pollute leaderboards.
 *
 * Existing bad data is handled at display time via applyCanonicalTeams
 * (which remaps via the canonical players catalog).
 *
 * Codes:
 *   R = Regular season
 *   F = Wild Card
 *   D = Division Series
 *   L = League Championship
 *   W = World Series
 *   P = Playoffs (generic)
 *   S = Spring training        — included; Statcast & game logs still useful
 *   A = All-Star               — EXCLUDED
 *   E = Exhibition (e.g. vs intl team) — EXCLUDED
 *   I = Intrasquad             — EXCLUDED
 *   (null) = unknown           — included (better to keep than lose)
 */
export const MLB_INGEST_GAME_TYPES = new Set(['R', 'F', 'D', 'L', 'W', 'P', 'S']);

export function isIngestibleGameType(gameType: string | null | undefined): boolean {
  if (gameType == null || gameType === '') return true; // unknown → assume MLB
  return MLB_INGEST_GAME_TYPES.has(gameType);
}
