/**
 * Shared types for backend scripts.
 * Frontend has its own narrower row types (see src/lib/supabase.ts).
 */

export interface ScheduledGame {
  game_pk: number;
  game_date: string; // YYYY-MM-DD
  home_team: string;
  away_team: string;
  status: string;    // "Final", "In Progress", "Scheduled", ...
  /** MLB game type code: R = regular, S = spring training, A = all-star,
   *  E = exhibition, F/D/L/W = postseason rounds, P = playoffs, I = intrasquad. */
  game_type: string | null;

  // Matchup context (may be null until MLB announces them):
  venue_id: number | null;
  venue_name: string | null;
  home_probable_pitcher_id: number | null;
  home_probable_pitcher_name: string | null;
  home_probable_pitcher_hand: string | null; // 'L' | 'R'
  away_probable_pitcher_id: number | null;
  away_probable_pitcher_name: string | null;
  away_probable_pitcher_hand: string | null;
}

export interface HomeRunRecord {
  game_pk: number;
  game_date: string; // YYYY-MM-DD
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  inning: number | null;
  pitcher_id: number | null;
  pitcher_name: string | null;
  exit_velocity: number | null;
  launch_angle: number | null;
  distance: number | null;
  // Matchup context (may be null for older rows; populated by extractor or enrichment):
  batter_side: string | null;     // 'L' | 'R' | 'S'
  pitcher_throws: string | null;  // 'L' | 'R'
  venue_id: number | null;
  venue_name: string | null;
  event_key: string;
}
