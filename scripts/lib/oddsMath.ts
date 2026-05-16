/**
 * oddsMath — small pure helpers shared by frontend + backend.
 *
 * Phase 1 of the Odds tab needs:
 *   - american odds → decimal odds            (display + storage)
 *   - american odds → vig-inclusive implied probability  (Model vs Market)
 *   - Heat Score → model probability (sigmoid anchored at MLB base rate)
 *
 * Why the model curve lives here: keeping it in a tiny pure module makes
 * it trivial to verify and tune. Heat scores in our data range roughly
 * 30..85. The MLB league HR-per-game-per-batter rate is ~4–5% for a
 * regular at-bat slate. We anchor the sigmoid so a "neutral" heat score
 * (~50) maps to ~base rate, and the slope produces edges in a plausible
 * single-digit-percent range across the score distribution.
 *
 * IMPORTANT: this is research-only. We do NOT let model_prob feed back
 * into Heat Score in Phase 1 (user spec). It exists for comparison.
 */

/** American odds → decimal odds. +450 → 5.5, -120 → 1.8333… */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0;
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

/** American odds → implied probability (vig-inclusive). +450 → 0.1818… */
export function americanToImplied(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0;
  return american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);
}

/** Format an american odds integer for display ("+450" / "-120"). */
export function formatAmerican(american: number): string {
  if (!Number.isFinite(american)) return '—';
  return american > 0 ? `+${american}` : `${american}`;
}

/**
 * Heat Score → estimated HR probability via a tuned sigmoid.
 *
 * Design constraints:
 *   - heat 50  → ≈ MLB base rate (~5%)
 *   - heat 80  → ≈ 18% (top-of-card range, matches book lines like +450 → +500)
 *   - heat 20  → ≈ 1–2% (well below base rate)
 *
 * sigmoid(x) = 1 / (1 + e^(-x))
 * mapping: p(heat) = a + (b - a) * sigmoid((heat - mid) / slope)
 *   a    = 0.005    (1-in-200 floor for cold rows)
 *   b    = 0.30     (ceiling — even elite power on a great matchup isn't > 30%)
 *   mid  = 55       (heat score where p crosses the midpoint between a and b)
 *   slope = 10      (rate of climb)
 *
 * These constants are TUNABLE. Treat them as initial values; once we have
 * a week or two of (model_prob, actual HR) data we can refit.
 */
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

/** model_prob - implied_prob, signed. Positive = model thinks the player
 *  is more likely to homer than the book's price implies. */
export function computeEdge(modelProb: number, impliedProb: number): number {
  return modelProb - impliedProb;
}

/** Pretty-print a probability as a percent string. 0.182 → "18.2%". */
export function formatPct(p: number | null | undefined, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

/** Pretty-print a signed edge with explicit sign. +0.06 → "+6.0%". */
export function formatEdge(edge: number | null | undefined, digits = 1): string {
  if (edge == null || !Number.isFinite(edge)) return '—';
  const pct = edge * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}
