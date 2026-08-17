/**
 * diagnosePlatoonCoverage — read-only report on why platoon splits
 * are (or aren't) getting populated in the Hits summary.
 *
 * Inspects player_batting_lines directly, categorises every row by
 * whether it has:
 *   - opposing_starter_id populated
 *   - opposing_starter_hand populated
 * and checks whether missing hands can be safely resolved from the
 * players catalog (players.pitch_hand).
 *
 * Usage:
 *   npm run diagnose:platoon                  # all history
 *   npm run diagnose:platoon -- --last 30     # last 30 days
 *   npm run diagnose:platoon -- --from D1 --to D2
 *
 * NO writes. Never infers a value that isn't grounded in a real
 * MLB API source (either the boxscore or the players catalog fed
 * from /v1/people).
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

interface Args { from: string | null; to: string; }

function parseArgs(argv: string[]): Args {
  let from: string | null = null, to = mlbToday();
  let last: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (last != null && !from) from = mlbAddDays(to, -(last - 1));
  return { from, to };
}

async function fetchAllPaged<T>(builder: () => any): Promise<T[]> {
  // Small paginator that walks .range(page*1000, +999) until short read.
  const out: T[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 200; page++) {
    const { data, error } = await builder().range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(error.message);
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n═══ Platoon-attribution diagnostic ═══`);
  console.log(`  range: ${args.from ?? '(all history)'} .. ${args.to}`);

  // Load every batting-line row in scope (target_date, starter id/hand).
  const rows = await fetchAllPaged<{
    target_date: string; player_id: number; player_name: string; team: string;
    opposing_starter_id: number | null; opposing_starter_hand: string | null;
    hits: number; at_bats: number; game_pk: number;
  }>(() => {
    let q = supabaseAdmin
      .from('player_batting_lines')
      .select('target_date, player_id, player_name, team, opposing_starter_id, opposing_starter_hand, hits, at_bats, game_pk');
    if (args.from) q = q.gte('target_date', args.from);
    q = q.lte('target_date', args.to);
    return q.order('target_date', { ascending: true });
  });

  console.log(`\n  1) total batting-line rows: ${rows.length}`);

  if (rows.length === 0) {
    console.log(`\n  (no rows) — apply migration 020 + run process:date first.`);
    return;
  }

  // 2/3. ID and hand presence
  const withStarterId   = rows.filter((r) => r.opposing_starter_id != null);
  const withStarterHand = rows.filter((r) => r.opposing_starter_hand != null);
  const withBoth        = rows.filter((r) => r.opposing_starter_id != null && r.opposing_starter_hand != null);
  const idButNoHand     = rows.filter((r) => r.opposing_starter_id != null && r.opposing_starter_hand == null);
  const neither         = rows.filter((r) => r.opposing_starter_id == null && r.opposing_starter_hand == null);
  const pct = (n: number) => rows.length > 0 ? (100 * n / rows.length).toFixed(1) + '%' : '0.0%';
  console.log(`  2) opposing_starter_id IS NOT NULL:   ${withStarterId.length}   (${pct(withStarterId.length)})`);
  console.log(`  3) opposing_starter_hand IS NOT NULL: ${withStarterHand.length}   (${pct(withStarterHand.length)})`);
  console.log(`     both populated (attributable):     ${withBoth.length}   (${pct(withBoth.length)})`);
  console.log(`     id present, hand MISSING:          ${idButNoHand.length}   (${pct(idButNoHand.length)})   ← fallback candidates`);
  console.log(`     neither populated:                 ${neither.length}   (${pct(neither.length)})   ← unfixable without re-extraction`);

  // 4. Distinct hand values
  const handCounts = new Map<string, number>();
  for (const r of rows) {
    const key = r.opposing_starter_hand ?? '(null)';
    handCounts.set(key, (handCounts.get(key) ?? 0) + 1);
  }
  console.log(`\n  4) distinct opposing_starter_hand values:`);
  for (const [h, n] of [...handCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${h.padEnd(10)}  ${String(n).padStart(6)}   (${pct(n)})`);
  }

  // 5. Coverage by target_date
  const byDate = new Map<string, { total: number; withId: number; withHand: number }>();
  for (const r of rows) {
    const c = byDate.get(r.target_date) ?? { total: 0, withId: 0, withHand: 0 };
    c.total += 1;
    if (r.opposing_starter_id != null) c.withId += 1;
    if (r.opposing_starter_hand != null) c.withHand += 1;
    byDate.set(r.target_date, c);
  }
  const dateList = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(`\n  5) coverage by target_date (${dateList.length} date(s)):`);
  console.log(`     ${'date'.padEnd(12)}  ${'rows'.padStart(6)}  ${'id%'.padStart(7)}  ${'hand%'.padStart(7)}`);
  const showFirst = 12;
  const shown = dateList.length > showFirst * 2 ? [...dateList.slice(0, showFirst), null, ...dateList.slice(-showFirst)] : dateList;
  for (const entry of shown) {
    if (entry == null) { console.log(`     …`); continue; }
    const [d, c] = entry;
    const idPct   = c.total > 0 ? (100 * c.withId   / c.total).toFixed(0) : '0';
    const handPct = c.total > 0 ? (100 * c.withHand / c.total).toFixed(0) : '0';
    console.log(`     ${d.padEnd(12)}  ${String(c.total).padStart(6)}  ${idPct.padStart(6)}%  ${handPct.padStart(6)}%`);
  }

  // 6. Sample rows where attribution succeeded
  console.log(`\n  6) sample rows where attribution SUCCEEDED (both id + hand):`);
  const succ = withBoth.slice(0, 5);
  if (succ.length === 0) {
    console.log(`     (none)`);
  } else {
    for (const r of succ) {
      console.log(`     ${r.target_date}  ${r.player_name.padEnd(22)}  ${r.team.padEnd(4)}  vs pid=${r.opposing_starter_id} hand=${r.opposing_starter_hand}  ${r.hits}/${r.at_bats}`);
    }
  }

  // 7. Sample rows where attribution FAILED
  console.log(`\n  7) sample rows where attribution FAILED (id present, hand null):`);
  const fail1 = idButNoHand.slice(0, 5);
  if (fail1.length === 0) {
    console.log(`     (none — every populated id has a hand)`);
  } else {
    for (const r of fail1) {
      console.log(`     ${r.target_date}  ${r.player_name.padEnd(22)}  ${r.team.padEnd(4)}  vs pid=${r.opposing_starter_id} hand=NULL  ${r.hits}/${r.at_bats}`);
    }
  }
  console.log(`\n     sample rows with NO starter attribution at all (id null):`);
  const fail2 = neither.slice(0, 5);
  if (fail2.length === 0) {
    console.log(`     (none)`);
  } else {
    for (const r of fail2) {
      console.log(`     ${r.target_date}  ${r.player_name.padEnd(22)}  ${r.team.padEnd(4)}  game_pk=${r.game_pk}  ${r.hits}/${r.at_bats}`);
    }
  }

  // 8. Can we salvage id-only rows via players.pitch_hand?
  console.log(`\n  8) players.pitch_hand fallback viability:`);
  if (idButNoHand.length === 0) {
    console.log(`     (no id-only rows to salvage)`);
  } else {
    const idsToLookup = [...new Set(idButNoHand.map((r) => r.opposing_starter_id!))];
    const catalog = new Map<number, string | null>();
    const CHUNK = 300;
    for (let i = 0; i < idsToLookup.length; i += CHUNK) {
      const chunk = idsToLookup.slice(i, i + CHUNK);
      const { data, error } = await supabaseAdmin
        .from('players')
        .select('player_id, pitch_hand')
        .in('player_id', chunk);
      if (error) {
        console.log(`     ⚠ players lookup failed: ${error.message}`);
        break;
      }
      for (const p of (data ?? []) as { player_id: number; pitch_hand: string | null }[]) {
        catalog.set(p.player_id, p.pitch_hand);
      }
    }
    let salvageable = 0, catalogMissing = 0, catalogNullHand = 0;
    const salvageHandCounts = new Map<string, number>();
    for (const r of idButNoHand) {
      const h = catalog.get(r.opposing_starter_id!);
      if (h == null && !catalog.has(r.opposing_starter_id!)) catalogMissing++;
      else if (h == null) catalogNullHand++;
      else {
        salvageable++;
        salvageHandCounts.set(h, (salvageHandCounts.get(h) ?? 0) + 1);
      }
    }
    console.log(`     id-only rows: ${idButNoHand.length}`);
    console.log(`     distinct starter ids to look up: ${idsToLookup.length}`);
    console.log(`     catalog lookup found: ${catalog.size} pitchers`);
    console.log(`     salvageable (catalog has non-null hand):   ${salvageable}`);
    console.log(`     catalog row missing entirely:              ${catalogMissing}   (enrichPlayers hasn't fetched this pitcher yet)`);
    console.log(`     catalog row exists but pitch_hand is null: ${catalogNullHand}   (fetched but MLB returned no hand)`);
    if (salvageHandCounts.size > 0) {
      console.log(`     salvaged hand distribution:`);
      for (const [h, n] of [...salvageHandCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`       ${h}  ${n}`);
      }
    }
    if (salvageable > 0) {
      const newHandPct = 100 * (withStarterHand.length + salvageable) / rows.length;
      console.log(`     → applying fallback would raise hand-coverage from ${pct(withStarterHand.length)} to ${newHandPct.toFixed(1)}%`);
    }
  }

  console.log(`\n═══ end of diagnostic ═══\n`);
}

main().catch((err) => {
  console.error(`[diagnosePlatoonCoverage] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
