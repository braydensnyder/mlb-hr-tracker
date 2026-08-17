/**
 * runBackfillBattingLines — retroactively populate player_batting_lines
 * for every FINAL game in a date range by re-fetching the live feed.
 *
 * Usage:
 *   npm run backfill:batting-lines                      # print scope report only
 *   npm run backfill:batting-lines -- --scope           # same, explicit
 *   npm run backfill:batting-lines -- --from 2026-04-01 --to 2026-08-11
 *   npm run backfill:batting-lines -- --last 14
 *   npm run backfill:batting-lines -- --from D1 --to D2 --skip-existing
 *   npm run backfill:batting-lines -- --from D1 --to D2 --delay-ms 800
 *
 * Idempotency: --skip-existing (default: on) skips any (target_date,
 * game_pk) pair that already has at least one batting_line row. Turn
 * it OFF with --no-skip-existing to force a re-extraction.
 *
 * Rate limiting: default 500ms between game-feed fetches. MLB is
 * tolerant but courteous. A full 30-day backfill (~400 games) takes
 * ~4 minutes at defaults. A full regular season (~2430 games) is
 * ~20-25 minutes.
 *
 * Reuses the exact same fetchGameFeed + extractBattingLines path
 * processDate uses live — so if it works for today's ingest, it works
 * for backfill. Failures on individual games are logged but never
 * abort the whole run.
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { extractBattingLines } from './extractBattingLines.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

interface Args {
  from: string;
  to: string;
  skipExisting: boolean;
  delayMs: number;
  scopeOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const today = mlbToday();
  let from = '', to = today, delayMs = 500, last: number | null = null;
  let skipExisting = true;
  let scopeOnly = argv.length === 0 || argv.includes('--scope');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--delay-ms') delayMs = Number(argv[++i]);
    else if (a === '--skip-existing') skipExisting = true;
    else if (a === '--no-skip-existing') skipExisting = false;
    else if (a === '--scope') scopeOnly = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; scopeOnly = false; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (last != null && !from) { from = mlbAddDays(to, -(last - 1)); scopeOnly = false; }
  if (!from) from = to;
  if (from > to) throw new Error(`--from (${from}) > --to (${to})`);
  return { from, to, skipExisting, delayMs, scopeOnly };
}

async function scopeReport(): Promise<void> {
  console.log(`\n═══ Backfill scope report ═══`);

  // How far back do we have GAMES rows at all?
  const { data: minRow, error: minErr } = await supabaseAdmin
    .from('games')
    .select('game_date')
    .order('game_date', { ascending: true })
    .limit(1);
  if (minErr) throw new Error(`games min: ${minErr.message}`);
  const earliestGamesDate = minRow?.[0]?.game_date ?? null;

  const { data: maxRow, error: maxErr } = await supabaseAdmin
    .from('games')
    .select('game_date')
    .order('game_date', { ascending: false })
    .limit(1);
  if (maxErr) throw new Error(`games max: ${maxErr.message}`);
  const latestGamesDate = maxRow?.[0]?.game_date ?? null;

  // Final-game count in the covered range (candidates for backfill).
  const { count: totalFinalGames } = await supabaseAdmin
    .from('games')
    .select('game_pk', { count: 'exact', head: true })
    .eq('status', 'Final');

  // Existing batting-line coverage.
  const { count: existingBattingLines } = await supabaseAdmin
    .from('player_batting_lines')
    .select('id', { count: 'exact', head: true });

  const { data: minBl } = await supabaseAdmin
    .from('player_batting_lines')
    .select('target_date')
    .order('target_date', { ascending: true }).limit(1);
  const earliestBattingDate = minBl?.[0]?.target_date ?? null;

  const { data: maxBl } = await supabaseAdmin
    .from('player_batting_lines')
    .select('target_date')
    .order('target_date', { ascending: false }).limit(1);
  const latestBattingDate = maxBl?.[0]?.target_date ?? null;

  const { data: distinctGamesWithLines } = await supabaseAdmin
    .from('player_batting_lines')
    .select('game_pk')
    .limit(50000); // generous cap; only need distinct count
  const distinctGamesCovered = new Set((distinctGamesWithLines ?? []).map((r: any) => r.game_pk)).size;

  console.log(`\n  games table:`);
  console.log(`    earliest game_date: ${earliestGamesDate ?? '(none)'}`);
  console.log(`    latest game_date:   ${latestGamesDate ?? '(none)'}`);
  console.log(`    Final-status games total: ${totalFinalGames ?? 0}`);
  console.log(`\n  player_batting_lines table:`);
  console.log(`    total rows: ${existingBattingLines ?? 0}`);
  console.log(`    distinct games covered: ${distinctGamesCovered}`);
  console.log(`    earliest target_date: ${earliestBattingDate ?? '(none)'}`);
  console.log(`    latest target_date:   ${latestBattingDate ?? '(none)'}`);

  console.log(`\n  Backfill horizon:`);
  console.log(`    We can backfill batting lines for any FINAL game whose game_pk exists in the`);
  console.log(`    'games' table. Effective range: ${earliestGamesDate ?? '?'} through ${latestGamesDate ?? '?'}.`);
  console.log(`    To go further back, first run fetchSchedule for older dates to add those games.`);
  console.log(`    MLB Stats API serves /v1.1/game/{pk}/feed/live for historical games with no known`);
  console.log(`    hard retention limit for regular season games — the practical cap is our own`);
  console.log(`    games-table coverage.`);
  console.log(`\n  Approx cost: ~500ms per game (default delay). 400 games ≈ 4 minutes.\n`);
  console.log(`  To run:`);
  console.log(`    npm run backfill:batting-lines -- --from ${earliestGamesDate ?? '2026-04-01'} --to ${latestGamesDate ?? mlbToday()}`);
  console.log(`  Or just recent history:`);
  console.log(`    npm run backfill:batting-lines -- --last 30\n`);
}

function sleep(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

interface GameSlim { game_pk: number; game_date: string; status: string; }

async function loadFinalGamesInRange(from: string, to: string): Promise<GameSlim[]> {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('game_pk, game_date, status')
    .gte('game_date', from)
    .lte('game_date', to)
    .eq('status', 'Final')
    .order('game_date', { ascending: true })
    .order('game_pk', { ascending: true });
  if (error) throw new Error(`games range: ${error.message}`);
  return (data ?? []) as GameSlim[];
}

async function existingGamePksInRange(from: string, to: string): Promise<Set<number>> {
  const s = new Set<number>();
  const PAGE = 1000;
  for (let page = 0; page < 100; page++) {
    const { data, error } = await supabaseAdmin
      .from('player_batting_lines')
      .select('game_pk')
      .gte('target_date', from)
      .lte('target_date', to)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return s;
      throw new Error(`existing batting-lines: ${error.message}`);
    }
    const rows = (data ?? []) as { game_pk: number }[];
    for (const r of rows) s.add(r.game_pk);
    if (rows.length < PAGE) break;
  }
  return s;
}

async function backfill(args: Args) {
  console.log(`\n═══ Backfill batting lines ═══`);
  console.log(`  range: ${args.from} .. ${args.to} · skipExisting=${args.skipExisting} · delayMs=${args.delayMs}`);

  const games = await loadFinalGamesInRange(args.from, args.to);
  console.log(`  Final games in range: ${games.length}`);
  if (games.length === 0) return;

  const already = args.skipExisting ? await existingGamePksInRange(args.from, args.to) : new Set<number>();
  console.log(`  already covered: ${already.size}`);

  const todo = games.filter((g) => !already.has(g.game_pk));
  console.log(`  to fetch: ${todo.length}\n`);

  let totalLines = 0, gamesOk = 0, gamesFailed = 0;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i++) {
    const g = todo[i];
    try {
      const feed = await fetchGameFeed(g.game_pk);
      const lines = extractBattingLines(feed);
      if (lines.length > 0) {
        const { error, count } = await supabaseAdmin
          .from('player_batting_lines')
          .upsert(lines, { onConflict: 'target_date,game_pk,player_id', count: 'exact' });
        if (error) throw new Error(error.message);
        totalLines += count ?? lines.length;
      }
      gamesOk++;
      if ((i + 1) % 25 === 0 || i === todo.length - 1) {
        const elapsed = (Date.now() - t0) / 1000;
        const rate = (i + 1) / elapsed;
        const remaining = todo.length - (i + 1);
        const eta = rate > 0 ? Math.round(remaining / rate) : 0;
        console.log(`  [${i + 1}/${todo.length}] ${g.game_date} pk=${g.game_pk} · ok=${gamesOk} fail=${gamesFailed} · rows=${totalLines} · ${rate.toFixed(1)}g/s · ETA ${eta}s`);
      }
    } catch (e) {
      gamesFailed++;
      const m = e instanceof Error ? e.message : String(e);
      console.warn(`  [${i + 1}/${todo.length}] ${g.game_date} pk=${g.game_pk} FAILED: ${m}`);
    }
    if (i < todo.length - 1) await sleep(args.delayMs);
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n═══ done — ${gamesOk} game(s) ok, ${gamesFailed} failed, ${totalLines} batting-line rows in ${dur}s ═══\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.scopeOnly) {
    await scopeReport();
  } else {
    await backfill(args);
  }
}

main().catch((err) => {
  console.error(`[backfill:batting-lines] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
