/**
 * CLI: take an HR-prop odds snapshot.
 *
 *   npm run snapshot:odds                           # today, type=manual
 *   npm run snapshot:odds -- morning                # today, type=morning
 *   npm run snapshot:odds -- 2026-05-15 pregame
 *   npm run snapshot:odds -- today midday --dry-run
 *   npm run snapshot:odds -- --books draftkings,fanduel
 */
import { snapshotOdds, type OddsSnapshotType } from './snapshotOdds.js';
import { mlbToday, addDays } from './lib/mlbDate.js';

interface Parsed {
  date: string;
  snapshotType: OddsSnapshotType;
  books?: string[];
  dryRun: boolean;
}

const VALID_TYPES: OddsSnapshotType[] = ['morning', 'midday', 'pregame', 'manual'];

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { date: mlbToday(), snapshotType: 'manual', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--books') {
      const v = argv[++i];
      if (!v) throw new Error('--books needs a comma-separated list');
      out.books = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === 'today') {
      out.date = mlbToday();
    } else if (a === 'yesterday') {
      out.date = addDays(mlbToday(), -1);
    } else if (a === 'tomorrow') {
      out.date = addDays(mlbToday(), 1);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      out.date = a;
    } else if ((VALID_TYPES as string[]).includes(a)) {
      out.snapshotType = a as OddsSnapshotType;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected arg: ${a}. Use YYYY-MM-DD | today/yesterday/tomorrow | morning|midday|pregame|manual | --books a,b | --dry-run`);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await snapshotOdds({
    date: opts.date,
    snapshotType: opts.snapshotType,
    books: opts.books,
    dryRun: opts.dryRun,
  });
  console.log('[runSnapshotOdds] result:', result);
}

main().catch((err) => {
  console.error('[runSnapshotOdds] FAILED:', err);
  process.exit(1);
});
