/**
 * fetchGameFeed(gamePk) — get the full live feed (play-by-play + boxscore) for one game.
 *
 * The shape is large; we keep it as `any` because we only consume a few branches in
 * extractHomeRuns. If the upstream schema drifts, fix it there.
 */
import { getGameFeedRaw } from './lib/mlb.js';

export async function fetchGameFeed(gamePk: number): Promise<any> {
  return getGameFeedRaw(gamePk);
}
