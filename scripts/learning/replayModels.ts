/**
 * replayModels — replay alternative model versions against a saved snapshot.
 *
 * For each date in the requested range and each model version (defaults to
 * every non-v1 row in model_versions), this script:
 *   1. Loads the saved hr_target_snapshots row set for the date (v1's
 *      pre-game judgment).
 *   2. Applies the model's signal-weight bonuses to each player's heat
 *      score, re-ranks globally.
 *   3. Generates Safe / Value / Chaos parlays using the model's parlay
 *      rule overrides.
 *   4. Writes one learning_predictions row per (date, player, version)
 *      with the modified rank, heat, and parlay membership.
 *
 * Idempotent — uses upsert on (target_date, player_id, model_version).
 *
 * HONEST SCOPE: signal-based replay only. We do NOT re-run the full
 * scoring pipeline from raw inputs. See migration 014's comments.
 *
 * Usage:
 *   npm run learning:replay-models -- --date 2026-06-15
 *   npm run learning:replay-models -- --from 2026-06-01 --to 2026-06-26
 *   npm run learning:replay-models -- --from 2026-06-01 --versions 2,3,4
 *   npm run learning:replay-models -- --from 2026-06-01 --skip-existing
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';
import {
  replayDateUnderModel,
  type ModelConfig,
  type RevAnalysisSnapshotRow,
} from '../../src/lib/stats.js';

interface Args {
  from: string;
  to: string;
  versions: number[] | 'all-non-v1';
  skipExisting: boolean;
  continueOnError: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    from: '',
    to: '',
    versions: 'all-non-v1',
    skipExisting: false,
    continueOnError: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--date needs YYYY-MM-DD (got ${v})`);
      out.from = v;
      out.to = v;
    } else if (a === '--from') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--from needs YYYY-MM-DD (got ${v})`);
      out.from = v;
    } else if (a === '--to') {
      const v = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--to needs YYYY-MM-DD (got ${v})`);
      out.to = v;
    } else if (a === '--versions') {
      const list = argv[++i].split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
      if (list.length === 0) throw new Error('--versions needs at least one integer');
      out.versions = list;
    } else if (a === '--skip-existing') {
      out.skipExisting = true;
    } else if (a === '--stop-on-error') {
      out.continueOnError = false;
    } else if (a === '--continue-on-error') {
      out.continueOnError = true;
    } else {
      throw new Error(`Unexpected arg: ${a}. See header comment for usage.`);
    }
  }
  if (!out.from) throw new Error('Provide --date OR --from (--to defaults to yesterday)');
  if (!out.to) out.to = mlbAddDays(mlbToday(), -1);
  if (out.from > out.to) throw new Error(`--from (${out.from}) is after --to (${out.to})`);
  return out;
}

function buildDates(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = mlbAddDays(d, 1);
  }
  return out;
}

function log(msg: string) {
  console.log(`[replayModels] ${msg}`);
}
function logOk(msg: string) {
  console.log(`[replayModels] ✓ ${msg}`);
}
function logWarn(msg: string) {
  console.warn(`[replayModels] ⚠ ${msg}`);
}
function logErr(msg: string) {
  console.error(`[replayModels] ✗ ${msg}`);
}

interface ModelRow {
  version: number;
  name: string;
  weights_json: Record<string, unknown>;
  active: boolean;
}

async function loadModelVersions(): Promise<ModelRow[]> {
  const { data, error } = await supabaseAdmin
    .from('model_versions')
    .select('version, name, weights_json, active')
    .order('version', { ascending: true });
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      throw new Error('model_versions table missing. Apply migrations 013 + 014 first.');
    }
    throw new Error(`model_versions: ${error.message}`);
  }
  return (data ?? []) as ModelRow[];
}

function toModelConfig(row: ModelRow): ModelConfig {
  const wj = row.weights_json as { signal_weights?: Record<string, number>; parlay_rules?: Record<string, number>; description?: string };
  return {
    version: row.version,
    name: row.name,
    signal_weights: (wj?.signal_weights ?? {}) as ModelConfig['signal_weights'],
    parlay_rules: (wj?.parlay_rules ?? {}) as ModelConfig['parlay_rules'],
    description: wj?.description,
  };
}

async function loadSnapshots(date: string): Promise<RevAnalysisSnapshotRow[]> {
  const all: RevAnalysisSnapshotRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('hr_target_snapshots')
      .select('target_date, player_id, player_name, team, rank, heat_score, reason')
      .eq('target_date', date)
      .order('rank', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`snapshots ${date}: ${error.message}`);
    const rows = (data ?? []) as RevAnalysisSnapshotRow[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

interface HrRowLite {
  game_pk: number;
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
}

async function loadHrs(date: string): Promise<HrRowLite[]> {
  const all: HrRowLite[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('game_pk, player_id, player_name, team, opponent')
      .eq('game_date', date)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`home_runs ${date}: ${error.message}`);
    const rows = (data ?? []) as HrRowLite[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function loadOdds(date: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const { data, error } = await supabaseAdmin
    .from('odds_snapshots')
    .select('player_id, american_odds, snapshot_time')
    .eq('target_date', date)
    .order('snapshot_time', { ascending: true });
  if (error) {
    if (/odds_snapshots/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      return out;
    }
    throw new Error(`odds ${date}: ${error.message}`);
  }
  for (const r of (data ?? []) as { player_id: number | null; american_odds: number }[]) {
    if (r.player_id == null) continue;
    out.set(r.player_id, r.american_odds);
  }
  return out;
}

async function existingCount(date: string, version: number): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('learning_predictions')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('model_version', version);
  if (error) throw new Error(`existing count (${date}, v${version}): ${error.message}`);
  return count ?? 0;
}

export interface DayModelOutcome {
  date: string;
  version: number;
  status: 'success' | 'skipped' | 'failed';
  records_written?: number;
  tp?: number; fp?: number; fn?: number; tn?: number;
  full_3of3?: number;          // 0/1
  partial_2of3?: number;       // 0/1
  legs_hit?: number;           // 0..9
  error?: string;
}

/**
 * Programmatic API used by updateDaily's learning phase.
 *
 * Replays all eligible non-v1 model versions against a single date and
 * upserts the per-(date, player, version) rows into learning_predictions.
 *
 * Skipped behavior: when skipExisting=true, dates already covered for a
 * given version are left alone — so this is safe to call from the cron
 * even after a manual backfill has already populated rows.
 */
