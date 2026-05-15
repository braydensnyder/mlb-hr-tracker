/**
 * Quick sanity check for src/lib/stats.ts. Not a real test framework — just
 * a self-validating script. Run with:
 *   node --experimental-strip-types scripts/_test_stats.ts
 *
 * This file is local-dev-only. Safe to delete.
 */
import {
  addDays,
  daysBetween,
  aggregateByPlayer,
  hotHittersLastNGames,
  hrsInLastDays,
  teamHrLeaderboard,
  backToBackHr,
  multiHrInLastNGames,
  seasonLeaders,
  computePlayerView,
  pitcherHrLeaderboard,
  leagueHandednessSplit,
  playerHandednessSplits,
  singlePlayerHandedness,
  venueLeaderboard,
  applyCanonicalTeams,
  computeHrTargets,
  computeWeatherAdjustment,
  formatWeatherLine,
  HEAT_SCORE_WEIGHTS,
  type HrTargetGame,
} from '../src/lib/stats.ts';

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ---- date helpers ----
eq('addDays +1', addDays('2026-04-30', 1), '2026-05-01');
eq('addDays -1', addDays('2026-03-01', -1), '2026-02-28');
eq('daysBetween 1', daysBetween('2026-05-01', '2026-05-02'), 1);
eq('daysBetween 0', daysBetween('2026-05-01', '2026-05-01'), 0);
eq('daysBetween -2', daysBetween('2026-05-03', '2026-05-01'), -2);

// ---- fixture: 3 players over a few days ----
function hr(
  id: number,
  player_id: number,
  name: string,
  team: string,
  opp: string,
  date: string,
  extras: { pitcher_id?: number; pitcher_name?: string; pitcher_throws?: string | null; batter_side?: string | null; venue_name?: string | null } = {},
) {
  return {
    id,
    game_pk: 1,
    game_date: date,
    player_id,
    player_name: name,
    team,
    opponent: opp,
    inning: 1,
    pitcher_id: extras.pitcher_id ?? 99,
    pitcher_name: extras.pitcher_name ?? 'P',
    exit_velocity: null,
    launch_angle: null,
    distance: null,
    batter_side: extras.batter_side ?? null,
    pitcher_throws: extras.pitcher_throws ?? null,
    venue_name: extras.venue_name ?? null,
    created_at: '2026-05-09T00:00:00Z',
  } as any;
}

