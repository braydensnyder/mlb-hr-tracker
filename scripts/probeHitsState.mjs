/**
 * probeHitsState.mjs — read-only DB audit for the Hits pipeline.
 *
 * Reports per (target_date, model_version):
 *   - snapshot row count
 *   - outcome_enriched count (outcome_enriched_at is not null)
 *   - hit_1plus / hit_2plus non-null counts
 *   - distinct model config hashes (1+ / 2+)
 *   - snapshot_type distribution
 *
 * Also reports hit_target_universe row counts and batting_lines coverage
 * for the same range so we can tell whether the enrichment source data
 * is present.
 *
 * Pure Node — no tsx, no @supabase/supabase-js. Reads SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY from .env directly. This makes it runnable
 * from any environment where the .env is present (including sandboxes
 * that can't build node-native modules).
 *
 * Usage:
 *   node scripts/probeHitsState.mjs                     # last 8 days
 *   node scripts/probeHitsState.mjs 2026-08-10 2026-08-17
 */
import { readFileSync } from 'fs';

// ---- env ----
const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  })
);
const URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ---- args ----
const args = process.argv.slice(2);
function daysAgoISO(n) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const FROM = args[0] ?? daysAgoISO(8);
const TO = args[1] ?? daysAgoISO(0);
if (FROM > TO) { console.error(`from (${FROM}) > to (${TO})`); process.exit(1); }

// ---- helpers ----
async function fetchAll(path, filterParams = {}) {
  const all = [];
  const PAGE = 1000;
  for (let p = 0; p < 200; p++) {
    const q = new URLSearchParams(filterParams);
    const from = p * PAGE, to = from + PAGE - 1;
    const r = await fetch(`${URL}/rest/v1/${path}?${q}`, {
      headers: { ...H, Range: `${from}-${to}` },
    });
    if (!r.ok) {
      const t = await r.text();
      console.error(`  [${path}] HTTP ${r.status}: ${t.slice(0, 240)}`);
      return all;
    }
    const arr = await r.json();
    all.push(...arr);
    if (arr.length < PAGE) break;
  }
  return all;
}

async function countRows(path, filterParams = {}) {
  const q = new URLSearchParams(filterParams);
  const r = await fetch(`${URL}/rest/v1/${path}?${q}`, {
    headers: { ...H, Range: '0-0', Prefer: 'count=exact' },
  });
  const cr = r.headers.get('content-range') || '';
  return Number(cr.split('/')[1] ?? 0) || 0;
}

// ---- 1. hit_target_snapshots ----
console.log(`\n═══ Hits pipeline probe: ${FROM} .. ${TO} ═══\n`);

const snap = await fetchAll('hit_target_snapshots', {
  select: 'target_date,model_version,snapshot_type,model_config_hash_1plus,model_config_hash_2plus,hit_1plus,hit_2plus,hits,outcome_enriched_at',
  target_date: `gte.${FROM}`,
  and: `(target_date.lte.${TO})`,
});
const snapInRange = snap.filter((r) => r.target_date >= FROM && r.target_date <= TO);
console.log(`1. hit_target_snapshots rows in range: ${snapInRange.length}\n`);

const byKey = new Map();
for (const r of snapInRange) {
  const k = `${r.target_date} v${r.model_version}`;
  const b = byKey.get(k) ?? { rows: 0, enriched: 0, hit1p_nn: 0, hit2p_nn: 0, hashes1: new Set(), hashes2: new Set(), types: new Set(), hits_sum: 0 };
  b.rows += 1;
  if (r.outcome_enriched_at != null) b.enriched += 1;
  if (r.hit_1plus != null) b.hit1p_nn += 1;
  if (r.hit_2plus != null) b.hit2p_nn += 1;
  if (typeof r.hits === 'number') b.hits_sum += r.hits;
  if (r.model_config_hash_1plus) b.hashes1.add(r.model_config_hash_1plus);
  if (r.model_config_hash_2plus) b.hashes2.add(r.model_config_hash_2plus);
  if (r.snapshot_type) b.types.add(r.snapshot_type);
  byKey.set(k, b);
}