export async function replayDateForVersions(date: string, opts: {
  versions?: number[];
  skipExisting?: boolean;
} = {}): Promise<DayModelOutcome[]> {
  const allRows = await loadModelVersions();
  const allConfigs = allRows.map(toModelConfig);
  const targets = opts.versions
    ? allConfigs.filter((c) => opts.versions!.includes(c.version))
    : allConfigs.filter((c) => c.version !== 1);

  if (targets.length === 0) return [];

  const [snapshots, hrs, odds] = await Promise.all([
    loadSnapshots(date),
    loadHrs(date),
    loadOdds(date),
  ]);
  if (snapshots.length === 0) {
    return targets.map((t) => ({ date, version: t.version, status: 'failed' as const, error: 'no snapshot for date' }));
  }

  const hrIds = new Set(hrs.map((h) => h.player_id));
  const hrCount = new Map<number, number>();
  const oppByPlayer = new Map<number, string>();
  const gamePkByPlayer = new Map<number, number>();
  for (const h of hrs) {
    hrCount.set(h.player_id, (hrCount.get(h.player_id) ?? 0) + 1);
    oppByPlayer.set(h.player_id, h.opponent);
    gamePkByPlayer.set(h.player_id, h.game_pk);
  }

  const outcomes: DayModelOutcome[] = [];
  for (const config of targets) {
    try {
      if (opts.skipExisting) {
        const ex = await existingCount(date, config.version);
        if (ex > 0) {
          outcomes.push({ date, version: config.version, status: 'skipped', records_written: ex });
          continue;
        }
      }
      const result = replayDateUnderModel({
        date, snapshots, odds,
        hr_player_ids: hrIds, hr_count_by_player: hrCount,
        opponent_by_player: oppByPlayer, game_pk_by_player: gamePkByPlayer,
        config,
      });
      let tp = 0, fp = 0, fn = 0, tn = 0;
      for (const r of result.records) {
        if (r.classification === 'TP') tp++;
        else if (r.classification === 'FP') fp++;
        else if (r.classification === 'FN') fn++;
        else if (r.classification === 'TN') tn++;
      }
      const legsAll = [...result.safe.legs, ...result.value.legs, ...result.chaos.legs];
      const legsHitToday = legsAll.reduce((s, l) => s + (hrIds.has(l.player_id) ? 1 : 0), 0);
      const safeHit = result.safe.legs.length === 3 && result.safe.legs.every((l) => hrIds.has(l.player_id));
      const valueHit = result.value.legs.length === 3 && result.value.legs.every((l) => hrIds.has(l.player_id));
      const chaosHit = result.chaos.legs.length === 3 && result.chaos.legs.every((l) => hrIds.has(l.player_id));
      const full3of3 = (safeHit ? 1 : 0) + (valueHit ? 1 : 0) + (chaosHit ? 1 : 0);
      const safe2of3 = result.safe.legs.length === 3 && result.safe.legs.filter((l) => hrIds.has(l.player_id)).length === 2;
      const value2of3 = result.value.legs.length === 3 && result.value.legs.filter((l) => hrIds.has(l.player_id)).length === 2;
      const chaos2of3 = result.chaos.legs.length === 3 && result.chaos.legs.filter((l) => hrIds.has(l.player_id)).length === 2;
      const partial2of3 = (safe2of3 ? 1 : 0) + (value2of3 ? 1 : 0) + (chaos2of3 ? 1 : 0);

      const now = new Date().toISOString();
      const upsertRows = result.records.map((r) => ({ ...r, captured_at: now }));
      const BATCH = 500;
      let written = 0;
      for (let j = 0; j < upsertRows.length; j += BATCH) {
        const chunk = upsertRows.slice(j, j + BATCH);
        const { error: upErr, count } = await supabaseAdmin
          .from('learning_predictions')
          .upsert(chunk, { onConflict: 'target_date,player_id,model_version', count: 'exact' });
        if (upErr) throw new Error(upErr.message);
        written += count ?? chunk.length;
      }
      outcomes.push({
        date, version: config.version, status: 'success',
        records_written: written,
        tp, fp, fn, tn,
        full_3of3: full3of3, partial_2of3: partial2of3,
        legs_hit: legsHitToday,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcomes.push({ date, version: config.version, status: 'failed', error: msg });
    }
  }
  return outcomes;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dates = buildDates(args.from, args.to);

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`START — ${dates.length} day${dates.length === 1 ? '' : 's'} (${args.from} → ${args.to})`);

  // ---- Load model_versions ----
  const allRows = await loadModelVersions();
  const allConfigs = allRows.map(toModelConfig);
  log(`  found ${allConfigs.length} model_versions in DB`);
  for (const c of allConfigs) {
    const tag = allRows.find((r) => r.version === c.version)?.active ? '★ ACTIVE' : '';
    const nWeights = Object.keys(c.signal_weights).filter((k) => (c.signal_weights[k as keyof typeof c.signal_weights] ?? 0) !== 0).length;
    const nRules = Object.keys(c.parlay_rules).length;
    log(`    v${c.version}  ${c.name.padEnd(30)} signal_weights=${nWeights} parlay_rule_overrides=${nRules} ${tag}`);
  }

  // Pick which versions to replay.
  let targets: ModelConfig[];
  if (args.versions === 'all-non-v1') {
    targets = allConfigs.filter((c) => c.version !== 1);
  } else {
    targets = allConfigs.filter((c) => (args.versions as number[]).includes(c.version));
  }
  if (targets.length === 0) {
    logErr('No target versions to replay. Apply migration 014 first, or specify --versions.');
    process.exit(1);
  }
  log(`  replaying versions: ${targets.map((c) => `v${c.version}`).join(', ')}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const outcomes: DayModelOutcome[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    log('');
    log(`▶ DATE ${i + 1}/${dates.length}  ${date}  ────────────────────────`);

    // Load once per date, replay through all target models.
    let snapshots: RevAnalysisSnapshotRow[];
    let hrs: HrRowLite[];
    let odds: Map<number, number>;
    try {
      [snapshots, hrs, odds] = await Promise.all([loadSnapshots(date), loadHrs(date), loadOdds(date)]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr(`load failed for ${date}: ${msg}`);
      for (const t of targets) outcomes.push({ date, version: t.version, status: 'failed', error: msg });
      if (!args.continueOnError) process.exit(1);
      continue;
    }

    if (snapshots.length === 0) {
      logWarn(`  no snapshot rows for ${date} — skipping all versions`);
      for (const t of targets) outcomes.push({ date, version: t.version, status: 'failed', error: 'no snapshot for date' });
      continue;
    }
    log(`  snapshot rows: ${snapshots.length}, HR hitters: ${new Set(hrs.map((h) => h.player_id)).size}, odds: ${odds.size}`);

    const hrIds = new Set(hrs.map((h) => h.player_id));
    const hrCount = new Map<number, number>();
    const oppByPlayer = new Map<number, string>();
    const gamePkByPlayer = new Map<number, number>();
    for (const h of hrs) {
      hrCount.set(h.player_id, (hrCount.get(h.player_id) ?? 0) + 1);
      oppByPlayer.set(h.player_id, h.opponent);
      gamePkByPlayer.set(h.player_id, h.game_pk);
    }

    // Replay each target model.
    for (const config of targets) {
      const tag = `v${config.version}`;
      try {
        // Skip-existing pre-check
        if (args.skipExisting) {
          const ex = await existingCount(date, config.version);
          if (ex > 0) {
            log(`    ${tag}: skip — ${ex} rows already in DB`);
            outcomes.push({ date, version: config.version, status: 'skipped', records_written: ex });
            continue;
          }
        }

        const result = replayDateUnderModel({
          date,
          snapshots,
          odds,
          hr_player_ids: hrIds,
          hr_count_by_player: hrCount,
          opponent_by_player: oppByPlayer,
          game_pk_by_player: gamePkByPlayer,
          config,
        });

        // Tally classifications
        let tp = 0, fp = 0, fn = 0, tn = 0;
        for (const r of result.records) {
          if (r.classification === 'TP') tp++;
          else if (r.classification === 'FP') fp++;
          else if (r.classification === 'FN') fn++;
          else if (r.classification === 'TN') tn++;
        }

        // Per-day parlay metrics
        const legsAll = [...result.safe.legs, ...result.value.legs, ...result.chaos.legs];
        const legsHitToday = legsAll.reduce((s, l) => s + (hrIds.has(l.player_id) ? 1 : 0), 0);
        const safeHit = result.safe.legs.length === 3 && result.safe.legs.every((l) => hrIds.has(l.player_id));
        const valueHit = result.value.legs.length === 3 && result.value.legs.every((l) => hrIds.has(l.player_id));
        const chaosHit = result.chaos.legs.length === 3 && result.chaos.legs.every((l) => hrIds.has(l.player_id));
        const safe2of3 = result.safe.legs.length === 3 && result.safe.legs.filter((l) => hrIds.has(l.player_id)).length === 2;
        const value2of3 = result.value.legs.length === 3 && result.value.legs.filter((l) => hrIds.has(l.player_id)).length === 2;
        const chaos2of3 = result.chaos.legs.length === 3 && result.chaos.legs.filter((l) => hrIds.has(l.player_id)).length === 2;
        const full3of3 = (safeHit ? 1 : 0) + (valueHit ? 1 : 0) + (chaosHit ? 1 : 0);
        const partial2of3 = (safe2of3 ? 1 : 0) + (value2of3 ? 1 : 0) + (chaos2of3 ? 1 : 0);

        // Upsert in batches
        const now = new Date().toISOString();
        const upsertRows = result.records.map((r) => ({ ...r, captured_at: now }));
        const BATCH = 500;
        let written = 0;
        for (let j = 0; j < upsertRows.length; j += BATCH) {
          const chunk = upsertRows.slice(j, j + BATCH);
          const { error: upErr, count } = await supabaseAdmin
            .from('learning_predictions')
            .upsert(chunk, { onConflict: 'target_date,player_id,model_version', count: 'exact' });
          if (upErr) throw new Error(`upsert: ${upErr.message}`);
          written += count ?? chunk.length;
        }

        log(`    ${tag}: ${written} rows written · TP=${tp} FP=${fp} FN=${fn} TN=${tn} · parlays: 3/3=${full3of3} 2/3=${partial2of3} legs=${legsHitToday}/${legsAll.length}`);
        outcomes.push({
          date, version: config.version, status: 'success',
          records_written: written,
          tp, fp, fn, tn,
          full_3of3: full3of3, partial_2of3: partial2of3,
          legs_hit: legsHitToday,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logErr(`  ${tag} FAILED: ${msg}`);
        outcomes.push({ date, version: config.version, status: 'failed', error: msg });
        if (!args.continueOnError) process.exit(1);
      }
    }
  }

  // ---- Final aggregate ----
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const succeeded = outcomes.filter((o) => o.status === 'success');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const failed = outcomes.filter((o) => o.status === 'failed');

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`${failed.length === 0 ? '✅ COMPLETE' : '⚠ COMPLETE WITH ERRORS'}`);
  log(`  elapsed              = ${elapsedSec}s`);
  log(`  date × version pairs = ${outcomes.length}`);
  log(`  succeeded            = ${succeeded.length}`);
  log(`  skipped              = ${skipped.length}`);
  log(`  failed               = ${failed.length}`);

  // Per-version roll-up
  log('');
  log('  per-version summary (succeeded only):');
  const byVersion = new Map<number, DayModelOutcome[]>();
  for (const o of succeeded) {
    const arr = byVersion.get(o.version) ?? [];
    arr.push(o);
    byVersion.set(o.version, arr);
  }
  for (const [v, list] of Array.from(byVersion.entries()).sort((a, b) => a[0] - b[0])) {
    const days = list.length;
    const tp = list.reduce((s, o) => s + (o.tp ?? 0), 0);
    const fp = list.reduce((s, o) => s + (o.fp ?? 0), 0);
    const fn = list.reduce((s, o) => s + (o.fn ?? 0), 0);
    const tn = list.reduce((s, o) => s + (o.tn ?? 0), 0);
    const full = list.reduce((s, o) => s + (o.full_3of3 ?? 0), 0);
    const partial = list.reduce((s, o) => s + (o.partial_2of3 ?? 0), 0);
    const legs = list.reduce((s, o) => s + (o.legs_hit ?? 0), 0);
    log(`    v${v}: ${days}d  TP=${tp} FP=${fp} FN=${fn} TN=${tn}  3/3=${full}  2/3=${partial}  legs hit=${legs}/${days * 9}`);
  }

  if (failed.length > 0) {
    log('');
    log(`  failures (${failed.length}):`);
    for (const f of failed) {
      log(`    ${f.date} v${f.version} → ${f.error}`);
    }
  }
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.exit(failed.length === 0 ? 0 : 1);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    logErr(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
