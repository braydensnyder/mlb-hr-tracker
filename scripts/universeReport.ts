/**
 * Universe validation report — reads `hr_target_universe` for a given
 * date and prints the 12-point audit the user asked for plus rank
 * buckets and spot-check tables.
 *
 * Run:  npm run universe:report            # today (mlbToday)
 *       npm run universe:report 2026-08-10 # explicit date
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { mlbToday } from './lib/mlbDate.js';

interface UniverseRow {
  id: number;
  target_date: string;
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
  game_pk: number | null;
  global_rank: number;
  team_rank: number;
  heat_score: number;
  lineup_status: string;
  subscores_json: Record<string, unknown> & { season?: number };
  signals_json: Record<string, boolean>;
  flags: string[];
  reason: string | null;
  american_odds: number | null;
}

interface GameRow {
  game_pk: number;
  home_team: string;
  away_team: string;
  home_lineup: number[] | null;
  away_lineup: number[] | null;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : ((100 * part) / whole).toFixed(1) + '%';
}

async function main() {
  const arg = process.argv[2];
  const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : mlbToday();
  console.log(`\n═══ hr_target_universe report — ${date} ═══\n`);

  // 1) Games / teams --------------------------------------------------
  const { data: gamesData, error: gamesErr } = await supabaseAdmin
    .from('games')
    .select('game_pk, home_team, away_team, home_lineup, away_lineup')
    .eq('game_date', date);
  if (gamesErr) throw new Error(`games fetch: ${gamesErr.message}`);
  const games = (gamesData ?? []) as GameRow[];

  const teamsScheduled = new Set<string>();
  const lineupPlayerIds = new Set<number>();
  for (const g of games) {
    teamsScheduled.add(g.home_team);
    teamsScheduled.add(g.away_team);
    if (Array.isArray(g.home_lineup)) for (const pid of g.home_lineup) lineupPlayerIds.add(pid);
    if (Array.isArray(g.away_lineup)) for (const pid of g.away_lineup) lineupPlayerIds.add(pid);
  }

  // 2-12) Universe rows ----------------------------------------------
  const { data: uniData, error: uniErr } = await supabaseAdmin
    .from('hr_target_universe')
    .select('id, target_date, player_id, player_name, team, opponent, game_pk, global_rank, team_rank, heat_score, lineup_status, subscores_json, signals_json, flags, reason, american_odds')
    .eq('target_date', date)
    .eq('model_version', 1)
    .order('global_rank', { ascending: true });
  if (uniErr) {
    if (/does not exist|schema cache/i.test(uniErr.message)) {
      console.error(`✗ hr_target_universe table does not exist — apply migration 018 first.`);
      process.exit(2);
    }
    throw new Error(`universe fetch: ${uniErr.message}`);
  }
  const rows = (uniData ?? []) as UniverseRow[];

  if (rows.length === 0) {
    console.error(`✗ No universe rows for ${date}. Run \`npm run snapshot:today\` first (or the appropriate snapshot command for this date).`);
    process.exit(2);
  }

  const confirmed = rows.filter((r) => r.lineup_status === 'confirmed');
  const pending = rows.filter((r) => r.lineup_status === 'pending');
  const unknown = rows.filter((r) => r.lineup_status === 'unknown');
  const notStarting = rows.filter((r) => r.lineup_status === 'not_starting');
  const postponed = rows.filter((r) => r.lineup_status === 'postponed');

  const inLineup = rows.filter((r) => lineupPlayerIds.has(r.player_id));
  const historyOnly = rows.filter((r) => !lineupPlayerIds.has(r.player_id));

  const zeroSeasonStarters = rows.filter((r) => {
    const season = Number(r.subscores_json?.season ?? 0);
    return (r.lineup_status === 'confirmed' || r.lineup_status === 'pending') && season === 0;
  });

  // Duplicate detection
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.player_id}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);

  // Contiguity checks
  let firstGap = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.global_rank !== i + 1) { firstGap = i; break; }
  }
  let maxTeamRank = 0;
  const teamRanksByTeam = new Map<string, number[]>();
  for (const r of rows) {
    if (r.team_rank > maxTeamRank) maxTeamRank = r.team_rank;
    const arr = teamRanksByTeam.get(r.team) ?? [];
    arr.push(r.team_rank);
    teamRanksByTeam.set(r.team, arr);
  }
  let teamRankIssues = 0;
  for (const arr of teamRanksByTeam.values()) {
    arr.sort((a, b) => a - b);
    for (let i = 0; i < arr.length; i++) if (arr[i] !== i + 1) { teamRankIssues++; break; }
  }

  // -------------------- 12-point audit --------------------
  console.log('── Foundation audit ──');
  console.log(`  1.  Scheduled games:            ${games.length}   (${teamsScheduled.size} teams)`);
  console.log(`  2.  Total unique candidates:    ${rows.length}`);
  console.log(`  3.  Confirmed starters:         ${confirmed.length}   (${pct(confirmed.length, rows.length)})`);
  console.log(`  4.  Pending:                    ${pending.length}   (${pct(pending.length, rows.length)})`);
  console.log(`      Unknown:                    ${unknown.length}`);
  console.log(`      Not starting (bench/rest):  ${notStarting.length}`);
  console.log(`      Postponed:                  ${postponed.length}`);
  console.log(`  5.  Sourced from lineup data:   ${inLineup.length}   (${pct(inLineup.length, rows.length)})`);
  console.log(`  6.  Sourced only from HR hist:  ${historyOnly.length}   (${pct(historyOnly.length, rows.length)})`);
  console.log(`  7.  Zero-season-HR starters:    ${zeroSeasonStarters.length}   (confirmed+pending, season subscore=0)`);
  console.log(`  8.  Scored:                     ${rows.length}   (all persisted rows carry a heat_score)`);
  console.log(`  9.  Persisted:                  ${rows.length}`);
  console.log(` 10.  Highest team_rank observed: ${maxTeamRank}   ${maxTeamRank >= 9 ? '✓ (rank 9+ preserved — old cap is gone)' : '⚠ (still ≤8 — either small slate or cap still active)'}`);
  console.log(` 11.  Duplicate players:          ${dupes.length}   ${dupes.length === 0 ? '✓' : '⚠'}`);
  if (dupes.length > 0) {
    for (const [pid, n] of dupes.slice(0, 5)) console.log(`         pid ${pid} × ${n}`);
  }
  console.log(` 12.  Global rank contiguity:     ${firstGap === -1 ? '✓ contiguous 1..' + rows.length : `⚠ break at index ${firstGap} (has rank ${rows[firstGap]!.global_rank}, expected ${firstGap + 1})`}`);
  console.log(`      Team-rank contiguity:       ${teamRankIssues === 0 ? '✓ all teams contiguous 1..K' : `⚠ ${teamRankIssues} team(s) non-contiguous`}`);

  // -------------------- Rank buckets --------------------
  console.log(`\n── Rank buckets ──`);
  const bucketSpecs: Array<{ label: string; lo: number; hi: number }> = [
    { label: '1-10',    lo: 1,   hi: 10 },
    { label: '11-25',   lo: 11,  hi: 25 },
    { label: '26-50',   lo: 26,  hi: 50 },
    { label: '51-100',  lo: 51,  hi: 100 },
    { label: '101-150', lo: 101, hi: 150 },
    { label: '151+',    lo: 151, hi: Number.POSITIVE_INFINITY },
  ];
  console.log(`  ${'bucket'.padEnd(9)}  ${'count'.padStart(6)}  ${'confirmed'.padStart(10)}  ${'pending'.padStart(8)}  ${'not_start'.padStart(10)}  ${'avg_heat'.padStart(9)}`);
  for (const b of bucketSpecs) {
    const inB = rows.filter((r) => r.global_rank >= b.lo && r.global_rank <= b.hi);
    if (inB.length === 0) {
      console.log(`  ${b.label.padEnd(9)}  ${'0'.padStart(6)}  ${'-'.padStart(10)}  ${'-'.padStart(8)}  ${'-'.padStart(10)}  ${'-'.padStart(9)}`);
      continue;
    }
    const cf = inB.filter((r) => r.lineup_status === 'confirmed').length;
    const pn = inB.filter((r) => r.lineup_status === 'pending').length;
    const ns = inB.filter((r) => r.lineup_status === 'not_starting').length;
    const avgHeat = inB.reduce((s, r) => s + Number(r.heat_score), 0) / inB.length;
    console.log(`  ${b.label.padEnd(9)}  ${String(inB.length).padStart(6)}  ${String(cf).padStart(10)}  ${String(pn).padStart(8)}  ${String(ns).padStart(10)}  ${avgHeat.toFixed(2).padStart(9)}`);
  }

  // -------------------- Bottom of the universe --------------------
  console.log(`\n── Bottom of the universe (last 8) ──`);
  const bottom = rows.slice(-8);
  console.log(`  ${'g_rank'.padStart(6)}  ${'t_rank'.padStart(6)}  ${'team'.padEnd(4)}  ${'heat'.padStart(6)}  ${'status'.padEnd(13)}  ${'player'}`);
  for (const r of bottom) {
    console.log(`  ${String(r.global_rank).padStart(6)}  ${String(r.team_rank).padStart(6)}  ${r.team.padEnd(4)}  ${Number(r.heat_score).toFixed(1).padStart(6)}  ${r.lineup_status.padEnd(13)}  ${r.player_name}`);
  }

  // -------------------- Rank 9+ within-team spot check --------------
  const rank9Plus = rows.filter((r) => r.team_rank >= 9)
    .sort((a, b) => (a.team.localeCompare(b.team)) || (a.team_rank - b.team_rank))
    .slice(0, 15);
  console.log(`\n── Rank 9+ per team (proof the old 8-cap is gone; first 15) ──`);
  if (rank9Plus.length === 0) {
    console.log(`  ⚠ zero rank 9+ rows — either the cap is still on, or every team truly has ≤8 candidates.`);
  } else {
    console.log(`  ${'team'.padEnd(4)}  ${'t_rank'.padStart(6)}  ${'g_rank'.padStart(6)}  ${'heat'.padStart(6)}  ${'status'.padEnd(13)}  ${'player'}`);
    for (const r of rank9Plus) {
      console.log(`  ${r.team.padEnd(4)}  ${String(r.team_rank).padStart(6)}  ${String(r.global_rank).padStart(6)}  ${Number(r.heat_score).toFixed(1).padStart(6)}  ${r.lineup_status.padEnd(13)}  ${r.player_name}`);
    }
  }

  // -------------------- Team-size distribution -------------------------
  const teamSizes = [...teamRanksByTeam.entries()]
    .map(([team, arr]) => ({ team, size: arr.length }))
    .sort((a, b) => b.size - a.size);
  console.log(`\n── Candidates per team (top 5 largest / bottom 3 smallest) ──`);
  for (const t of teamSizes.slice(0, 5)) console.log(`  ${t.team.padEnd(4)}  ${t.size}`);
  console.log(`  ...`);
  for (const t of teamSizes.slice(-3)) console.log(`  ${t.team.padEnd(4)}  ${t.size}`);

  console.log(`\n═══ end of report ═══\n`);
}

main().catch((e) => {
  console.error(`\n✗ report failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