console.log('  date/version              rows  enriched  hit1p_nn  hit2p_nn  hits_sum  types            hashes (1+ / 2+)');
console.log('  ' + '-'.repeat(140));
for (const k of [...byKey.keys()].sort()) {
  const b = byKey.get(k);
  console.log(
    `  ${k.padEnd(24)}  ${String(b.rows).padStart(4)}  ${String(b.enriched).padStart(8)}  ${String(b.hit1p_nn).padStart(8)}  ${String(b.hit2p_nn).padStart(8)}  ${String(b.hits_sum).padStart(8)}  ${[...b.types].join(',').padEnd(15)}  ${[...b.hashes1].join(',')} / ${[...b.hashes2].join(',')}`
  );
}

// Alert on suspected regressions.
const dates = [...new Set(snapInRange.map((r) => r.target_date))].sort();
const versionsSeen = [...new Set(snapInRange.map((r) => r.model_version))];
console.log(`\n  ↳ distinct dates: ${dates.length}, versions seen: [${versionsSeen.sort().join(', ')}]`);

const missingV2 = dates.filter((d) => !snapInRange.some((r) => r.target_date === d && r.model_version === 2));
if (missingV2.length > 0) console.log(`  ⚠ v2 MISSING for: ${missingV2.join(', ')}`);
const missingV1 = dates.filter((d) => !snapInRange.some((r) => r.target_date === d && r.model_version === 1));
if (missingV1.length > 0) console.log(`  ⚠ v1 MISSING for: ${missingV1.join(', ')}`);

const notEnriched = [...byKey.entries()].filter(([, b]) => b.rows > 0 && b.enriched === 0);
if (notEnriched.length > 0) {
  console.log(`  ⚠ ${notEnriched.length} (date, version) tuple(s) have ZERO enriched rows:`);
  for (const [k] of notEnriched) console.log(`      ${k}`);
}

// ---- 2. hit_target_universe ----
console.log(`\n2. hit_target_universe rows in range:`);
const uni = await fetchAll('hit_target_universe', {
  select: 'target_date,model_version',
  target_date: `gte.${FROM}`,
  and: `(target_date.lte.${TO})`,
});
const uniInRange = uni.filter((r) => r.target_date >= FROM && r.target_date <= TO);
const uByKey = new Map();
for (const r of uniInRange) {
  const k = `${r.target_date} v${r.model_version}`;
  uByKey.set(k, (uByKey.get(k) ?? 0) + 1);
}
console.log(`  total: ${uniInRange.length}`);
for (const k of [...uByKey.keys()].sort()) console.log(`  ${k}: ${uByKey.get(k)}`);

// ---- 3. player_batting_lines coverage (enrichment source) ----
console.log(`\n3. player_batting_lines coverage (enrichment source of truth):`);
let d = FROM;
while (d <= TO) {
  const c = await countRows('player_batting_lines', { target_date: `eq.${d}` });
  const flag = c === 0 ? '  ⚠ NO BATTING LINES (enrichment will zero all outcomes)' : '';
  console.log(`  ${d}: ${c}${flag}`);
  const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + 1);
  d = dt.toISOString().slice(0, 10);
}

// ---- 4. Recommendation ----
console.log(`\n═══ Recommendation ═══`);
if (missingV1.length > 0 || missingV2.length > 0 || notEnriched.length > 0) {
  console.log(`  Re-run the backfill for the affected range:`);
  console.log(`    npm run backfill:hit-snapshots -- --from ${FROM} --to ${TO}`);
  console.log(`  Or, if snapshot rows exist but outcomes are missing, run enrichment only:`);
  console.log(`    npm run enrich:hit-outcomes -- --from ${FROM} --to ${TO} --force`);
} else {
  console.log(`  Looks healthy — v1 and v2 both present and enriched across the range.`);
}
console.log('');