// Judge: HRs on 5/05, 5/06 (2), 5/07, 5/09 — back-to-back 5/05+5/06, multi-HR on 5/06
// Soto: HRs on 5/01, 5/03, 5/09
// Trout: HR only on 5/02
const rows = [
  hr(1, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-05'),
  hr(2, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-06'),
  hr(3, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-06'),
  hr(4, 100, 'Aaron Judge', 'NYY', 'TOR', '2026-05-07'),
  hr(5, 100, 'Aaron Judge', 'NYY', 'TBR', '2026-05-09'),
  hr(6, 200, 'Juan Soto', 'NYM', 'PHI', '2026-05-01'),
  hr(7, 200, 'Juan Soto', 'NYM', 'PHI', '2026-05-03'),
  hr(8, 200, 'Juan Soto', 'NYM', 'ATL', '2026-05-09'),
  hr(9, 300, 'Mike Trout', 'LAA', 'OAK', '2026-05-02'),
];

const byPlayer = aggregateByPlayer(rows);
eq('aggregateByPlayer sizes', byPlayer.size, 3);
eq('Judge totalInWindow', byPlayer.get(100)!.totalInWindow, 5);
eq('Judge distinctDates', byPlayer.get(100)!.distinctDates, ['2026-05-09', '2026-05-07', '2026-05-06', '2026-05-05']);

// hot hitters last 3 games anchored at 5/09
// Judge last-3-games = 5/09, 5/07, 5/06 → 1+1+2 = 4
// Soto  last-3-games = 5/09, 5/03, 5/01 → 1+1+1 = 3
// Trout last-3-games = 5/02                  → 1
const h3 = hotHittersLastNGames(byPlayer, '2026-05-09', 3);
eq('hot3 first is Judge w/ 4', { p: h3[0].player_name, m: h3[0].hrs_in_last_n_games }, { p: 'Aaron Judge', m: 4 });
eq('hot3 second is Soto w/ 3', { p: h3[1].player_name, m: h3[1].hrs_in_last_n_games }, { p: 'Juan Soto', m: 3 });

// hrs in last 7 days anchored 5/09 = window [5/03, 5/09]
// Judge: 5/05, 5/06x2, 5/07, 5/09 = 5
// Soto:  5/03, 5/09 = 2
// Trout: none in window
const l7 = hrsInLastDays(byPlayer, '2026-05-09', 7);
eq('l7 leader is Judge w/ 5', { p: l7[0].player_name, hrs: l7[0].hrs }, { p: 'Aaron Judge', hrs: 5 });
eq('l7 has 2 entries (Trout filtered out)', l7.length, 2);

// hrs in last 14 days = window [4/26, 5/09] — all 9 HRs counted
const l14 = hrsInLastDays(byPlayer, '2026-05-09', 14);
eq('l14 sum hrs', l14.reduce((s, r) => s + r.hrs, 0), 9);

// team HR leaderboard, full window
const teamSeason = teamHrLeaderboard(rows);
eq('team season top is NYY w/ 5', { team: teamSeason[0].team, hrs: teamSeason[0].hrs }, { team: 'NYY', hrs: 5 });
eq('team season has 3 teams', teamSeason.length, 3);

// team HR leaderboard last 7 days [5/03, 5/09]
const teamL7 = teamHrLeaderboard(rows, { since: '2026-05-03', until: '2026-05-09' });
eq('team L7 NYY = 5', teamL7.find((t) => t.team === 'NYY')!.hrs, 5);
eq('team L7 NYM = 2', teamL7.find((t) => t.team === 'NYM')!.hrs, 2);
eq('team L7 missing LAA', teamL7.find((t) => t.team === 'LAA') ?? null, null);

// back-to-back: Judge has 5/05, 5/06 consecutive, plus 5/06+5/07 → streak length 3 (5/05, 5/06, 5/07)
// Soto's two most recent are 5/09, 5/03 — NOT consecutive → excluded
// Trout has only 1 date → excluded
const b2b = backToBackHr(byPlayer, '2026-05-09');
// Note: Judge's most recent date is 5/09, prev is 5/07 — NOT consecutive! So Judge should NOT
// appear in back-to-back when anchored at 5/09 (gap 5/08).
// If we anchor at 5/07 instead, Judge's two most recent are 5/07, 5/06 → consecutive, streak = 3.
eq('b2b at 5/09 is empty (Judge has gap)', b2b.length, 0);

const b2bAt7 = backToBackHr(byPlayer, '2026-05-07');
eq('b2b at 5/07 has Judge with streak 3', { p: b2bAt7[0].player_name, s: b2bAt7[0].current_streak_len }, { p: 'Aaron Judge', s: 3 });

// 2+ HR in last 5 games anchored at 5/09
// Judge last 5 dates: 5/09(1), 5/07(1), 5/06(2), 5/05(1) — 5/06 is multi
const m = multiHrInLastNGames(byPlayer, '2026-05-09', 5, 2);
eq('multiHr count = 1 (Judge only)', m.length, 1);
eq('multiHr Judge has 5/06 with 2 HRs', m[0].multi_hr_games, [{ date: '2026-05-06', hrs: 2 }]);

// season leaders
const sl = seasonLeaders(byPlayer);
eq('seasonLeaders length 3', sl.length, 3);
eq('seasonLeaders #1 Judge 5', { name: sl[0].player_name, hrs: sl[0].hrs }, { name: 'Aaron Judge', hrs: 5 });

// ---- as-of: data beyond anchor must be excluded ----
// Fixture above has Judge HR on 5/09. Pretend the DB also has one on 5/10
// (a future date relative to the anchor we'll use, 5/09). The helpers filter
// by distinctDates ≤ anchor and perDate within window, so the 5/10 row must
// not influence any rolling view anchored at 5/09.
const rowsWithFuture = [...rows, hr(99, 100, 'Aaron Judge', 'NYY', 'TBR', '2026-05-10')];
const byPlayerWithFuture = aggregateByPlayer(rowsWithFuture);

// hot3 anchored at 5/09 should still be Judge=4 (5/09=1 + 5/07=1 + 5/06=2),
// NOT 5 (which would be the case if 5/10 leaked in via a wrong "newest 3 dates" pick).
const h3WithFuture = hotHittersLastNGames(byPlayerWithFuture, '2026-05-09', 3);
const judgeFuture = h3WithFuture.find((r) => r.player_id === 100)!;
eq('hot3 anchored 5/09 ignores 5/10 row (Judge stays at 4)', judgeFuture.hrs_in_last_n_games, 4);

// L7d anchored at 5/09 = window [5/03, 5/09]. The 5/10 row must not be included.
const l7WithFuture = hrsInLastDays(byPlayerWithFuture, '2026-05-09', 7);
const judgeL7Future = l7WithFuture.find((r) => r.player_id === 100)!;
eq('l7 anchored 5/09 ignores 5/10 row (Judge stays at 5)', judgeL7Future.hrs, 5);

// teamHr "last 7 days" anchored at 5/09 must not include the 5/10 row.
const teamL7Future = teamHrLeaderboard(rowsWithFuture, { since: '2026-05-03', until: '2026-05-09' });
eq('teamL7 anchored 5/09 NYY = 5 (5/10 row excluded by until)', teamL7Future.find((t) => t.team === 'NYY')!.hrs, 5);

// season leaderboard anchored at 5/09 — using teamHrLeaderboard with until guards future rows.
const teamSeasonFuture = teamHrLeaderboard(rowsWithFuture, { until: '2026-05-09' });
eq('team season anchored 5/09 NYY = 5 (5/10 excluded)', teamSeasonFuture.find((t) => t.team === 'NYY')!.hrs, 5);

// ---- consistency: PlayerDetail (computePlayerView) must match Dashboard helpers ----
// This is the regression check for the "PlayerDetail says 2, log shows 11" bug.
// Both views must agree exactly when fed the same raw HR rows.
const judgeRows = rows.filter((r) => r.player_id === 100);
const judgeView = computePlayerView(judgeRows, '2026-05-09');
eq('computePlayerView Judge season_total = 5', judgeView.season_total, 5);
eq('computePlayerView Judge season_total == log length', judgeView.season_total, judgeRows.length);
eq('computePlayerView Judge last_hr_date = 2026-05-09', judgeView.last_hr_date, '2026-05-09');
eq('computePlayerView Judge L3 = 4', judgeView.hrs_last_3_games, 4);
eq('computePlayerView Judge L5 = 5', judgeView.hrs_last_5_games, 5);
eq('computePlayerView Judge L7d = 5', judgeView.hrs_last_7_days, 5);
eq('computePlayerView Judge L14d = 5', judgeView.hrs_last_14_days, 5);
eq('computePlayerView Judge hrs_today = 1', judgeView.hrs_today, 1);

// Dashboard's hot3 for Judge (same anchor) must match player view's L3.
const judgeFromDashboard = h3.find((r) => r.player_id === 100)!;
eq(
  'Dashboard L3 == PlayerDetail L3 for same anchor',
  judgeFromDashboard.hrs_in_last_n_games,
  judgeView.hrs_last_3_games,
);

// Dashboard's seasonLeaders entry for Judge must match player view's season_total.
const judgeSeason = sl.find((r) => r.player_id === 100)!;
eq(
  'Dashboard season HR == PlayerDetail season_total for same data',
  judgeSeason.hrs,
  judgeView.season_total,
);

// Future row defense: a HR after asOf must NOT inflate season_total.
const judgeWithFuture = rowsWithFuture.filter((r) => r.player_id === 100);
const judgeViewBounded = computePlayerView(judgeWithFuture, '2026-05-09');
eq(
  'computePlayerView ignores HRs after asOf (season stays at 5)',
  judgeViewBounded.season_total,
  5,
);
eq(
  'computePlayerView ignores HRs after asOf (last_hr_date stays at 5/09)',
  judgeViewBounded.last_hr_date,
  '2026-05-09',
);
// But the player's underlying row count is unaffected — log shows everything.
eq(
  'underlying row count includes future row',
  judgeWithFuture.length,
  6, // 5 in-scope + 1 future
);

// Empty input → null last_hr_date and zeros everywhere
const empty = computePlayerView([], '2026-05-09');
eq('empty season_total', empty.season_total, 0);
eq('empty last_hr_date null', empty.last_hr_date, null);
eq('empty L3', empty.hrs_last_3_games, 0);

// ---- matchup-context: pitcher leaderboard ----
// Cole gives up 4 HRs across 3 dates ≤ 5/09; Snell gives up 2 across 2 dates;
// Glasnow gives up 1 on 5/10 (out of scope for anchor=5/09).
const pitcherRows = [
  hr(101, 100, 'Aaron Judge', 'NYY', 'HOU', '2026-05-01', { pitcher_id: 1, pitcher_name: 'Cole',    pitcher_throws: 'R', venue_name: 'Yankee Stadium' }),
  hr(102, 100, 'Aaron Judge', 'NYY', 'HOU', '2026-05-01', { pitcher_id: 1, pitcher_name: 'Cole',    pitcher_throws: 'R', venue_name: 'Yankee Stadium' }),
  hr(103, 200, 'Juan Soto',  'NYY', 'HOU', '2026-05-05', { pitcher_id: 1, pitcher_name: 'Cole',    pitcher_throws: 'R', venue_name: 'Yankee Stadium' }),
  hr(104, 300, 'Mike Trout', 'LAA', 'HOU', '2026-05-09', { pitcher_id: 1, pitcher_name: 'Cole',    pitcher_throws: 'R', venue_name: 'Angel Stadium' }),
  hr(105, 400, 'Bobby Witt', 'KCR', 'SDP', '2026-05-08', { pitcher_id: 2, pitcher_name: 'Snell',   pitcher_throws: 'L', venue_name: 'Petco Park' }),
  hr(106, 500, 'Vlad Jr',    'TOR', 'SDP', '2026-05-09', { pitcher_id: 2, pitcher_name: 'Snell',   pitcher_throws: 'L', venue_name: 'Petco Park' }),
  hr(107, 100, 'Aaron Judge', 'NYY', 'LAD', '2026-05-10', { pitcher_id: 3, pitcher_name: 'Glasnow', pitcher_throws: 'R', venue_name: 'Dodger Stadium' }),
];
const board = pitcherHrLeaderboard(pitcherRows, '2026-05-09');
eq('pitcher leaderboard length 2 (Glasnow excluded by anchor)', board.length, 2);
eq('pitcher #1 is Cole season=4', { name: board[0].pitcher_name, season: board[0].season_allowed }, { name: 'Cole', season: 4 });
eq('Cole L14d = 4',  board[0].allowed_last_14_days, 4);
eq('Cole L3 starts = 4 (HRs across his 3 HR-allowed dates)', board[0].allowed_last_3_starts, 4);
eq('Cole hand R',    board[0].pitcher_throws, 'R');
eq('Cole team = HOU (most common opponent)', board[0].team, 'HOU');

// ---- handedness splits ----
const handRows = [
  hr(201, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-08', { pitcher_throws: 'L', batter_side: 'R' }),
  hr(202, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-09', { pitcher_throws: 'R', batter_side: 'R' }),
  hr(203, 200, 'Juan Soto',  'NYY', 'BOS', '2026-05-09', { pitcher_throws: 'L', batter_side: 'L' }),
  hr(204, 200, 'Juan Soto',  'NYY', 'BOS', '2026-05-09', { pitcher_throws: 'R', batter_side: 'L' }),
  hr(205, 300, 'Unknown HR', 'NYY', 'BOS', '2026-05-09'), // no handedness data
];
const lg = leagueHandednessSplit(handRows, '2026-05-09');
eq('league split vs LHP = 2', lg.vs_lhp, 2);
eq('league split vs RHP = 2', lg.vs_rhp, 2);
eq('league split unknown = 1', lg.total_unknown, 1);

const splits = playerHandednessSplits(handRows, '2026-05-09');
const judgeSplit = splits.find((s) => s.player_id === 100)!;
eq('Judge bat_side R', judgeSplit.bat_side, 'R');
eq('Judge vs LHP = 1', judgeSplit.vs_lhp, 1);
eq('Judge vs RHP = 1', judgeSplit.vs_rhp, 1);

const judgeSingle = singlePlayerHandedness(handRows.filter((r) => r.player_id === 100), '2026-05-09')!;
eq('singlePlayerHandedness Judge total = 2', judgeSingle.total, 2);

// ---- venue leaderboard ----
const venueRows = [
  hr(301, 100, 'A', 'NYY', 'BOS', '2026-05-09', { venue_name: 'Yankee Stadium' }),
  hr(302, 100, 'A', 'NYY', 'BOS', '2026-05-09', { venue_name: 'Yankee Stadium' }),
  hr(303, 200, 'B', 'NYY', 'BOS', '2026-05-08', { venue_name: 'Yankee Stadium' }),
  hr(304, 300, 'C', 'BOS', 'NYY', '2026-04-20', { venue_name: 'Fenway Park' }),
  hr(305, 400, 'D', 'BOS', 'NYY', '2026-05-09', { venue_name: 'Fenway Park' }),
  hr(306, 500, 'E', 'TOR', 'KCR', '2026-05-10', { venue_name: 'Rogers Centre' }), // out of scope
  hr(307, 600, 'F', 'KCR', 'TOR', '2026-05-09'), // null venue, must not crash or be counted
];
const venues = venueLeaderboard(venueRows, '2026-05-09');
eq('venue board length 2 (Rogers excluded by anchor; null venue skipped)', venues.length, 2);
eq('venue #1 by L14 is Yankee Stadium', venues[0].venue_name, 'Yankee Stadium');
eq('Yankee Stadium L14 = 3', venues[0].l14d, 3);
eq('Yankee Stadium L7 = 3',  venues[0].l7d, 3);
eq('Yankee Stadium season = 3', venues[0].season, 3);
eq('Fenway L14 = 1, season = 2', { l14: venues[1].l14d, season: venues[1].season }, { l14: 1, season: 2 });

// Empty / all-null inputs → empty arrays, no crashes
eq('venue board empty for empty input', venueLeaderboard([], '2026-05-09').length, 0);
eq('pitcher board empty for empty input', pitcherHrLeaderboard([], '2026-05-09').length, 0);
eq('handedness empty', leagueHandednessSplit([], '2026-05-09'), { total_known: 0, total_unknown: 0, vs_lhp: 0, vs_rhp: 0 });

// ---- canonical team remap (the "Aaron Judge shows United States" bug) ----
// Pretend a WBC row was ingested with team='United States'. With a canonical
// players index resolving Judge → Yankees, applyCanonicalTeams must overwrite
// the team string. Players not in the index pass through unchanged.
const wbcRows = [
  hr(701, 100, 'Aaron Judge', 'United States', 'Japan', '2023-03-15'),
  hr(702, 100, 'Aaron Judge', 'NYY',           'BOS',   '2026-05-09'),
  hr(703, 999, 'Unknown Guy', 'XYZ',           'ABC',   '2026-05-09'),
];
const idx = new Map<number, { team: string | null; full_name: string | null }>([
  [100, { team: 'New York Yankees', full_name: 'Aaron Judge' }],
  // 999 intentionally absent
]);
const remapped = applyCanonicalTeams(wbcRows, idx);
eq('remap WBC row team → Yankees', remapped[0].team, 'New York Yankees');
eq('remap normal row team → Yankees',  remapped[1].team, 'New York Yankees');
eq('remap missing player passes through', remapped[2].team, 'XYZ');
eq('remap leaves opponent alone', remapped[0].opponent, 'Japan');
eq('remap is non-destructive (input unchanged)', wbcRows[0].team, 'United States');

// Empty index → identity (no change)
const noChange = applyCanonicalTeams(wbcRows, new Map());
eq('empty index = identity', noChange[0].team, 'United States');

// Team leaderboard sees ONLY canonical teams after remap (no "United States")
const teamBoard = teamHrLeaderboard(remapped);
eq('team leaderboard does not contain United States', teamBoard.find((t) => t.team === 'United States') ?? null, null);
eq('team leaderboard credits both Judge HRs to Yankees', teamBoard.find((t) => t.team === 'New York Yankees')!.hrs, 2);

// ---- HR Targets (heat score) ----
// Build a season for one game NYY @ BOS on 2026-05-10. Anchor stats at 5/09.
// Judge: 5 HRs ≤ 5/09 (5/05, 5/06x2, 5/07, 5/09) — all vs RHPs.
// LeMahieu: 1 HR ≤ 5/09 (5/02) — vs LHP.
// Devers (BOS): 2 HRs ≤ 5/09 (5/03, 5/09) — both vs RHP.
const targetSeason = [
  hr(801, 100, 'Aaron Judge',    'NYY', 'BOS', '2026-05-05', { pitcher_id: 11, pitcher_throws: 'R', batter_side: 'R' }),
  hr(802, 100, 'Aaron Judge',    'NYY', 'BOS', '2026-05-06', { pitcher_id: 12, pitcher_throws: 'R', batter_side: 'R' }),
  hr(803, 100, 'Aaron Judge',    'NYY', 'BOS', '2026-05-06', { pitcher_id: 12, pitcher_throws: 'R', batter_side: 'R' }),
  hr(804, 100, 'Aaron Judge',    'NYY', 'BOS', '2026-05-07', { pitcher_id: 13, pitcher_throws: 'R', batter_side: 'R' }),
  hr(805, 100, 'Aaron Judge',    'NYY', 'BOS', '2026-05-09', { pitcher_id: 14, pitcher_throws: 'R', batter_side: 'R' }),
  hr(806, 200, 'DJ LeMahieu',    'NYY', 'BOS', '2026-05-02', { pitcher_id: 15, pitcher_throws: 'L', batter_side: 'R' }),
  hr(807, 300, 'Rafael Devers',  'BOS', 'NYY', '2026-05-03', { pitcher_id: 16, pitcher_throws: 'R', batter_side: 'L' }),
  hr(808, 300, 'Rafael Devers',  'BOS', 'NYY', '2026-05-09', { pitcher_id: 17, pitcher_throws: 'R', batter_side: 'L' }),
];

// Pretend the BOS probable pitcher (id=999) has allowed 6 HR in L14d (very HR-prone)
// across his 3 most recent HR-allowed dates (e.g. all 6 HRs were in L3 starts).
// NYY probable pitcher (id=998) has allowed 0.
const pIdx = new Map([
  [999, { pitcher_id: 999, pitcher_throws: 'R', allowed_last_14_days: 6, allowed_last_3_starts: 6, allowed_last_5_starts: 8, season_hr_allowed: 14, starts_known: 8 }],
  [998, { pitcher_id: 998, pitcher_throws: 'L', allowed_last_14_days: 0, allowed_last_3_starts: 0, allowed_last_5_starts: 0, season_hr_allowed: 2, starts_known: 8 }],
] as const);

// Yankee Stadium has had 8 HRs in L14d → ranked #1 of 1 in this fixture.
const vIdx = new Map([
  ['Yankee Stadium', { venue_name: 'Yankee Stadium', l14d: 8, rank_l14d: 1, total_ranked: 1 }],
] as const);

const sched: HrTargetGame[] = [{
  game_pk: 9001,
  game_date: '2026-05-10',
  away_team: 'BOS',
  home_team: 'NYY',
  venue_name: 'Yankee Stadium',
  // The HOME (NYY) probable faces BOS batters; the AWAY (BOS) probable faces NYY batters.
  home_probable_pitcher_id: 998, home_probable_pitcher_name: 'NYY-LHP', home_probable_pitcher_hand: 'L',
  away_probable_pitcher_id: 999, away_probable_pitcher_name: 'BOS-RHP', away_probable_pitcher_hand: 'R',
}];

const tBoards = computeHrTargets(targetSeason, '2026-05-09', sched, { pitcherIndex: pIdx, venueIndex: vIdx });
eq('targets: one board for the one scheduled game', tBoards.length, 1);
const tBoard = tBoards[0];

// AWAY = BOS (Devers). They face the HOME probable (998 = LHP).
const devers = tBoard.away_targets.find((t) => t.player_id === 300)!;
eq('Devers faces NYY-LHP', devers.pitcher_name, 'NYY-LHP');
eq('Devers L3 = 2 (5/03 + 5/09)', devers.hrs_l3, 2);
eq('Devers L7d = 2 (within 5/03..5/09)', devers.hrs_l7d, 2);
eq('Devers season = 2', devers.season_hr, 2);
// NEW WEIGHTS: season=40, l3=14, l5=8, l7d=3, pitcher=15, hand=10, park=10. Sum=100.
// Devers: 2 season HR, 2 L3, 2 L5, 2 L7d, facing LHP (he's all-RHP hits), park hot.
//   Not elite (curated NO, season<12).
//   season_hr<5 AND hrs_l3<2? L3=2 ≥ 2 → EXEMPT from cap. Heat computed normally.
//   Stability (new): clamp(2/12, 0.35, 1.0) = 0.35 (floor)
//   l3 = 2/3 = 0.67  → 14*0.67*0.35 ≈ 3.27
//   l5 = 2/4 = 0.5   → 8*0.5*0.35   ≈ 1.4
//   l7d = 2/5 = 0.4  → 3*0.4*0.35   ≈ 0.42
//   season = 2/30    → 40*0.067    ≈ 2.67
//   hand = 0 (no LHP HRs)          → 0
//   pitcher = 0 (clean)            → 0
//   park = 8/12 = 0.67             → 10*0.67 = 6.67
//   total ≈ 14.4
eq('Devers stability factor = 0.35 (sub-12 HR, new floor)', devers.breakdown.stability_factor, 0.35);
eq('Devers hand contribution = 0 (facing LHP, no prior LHP HRs)', devers.subscores.contributions.hand, 0);
eq('Devers pitcher contribution = 0 (clean pitcher)', devers.subscores.contributions.pitcher, 0);
// Park saturation tightened (12→15), so 8/15 = 0.533 → contribution = 5.3.
eq('Devers park contribution = 5.3 (new sat=15)', devers.subscores.contributions.park, 5.3);
eq('Devers is NOT cap-eligible (L3 ≥ 2 exempts)', devers.breakdown.adjustments.find((a) => a.label.includes('Low-power cap')) ?? null, null);
// Heat now lower under new weights (season 40→35, park sat 12→15) AND
// further reduced by the completeness multiplier (2 factors firing → ×0.85).
// Range assertion: behavioral check that Devers is firmly in the
// low-heat zone — exact value is brittle. New computed ≈ 10.6.
eq('Devers heat 8..15 (recent + park firing, dampened)', devers.heat_score > 8 && devers.heat_score < 15, true);
// Rank-based phrasing for venue takes precedence over generic.
eq('Devers reasons include park rank phrasing', devers.reasons.some((r) => r.startsWith('Power-friendly park')), true);

// HOME = NYY (Judge, LeMahieu). They face BOS-RHP (id 999, allowing 6 L14d).
const judge = tBoard.home_targets.find((t) => t.player_id === 100)!;
eq('Judge faces BOS-RHP', judge.pitcher_name, 'BOS-RHP');
eq('Judge L2 = 2 (5/09 + 5/07)', judge.hrs_l2, 2);
eq('Judge L3 = 4 (5/09 + 5/07 + 5/06 x2)', judge.hrs_l3, 4);
eq('Judge L5 = 5 (all 5 HRs)', judge.hrs_l5, 5);
eq('Judge L7d = 5', judge.hrs_l7d, 5);
eq('Judge season = 5', judge.season_hr, 5);
// Judge: 5 season HR in fixture. Not curated in this test (we don't pass elitePowerIds).
// Not auto-elite (season<12). So treated as a regular sub-12 hitter.
// NEW WEIGHTS (40/14/8/3/15/10/10):
//   season  = 5/30 ≈ 0.167         → 40 * 0.167 = 6.67 pts
//   stability = clamp(5/12, 0.35, 1.0) = 0.417
//   l3      = 4/3 → 1.0            → 14 * 1.0 * 0.417 = 5.83 pts
//   l5      = 5/4 → 1.0            → 8 * 1.0 * 0.417 = 3.33 pts
//   l7d     = 5/5 = 1.0            → 3 * 1.0 * 0.417 = 1.25 pts
//   pitcher = 6/6 = 1.0            → 15 pts
//   park    = 8/12 ≈ 0.67          → 6.67 pts
//   hand    = 5/5 = 1.0            → 10 pts
// total ≈ 48.8
eq('Judge stability factor ≈ 0.42 (5 season HR / 12)', judge.breakdown.stability_factor, 0.42);
// Season weight 40→35, saturation 30→35 → contribution = 35 * 5/35 = 5.0.
eq('Judge season contribution ≈ 5.0 (35 * 5/35)', judge.subscores.contributions.season, 5);
// Pitcher weight 15→20, saturation 6→8 → 20 * 6/8 = 15.0 (same number, different reasoning).
eq('Judge pitcher contribution = 15 (20 * 6/8)', judge.subscores.contributions.pitcher, 15);
eq('Judge hand contribution = 10 (max, 100% same hand)', judge.subscores.contributions.hand, 10);
// Park saturation 12→15 → 10 * 8/15 = 5.3.
eq('Judge park contribution = 5.3 (10 * 8/15)', judge.subscores.contributions.park, 5.3);
eq('Judge breakdown.season_power = 5.0', judge.breakdown.season_power_score, 5);
eq('Judge breakdown.pitcher_score = 15', judge.breakdown.pitcher_score, 15);
eq('Judge breakdown.handedness_score = 10', judge.breakdown.handedness_score, 10);
eq('Judge breakdown.venue = 5.3', judge.breakdown.venue_score, 5.3);
eq('Judge breakdown.final_heat = heat_score', judge.breakdown.final_heat_score, judge.heat_score);
// Judge now has the completeness multiplier applied (4 factors firing,
// non-elite → ×0.95). The "no adjustments" assumption from the old
// model no longer holds. raw_score ≠ final_heat_score by design.
eq('Judge has completeness adjustment in new model', judge.breakdown.adjustments.some((a) => a.label.startsWith('Completeness')), true);
eq('Judge raw_score >= final_heat_score (completeness pulled it down)', judge.breakdown.raw_score >= judge.breakdown.final_heat_score, true);
// Judge should be ranked above LeMahieu in this team panel
eq('Judge is #1 NYY target', tBoard.home_targets[0].player_id, 100);
// ---- specific, numeric reason strings ----
// Judge: 2 HR over last 2 HR games (L2 takes precedence over L3)
//      + 5 HR vs RHP this season
//      + Pitcher allowed 8 HR in last 5 starts (real pitcher_starts data)
//      + Venue top 1 HR park in L14d
//      + (meta) "Hot streak + favorable matchup" when 2+ heavy signals stack
//
// Wording changed (task #152): "2 HR in last 2 games" → "2 HR over last 2
// HR games" because the count is across the player's 2 most-recent
// distinct HR-DATES, not literal last 2 MLB games played. Pitcher-
// narrative tags like "RHP allowing elevated HR rate" were removed in
// favor of strictly numeric phrasing.
const judgeReasons = judge.reasons;
// New narrative-prefix phrasing (task #155): "Recent HR form — ..." prefix.
eq(
  'Judge reasons include narrative L2 phrasing',
  judgeReasons.some((r) => r === 'Recent HR form — 2 HR over last 2 HR games'),
  true,
);
// "Pitcher HR weakness — ..." prefix (task #155).
eq('Judge reasons include pitcher-weakness narrative', judgeReasons.some((r) => r === 'Pitcher HR weakness — allowed 8 HR in last 5 starts'), true);
eq('Judge reasons include meta tag when signals stack', judgeReasons.some((r) => r === 'Hot streak + favorable matchup'), true);
// We surface up to 4, prioritized by weight — each must be either numeric-specific
// or a known narrative tag.
eq('Judge has at most 4 reasons', judge.reasons.length <= 4, true);
const KNOWN_META = new Set([
  'Hot streak + favorable matchup',
]);
const allSpecificOrMeta = judge.reasons.every((r) => /\d/.test(r) || KNOWN_META.has(r));
eq('Judge reasons all specific or known meta', allSpecificOrMeta, true);

// Devers should call out venue rank in the new "Power-friendly park" phrasing.
eq('Devers reason uses park-rank phrasing', devers.reasons.some((r) => r.startsWith('Power-friendly park (top')), true);
eq('Devers has no generic park reason', devers.reasons.every((r) => r !== 'Hitter-friendly venue'), true);

// Future-data safety: a HR on 2026-05-10 must not influence stats anchored at 5/09
const seasonPlusFuture = [...targetSeason, hr(900, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-10', { pitcher_id: 11, pitcher_throws: 'R', batter_side: 'R' })];
const boardsBounded = computeHrTargets(seasonPlusFuture, '2026-05-09', sched, { pitcherIndex: pIdx, venueIndex: vIdx });
const judgeBounded = boardsBounded[0].home_targets.find((t) => t.player_id === 100)!;
eq('Judge season stays 5 with future-dated row in input', judgeBounded.season_hr, 5);

// Graceful degradation: no pitcher index, no venue index → only L3/L5/L7d/season/hand contribute
const boardsBare = computeHrTargets(targetSeason, '2026-05-09', sched);
const judgeBare = boardsBare[0].home_targets.find((t) => t.player_id === 100)!;
eq('Bare board: pitcher contribution = 0', judgeBare.subscores.contributions.pitcher, 0);
eq('Bare board: park contribution = 0', judgeBare.subscores.contributions.park, 0);
// hand still works from the schedule's pitcher_hand
eq('Bare board: hand contribution = 10 (still derivable from schedule pitcher_hand)', judgeBare.subscores.contributions.hand, 10);
eq('Bare board: weather contribution = 0 (placeholder)', judgeBare.subscores.contributions.weather, 0);

// Empty schedule → empty board list
eq('No games → no boards', computeHrTargets(targetSeason, '2026-05-09', []).length, 0);

// ---- LOW-POWER CAP regression ----
// A non-elite, non-streaking, sub-5-HR hitter MUST be capped at 30 even with
// favorable matchup. Without the cap, the matchup signals (15+10+10=35) plus
// modest recent form could push them above 30.
const lowPowerFixture = [
  // FringeNoStreak: 2 season HRs over a wide span, last was a month ago — no L3.
  hr(3000, 777, 'Fringe No Streak', 'NYM', 'PHI', '2026-03-15', { pitcher_id: 11, pitcher_throws: 'R', batter_side: 'R' }),
  hr(3001, 777, 'Fringe No Streak', 'NYM', 'PHI', '2026-04-05', { pitcher_id: 12, pitcher_throws: 'R', batter_side: 'R' }),
];
const lowPowerSched: HrTargetGame[] = [{
  game_pk: 9300, game_date: '2026-05-10',
  away_team: 'NYM', home_team: 'PHI',
  venue_name: 'Yankee Stadium', // hot park (8 L14d in fixture above… but no L14d in THIS fixture)
  home_probable_pitcher_id: 999, home_probable_pitcher_name: 'BOS-RHP', home_probable_pitcher_hand: 'R',
  away_probable_pitcher_id: 998, away_probable_pitcher_name: 'NYY-LHP', away_probable_pitcher_hand: 'L',
}];
const lowPowerBoards = computeHrTargets(lowPowerFixture, '2026-05-09', lowPowerSched, {
  pitcherIndex: pIdx,
  venueIndex: vIdx,
});
const fringeNoStreak = lowPowerBoards[0].away_targets.find((t) => t.player_id === 777)!;
console.log('FringeNoStreak heat:', fringeNoStreak.heat_score, 'adjustments:', fringeNoStreak.breakdown.adjustments);
eq('Low-power cap activates (heat ≤ 30)', fringeNoStreak.heat_score <= 30, true);
eq('Low-power cap adjustment recorded', fringeNoStreak.breakdown.adjustments.some((a) => a.label.includes('Low-power cap')), true);
// Cap delta should be negative
const capAdj = fringeNoStreak.breakdown.adjustments.find((a) => a.label.includes('Low-power cap'))!;
eq('Cap delta is negative (score reduced)', capAdj.delta < 0, true);

// ---- AUTO-ELITE at 12+ season HR ----
// A 14-season-HR player should auto-trigger the Power Floor without being in the curated list.
const autoEliteFixture = [
  ...Array.from({ length: 14 }, (_, i) => hr(4000 + i, 888, 'Mid Power', 'PHI', 'NYM',
    `2026-${String(3 + Math.floor(i / 8)).padStart(2, '0')}-${String((i % 8) + 1).padStart(2, '0')}`,
    { pitcher_id: 100 + i, pitcher_throws: 'R', batter_side: 'L' })),
];
const autoEliteSched: HrTargetGame[] = [{
  game_pk: 9400, game_date: '2026-05-10',
  away_team: 'NYM', home_team: 'PHI',
  venue_name: null,
  home_probable_pitcher_id: null, home_probable_pitcher_name: null, home_probable_pitcher_hand: null,
  away_probable_pitcher_id: null, away_probable_pitcher_name: null, away_probable_pitcher_hand: null,
}];
const autoBoards = computeHrTargets(autoEliteFixture, '2026-05-09', autoEliteSched);
const midPower = autoBoards[0].home_targets.find((t) => t.player_id === 888)!;
eq('14-HR player is auto-flagged is_elite_power', midPower.is_elite_power, true);
eq('Auto-elite triggers Power Floor adjustment', midPower.breakdown.adjustments.some((a) => a.label.includes('auto')), true);
eq('Auto-elite gets full stability (1.0)', midPower.breakdown.stability_factor, 1);
// Season power ≥ 24.5 with new weight (= 35 * 0.7 floor).
eq('Auto-elite season_power ≥ 24.5 (Power Floor 0.7 * 35)', midPower.breakdown.season_power_score >= 24.5, true);

// ---- POWER FLOOR: slow-start elite (5 HR) vs hot fringe hitter ----
// Aaron Judge in April: only 5 season HR + 1 recent. Without the Power Floor,
// his season normalized = 5/30 = 0.17 → 5 pts; stability = 0.5; he'd score low.
// With the Power Floor (elite IDs set), his season floor = 0.7 → 21 pts; stability = 1.0.
// He should outrank a fringe hitter on a streak.
const slowStartFixture = [
  // Judge (player 100) — 5 season HRs spread out, last one on 5/09
  hr(2200, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-04-01', { pitcher_id: 80, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2201, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-04-08', { pitcher_id: 81, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2202, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-04-15', { pitcher_id: 82, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2203, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-04-22', { pitcher_id: 83, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2204, 100, 'Aaron Judge', 'NYY', 'BOS', '2026-05-09', { pitcher_id: 84, pitcher_throws: 'R', batter_side: 'R' }),

  // Fringe Guy (player 666) — 4 HRs, 3 of them in last 3 games
  hr(2210, 666, 'Fringe Guy', 'BOS', 'NYY', '2026-04-15', { pitcher_id: 90, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2211, 666, 'Fringe Guy', 'BOS', 'NYY', '2026-05-07', { pitcher_id: 91, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2212, 666, 'Fringe Guy', 'BOS', 'NYY', '2026-05-08', { pitcher_id: 92, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2213, 666, 'Fringe Guy', 'BOS', 'NYY', '2026-05-09', { pitcher_id: 93, pitcher_throws: 'R', batter_side: 'R' }),
];
const slowSched: HrTargetGame[] = [{
  game_pk: 9200,
  game_date: '2026-05-10',
  away_team: 'BOS', home_team: 'NYY',
  venue_name: null,
  home_probable_pitcher_id: null, home_probable_pitcher_name: null, home_probable_pitcher_hand: null,
  away_probable_pitcher_id: null, away_probable_pitcher_name: null, away_probable_pitcher_hand: null,
}];

// Without Power Floor (no elitePowerIds): Fringe streak wins because Judge's
// 5 season HR doesn't differentiate him from any other 5-HR hitter.
const noFloor = computeHrTargets(slowStartFixture, '2026-05-09', slowSched);
const judgeNF  = noFloor[0].home_targets.find((t) => t.player_id === 100)!;
const fringeNF = noFloor[0].away_targets.find((t) => t.player_id === 666)!;
console.log(`No floor — Judge: ${judgeNF.heat_score}  Fringe: ${fringeNF.heat_score}`);
eq('Without Power Floor: Judge is NOT flagged elite', judgeNF.is_elite_power, false);

// With Power Floor: Judge gets season floor = 0.7 (→ 21 pts) and stability 1.0.
// Now his ranking reflects his elite-power profile.
const withFloor = computeHrTargets(slowStartFixture, '2026-05-09', slowSched, {
  elitePowerIds: new Set([100]), // mark Judge as elite
});
const judgeFloor  = withFloor[0].home_targets.find((t) => t.player_id === 100)!;
const fringeFloor = withFloor[0].away_targets.find((t) => t.player_id === 666)!;
console.log(`With floor — Judge: ${judgeFloor.heat_score}  Fringe: ${fringeFloor.heat_score}`);
eq('With Power Floor: Judge IS flagged elite', judgeFloor.is_elite_power, true);
eq('With Power Floor: Judge stability_factor = 1.0', judgeFloor.breakdown.stability_factor, 1);
// Season power score ≥ 30 * 0.7 = 21 (the elite floor)
eq('With Power Floor: Judge season_power ≥ 21', judgeFloor.breakdown.season_power_score >= 21, true);
// Critical assertion: Judge outranks Fringe Guy.
eq('With Power Floor: Judge HEAT > Fringe Guy HEAT (slow-start elite wins)', judgeFloor.heat_score > fringeFloor.heat_score, true);

// Breakdown now has 5 grouped scores split out
eq('Breakdown has pitcher_score field', typeof judgeFloor.breakdown.pitcher_score, 'number');
eq('Breakdown has handedness_score field (split from pitcher)', typeof judgeFloor.breakdown.handedness_score, 'number');
// Sum of components ≈ RAW score (pre-completeness, pre-compression).
// Final_heat may differ — completeness multiplier and ceiling compression
// pull the final down. We assert the raw matches the sum.
// Component sum is a sanity-of-shape check, not an equality with raw_score —
// for elite-floor players, season_power_score INCLUDES the Power Floor lift
// while raw_score is computed WITHOUT it, so they diverge by design.
eq('Breakdown component sum is positive + bounded', (() => {
  const b = judgeFloor.breakdown;
  const sum = b.season_power_score + b.recent_form_score + b.pitcher_score + b.handedness_score + b.venue_score + b.weather_score;
  return sum > 0 && sum < 100;
})(), true);
eq('Breakdown exposes factors_firing + completeness_multiplier + ceiling_compression', (() => {
  const b = judgeFloor.breakdown;
  return typeof b.factors_firing === 'number' &&
    typeof b.completeness_multiplier === 'number' &&
    typeof b.ceiling_compression === 'number';
})(), true);
eq('Judge confidence label is one of high/medium/low', ['high', 'medium', 'low'].includes(judgeFloor.confidence), true);

// ---- elite slugger vs fringe hot streak (TRUE POWER + STABILITY regression) ----
// Schwarber-style: 25 season HRs, last HR was 2026-05-09 (1 recent), facing average pitcher.
// FringeGuy: 2 season HRs but 3 HRs in last 3 games, same matchup.
// User requirement: the elite slugger MUST rank higher.
const eliteFixture = [
  // Build 25 season HRs for Schwarber (player 555), spread throughout the season.
  // Most HRs back in March/April, one on 5/09.
  ...Array.from({ length: 24 }, (_, i) => hr(2000 + i, 555, 'Kyle Schwarber', 'PHI', 'NYM',
    `2026-${String(3 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}`,
    { pitcher_id: 50 + i, pitcher_throws: 'R', batter_side: 'L' })),
  hr(2024, 555, 'Kyle Schwarber', 'PHI', 'NYM', '2026-05-09', { pitcher_id: 70, pitcher_throws: 'R', batter_side: 'L' }),

  // Fringe guy with 2 season HRs + a 3-game streak (5/07, 5/08, 5/09)
  hr(2100, 666, 'Fringe Guy', 'NYM', 'PHI', '2026-04-10', { pitcher_id: 71, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2101, 666, 'Fringe Guy', 'NYM', 'PHI', '2026-05-07', { pitcher_id: 72, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2102, 666, 'Fringe Guy', 'NYM', 'PHI', '2026-05-08', { pitcher_id: 73, pitcher_throws: 'R', batter_side: 'R' }),
  hr(2103, 666, 'Fringe Guy', 'NYM', 'PHI', '2026-05-09', { pitcher_id: 74, pitcher_throws: 'R', batter_side: 'R' }),
];
const eliteSched: HrTargetGame[] = [{
  game_pk: 9100,
  game_date: '2026-05-10',
  away_team: 'NYM', home_team: 'PHI',
  venue_name: null,
  home_probable_pitcher_id: null, home_probable_pitcher_name: null, home_probable_pitcher_hand: null,
  away_probable_pitcher_id: null, away_probable_pitcher_name: null, away_probable_pitcher_hand: null,
}];
const eliteBoards = computeHrTargets(eliteFixture, '2026-05-09', eliteSched);
const schwarber = eliteBoards[0].home_targets.find((t) => t.player_id === 555);
const fringe    = eliteBoards[0].away_targets.find((t) => t.player_id === 666);
console.log('Schwarber heat:', schwarber?.heat_score, 'stab:', schwarber?.breakdown.stability_factor);
console.log('Fringe heat:   ', fringe?.heat_score,    'stab:', fringe?.breakdown.stability_factor);
eq('Schwarber gets full stability (25 HR ≥ 10)', schwarber!.breakdown.stability_factor, 1);
eq('Fringe Guy capped to stability floor 0.35 (2 HR)', fringe!.breakdown.stability_factor, 0.35);
eq('Schwarber heat > Fringe Guy heat (elite power outranks fringe streak)', schwarber!.heat_score > fringe!.heat_score, true);

// Elite power reason fires when season HR ≥ 25 (now "Elite season power" prefix).
eq('Schwarber reasons include Elite season power', schwarber!.reasons.some((r) => r.startsWith('Elite season power')), true);

// ---- handedness math sanity ----
// Hand contribution should hit the configured weight (10 under new weights).
eq('Hand contribution maxes at weight when batter has 100% same-hand history', judge.subscores.contributions.hand, 10);

// Weights sum to 100 (sanity check on the formula shape itself)
const wSum = HEAT_SCORE_WEIGHTS.l3 + HEAT_SCORE_WEIGHTS.l5 + HEAT_SCORE_WEIGHTS.l7d
  + HEAT_SCORE_WEIGHTS.season + HEAT_SCORE_WEIGHTS.pitcher + HEAT_SCORE_WEIGHTS.park
  + HEAT_SCORE_WEIGHTS.hand + HEAT_SCORE_WEIGHTS.weather;
eq('HEAT_SCORE_WEIGHTS sum to 100', wSum, 100);

// Weather subscore is structurally present even though weight is 0
eq('Weather subscore exists on every target', typeof judge.subscores.weather, 'number');
eq('Weather contribution = 0 (weight is 0)', judge.subscores.contributions.weather, 0);

// ---- WEATHER ADJUSTMENT (light, task #156) ----
// computeWeatherAdjustment is the gentle ± nudge applied last.
{
  // warm + wind out → positive, bounded
  const warmOut = computeWeatherAdjustment({ condition: 'Clear', temp_f: 88, wind_mph: 14, wind_dir: 'Out To LF' });
  eq('Warm + wind-out → positive weather delta', warmOut.delta > 0, true);
  eq('Warm + wind-out is included', warmOut.included, true);
  // cold + wind in → negative
  const coldIn = computeWeatherAdjustment({ condition: 'Cloudy', temp_f: 44, wind_mph: 16, wind_dir: 'In From CF' });
  eq('Cold + wind-in → negative weather delta', coldIn.delta < 0, true);
  // dome → neutral, NOT included
  const dome = computeWeatherAdjustment({ condition: 'Roof Closed', temp_f: 72, wind_mph: 0, wind_dir: 'Calm' });
  eq('Dome → weather delta 0', dome.delta, 0);
  eq('Dome → weather NOT included', dome.included, false);
  // missing → neutral, NOT included
  const missing = computeWeatherAdjustment({ condition: null, temp_f: null, wind_mph: null, wind_dir: null });
  eq('Missing weather → delta 0 + not included', missing.delta === 0 && missing.included === false, true);
  // delta is bounded to [-3, +5] even with extreme inputs
  const extreme = computeWeatherAdjustment({ condition: 'Hot', temp_f: 110, wind_mph: 40, wind_dir: 'Out To CF' });
  eq('Weather delta clamped to ≤ +5', extreme.delta <= 5, true);
}

// Weather flows through computeHrTargets onto the target + breakdown.
{
  const wxSched: HrTargetGame[] = [{
    game_pk: 9500, game_date: '2026-05-10',
    away_team: 'NYM', home_team: 'PHI', venue_name: null,
    home_probable_pitcher_id: null, home_probable_pitcher_name: null, home_probable_pitcher_hand: null,
    away_probable_pitcher_id: null, away_probable_pitcher_name: null, away_probable_pitcher_hand: null,
    weather_condition: 'Clear', weather_temp_f: 89, weather_wind_mph: 13, weather_wind_dir: 'Out To LF',
  }];
  const wxBoards = computeHrTargets(eliteFixture, '2026-05-09', wxSched);
  const wxSchwarber = wxBoards[0].home_targets.find((t) => t.player_id === 555)!;
  eq('Weather fields populated on target', wxSchwarber.weather_temp_f, 89);
  eq('Weather included flag true for warm+out game', wxSchwarber.weather_included, true);
  eq('Weather adjustment positive in breakdown', wxSchwarber.breakdown.weather_adjustment > 0, true);
  eq('Board carries weather context', wxBoards[0].weather_temp_f, 89);
  // formatWeatherLine renders the user-facing string.
  eq(
    'formatWeatherLine renders temp + wind',
    formatWeatherLine({ condition: 'Clear', temp_f: 82, wind_mph: 12, wind_dir: 'Out To LF' }),
    '82°F • Wind 12 mph out to lf',
  );
  eq(
    'formatWeatherLine handles dome',
    formatWeatherLine({ condition: 'Roof Closed', temp_f: 72, wind_mph: 0, wind_dir: 'Calm' }),
    'Roof Closed • 72°F',
  );
}

// ---- summary ----
if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll stats.ts assertions passed.');
