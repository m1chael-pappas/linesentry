/** One observation in a fitted series. `t` is a `window_start` in epoch ms. */
export interface Point {
  t: number;
  v: number;
}

/** `v = slope * t + intercept`, with `t` in epoch ms. */
export interface LinearModel {
  slope: number;
  intercept: number;
}

/** Predictor family identifier carried on every forwarded window. */
export const PREDICTOR_FAMILY = 'lsq';

/** Returns `lsq-<historyWindows>`. Pure. */
export function predictorVersion(historyWindows: number): string {
  return `${PREDICTOR_FAMILY}-${historyWindows}`;
}

/**
 * Least-squares fit over the points, or null when there are fewer than two
 * points or every point shares one `t`.
 *
 * Pure. Accumulates in array order, so two callers holding the same points in
 * the same order produce bit-identical coefficients.
 */
export function fitTrend(points: readonly Point[]): LinearModel | null {
  if (points.length < 2) return null;

  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n;
  const meanV = points.reduce((sum, p) => sum + p.v, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const dt = point.t - meanT;
    covariance += dt * (point.v - meanV);
    variance += dt * dt;
  }

  if (variance === 0) return null;

  const slope = covariance / variance;
  return { slope, intercept: meanV - slope * meanT };
}

/** `model.slope * t + model.intercept`. Pure. */
export function predictAt(model: LinearModel, t: number): number {
  return model.slope * t + model.intercept;
}

/**
 * Returns the points `model` predicts at every `stepMs` boundary strictly
 * between `fromWindowStart` and `toWindowStart`, ascending.
 *
 * Pure. Empty when the two bounds are adjacent, equal, or out of order. When
 * the gap holds more than `limit` boundaries, returns the newest `limit`,
 * since those are the ones nearest `toWindowStart`.
 */
export function reconstructGap(
  model: LinearModel,
  fromWindowStart: number,
  toWindowStart: number,
  stepMs: number,
  limit: number,
): readonly Point[] {
  if (stepMs <= 0 || limit <= 0) return [];

  const count = Math.floor((toWindowStart - fromWindowStart) / stepMs) - 1;
  if (count <= 0) return [];

  const kept = Math.min(count, limit);
  const first = toWindowStart - kept * stepMs;

  const points: Point[] = [];
  for (let i = 0; i < kept; i++) {
    const t = first + i * stepMs;
    points.push({ t, v: predictAt(model, t) });
  }
  return points;
}
