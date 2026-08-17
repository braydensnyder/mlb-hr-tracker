/**
 * enrichHitOutcomes — post-game outcome enrichment for
 * hit_target_snapshots.
 *
 * ISOLATED. Reads player_batting_lines for the date; updates only
 * outcome columns (hits, at_bats, hit_1plus, hit_2plus, doubles,
 * triples, outcome_enriched_at) on each snapshot row.
 *
 * Rank / score / contributions / model_config_* stamps are LEFT
 * BYTE-IDENTICAL. Same freeze principle as Phase 2.5 pregame v7
 * preservation — the pregame decision record is immutable.
 *
 * Idempotent — safe to re-run. --force re-writes outcome columns
 * even for rows already enriched (useful after a batting-line
 * backfill).
 */
import 'dotenv/config';
import { supabaseAdmin } from './lib/supabaseAdmin.js';

const HIT_MODEL_VERSION = 1;

export interface EnrichHitOutcomesResult {
  date: string;
  snapshot_rows_total: number;
  snapshot_rows_enriched: number;
  snapshot_rows_already_enriched: number;
  snapshot_rows_no_batting_line: number;
  players_with_batting_line: number;
  players_with_no_snapshot_row: number;
}

export interface EnrichHitOutcomesOptions {
  /** Re-write outcome columns even for already-enriched rows. */
  force?: boolean;
}

interface SnapshotRowLite {
  id: number;
  player_id: number;
  outcome_enriched_at: string | null;
}

interface BattingLineLite {
  player_id: number;
  hits: number;
  at_bats: number;
  doubles: number;
  triples: number;
}

async function loadSnapshotRows(date: string): Promise<SnapshotRowLite[]> {
  const out: SnapshotRowLite[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 40; page++) {
    const { data, error } = await supabaseAdmin
      .from('hit_target_snapshots')
      .select('id, player_id, outcome_enriched_at')
      .eq('target_date', date)
      .eq('model_version', HIT_MODEL_VERSION)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(`hit_target_snapshots read: ${error.message}`);
    }
    const rows = (data ?? []) as SnapshotRowLite[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadBattingLinesForDate(date: string): Promise<Map<number, BattingLineLite>> {
  const out = new Map<number, BattingLineLite>();
  const PAGE = 1000;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabaseAdmin
      .from('player_batting_lines')
      .select('player_id, hits, at_bats, doubles, triples')
      .eq('target_date', date)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`player_batting_lines read: ${error.message}`);
    for (const r of (data ?? []) as BattingLineLite[]) {
      // Aggregate across doubleheaders (one player, one date, two games).
      const cur = out.get(r.player_id) ?? { player_id: r.player_id, hits: 0, at_bats: 0, doubles: 0, triples: 0 };
      cur.hits += r.hits;
      cur.at_bats += r.at_bats;
      cur.doubles += r.doubles;
      cur.triples += r.triples;
      out.set(r.player_id, cur);
    }
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export async function enrichHitOutcomes(date: string, opts: EnrichHitOutcomesOptions = {}): Promise<EnrichHitOutcomesResult> {
  const force = !!opts.force;
  const nowIso = new Date().toISOString();
  console.log(`[enrichHitOutcomes] date=${date}${force ? ' force' : ''}`);

  const snapshots = await loadSnapshotRows(date);
  if (snapshots.length === 0) {
    console.log(`  no hit_target_snapshots rows for ${date}`);
    return {
      date,
      snapshot_rows_total: 0,
      snapshot_rows_enriched: 0,
      snapshot_rows_already_enriched: 0,
      snapshot_rows_no_batting_line: 0,
      players_with_batting_line: 0,
      players_with_no_snapshot_row: 0,
    };
  }

  const linesByPlayer = await loadBattingLinesForDate(date);
  console.log(`  ${snapshots.length} snapshot rows, ${linesByPlayer.size} batting-line entries`);

  const snapshotPlayerIds = new Set<number>(snapshots.map((s) => s.player_id));
  const linePlayerIds = new Set<number>(linesByPlayer.keys());
  const playersWithNoSnapshot = [...linePlayerIds].filter((pid) => !snapshotPlayerIds.has(pid)).length;

  let enriched = 0, alreadyEnriched = 0, noLine = 0;
  for (const s of snapshots) {
    if (!force && s.outcome_enriched_at != null) { alreadyEnriched++; continue; }
    const line = linesByPlayer.get(s.player_id);
    if (!line) {
      // Player was in the pregame snapshot but never got a batting line
      // (was scratched, benched, or the game was postponed). Mark as
      // enriched with zero stats so the row is no longer "pending" —
      // but only if the row wasn't already enriched.
      if (!force && s.outcome_enriched_at != null) { alreadyEnriched++; continue; }
      noLine++;
      const { error } = await supabaseAdmin
        .from('hit_target_snapshots')
        .update({
          hits: 0, at_bats: 0, hit_1plus: false, hit_2plus: false,
          doubles: 0, triples: 0,
          outcome_enriched_at: nowIso,
        })
        .eq('id', s.id);
      if (error) throw new Error(`enrich no-line ${s.player_id}: ${error.message}`);
      continue;
    }
    // Real batting line — write outcome columns only, leave rank/score/
    // contributions/model stamps untouched (the freeze contract).
    const { error } = await supabaseAdmin
      .from('hit_target_snapshots')
      .update({
        hits: line.hits,
        at_bats: line.at_bats,
        hit_1plus: line.hits >= 1,
        hit_2plus: line.hits >= 2,
        doubles: line.doubles,
        triples: line.triples,
        outcome_enriched_at: nowIso,
      })
      .eq('id', s.id);
    if (error) throw new Error(`enrich ${s.player_id}: ${error.message}`);
    enriched++;
  }

  console.log(
    `[enrichHitOutcomes] ✓ enriched=${enriched}  no_batting_line_zeroed=${noLine}  already_enriched=${alreadyEnriched}` +
    (playersWithNoSnapshot > 0 ? `  · ${playersWithNoSnapshot} player(s) hit but had no snapshot row (scratched-in or extractor missed lineup)` : ''),
  );

  return {
    date,
    snapshot_rows_total: snapshots.length,
    snapshot_rows_enriched: enriched,
    snapshot_rows_already_enriched: alreadyEnriched,
    snapshot_rows_no_batting_line: noLine,
    players_with_batting_line: linesByPlayer.size,
    players_with_no_snapshot_row: playersWithNoSnapshot,
  };
}
