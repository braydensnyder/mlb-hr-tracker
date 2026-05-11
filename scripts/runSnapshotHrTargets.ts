/**
 * CLI: take a Top-N snapshot of HR targets for a date.
 *
 * Usage:
 *   npm run snapshot:targets                  # today
 *   npm run snapshot:targets -- 2026-05-10
 *   npm run snapshot:targets -- yesterday
 *   npm run snapshot:targets -- 2026-05-10 --force
 *   npm run snapshot:targets -- 2026-05-10 --limit 25
 */
import { snapshotHrTargets } from './snapshotHrTargets.js';

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(s: string, d: number) {
  const [y, m, dd] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}

interface Parsed { date: string; force: boolean; limit?: number; }

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { date: todayISO(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      out.force = true;
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--limit needs a positive integer');
      out.limit = Math.floor(v);
    } else if (a === 'today') {
      out.date = todayISO();
    } else if (a === 'yesterday') {
      out.date = addDays(todayISO(), -1);
    } else if (a === 'tomorrow') {
      out.date = addDays(todayISO(), 1);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      out.date = a;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected positional arg: ${a}. Use YYYY-MM-DD | today | yesterday | tomorrow.`);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await snapshotHrTargets(opts.date, { force: opts.force, limit: opts.limit });
  console.log('[runSnapshotHrTargets] result:', result);
}

main().catch((err) => {
  console.error('[runSnapshotHrTargets] FAILED:', err);
  process.exit(1);
});
