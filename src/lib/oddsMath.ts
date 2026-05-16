/**
 * oddsMath (frontend) — mirrors scripts/lib/oddsMath.ts so the UI and
 * the snapshot writer agree on the math without crossing Vite/Node
 * module boundaries. If you change the curve or the conversions here,
 * change them in the scripts/ copy too — and vice versa.
 */

export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0;
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

export function americanToImplied(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0;
  return american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);
}

export function formatAmerican(american: number): string {
  if (!Number.isFinite(american)) return '—';
  return american > 0 ? `+${american}` : `${american}`;
}

export const MODEL_PROB_CURVE = {
  floor: 0.005,
  ceiling: 0.30,
  midpoint: 55,
  slope: 10,
} as const;

export function heatScoreToModelProb(heat: number | null | undefined): number {
  if (heat == null || !Number.isFinite(heat)) return MODEL_PROB_CURVE.floor;
  const { floor, ceiling, midpoint, slope } = MODEL_PROB_CURVE;
  const z = (heat - midpoint) / slope;
  const s = 1 / (1 + Math.exp(-z));
  return floor + (ceiling - floor) * s;
}

export function computeEdge(modelProb: number, impliedProb: number): number {
  return modelProb - impliedProb;
}

export function formatPct(p: number | null | undefined, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

export function formatEdge(edge: number | null | undefined, digits = 1): string {
  if (edge == null || !Number.isFinite(edge)) return '—';
  const pct = edge * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}
