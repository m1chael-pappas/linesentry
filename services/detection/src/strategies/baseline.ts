import {
  ALARM_DIRECTION,
  detectionRegistry,
  type DetectionConfig,
  type DetectionContext,
  type DetectionFinding,
  type DetectionStrategy,
  type ForwardedWindow,
} from '@linesentry/core';

/** A straight line fitted through a set of points. */
export interface Trend {
  slope: number;
  intercept: number;
}

/**
 * Fits a least-squares line to the points, or returns null when it cannot.
 *
 * Fewer than two points has no trend, and points sharing one timestamp give a
 * vertical line whose slope is meaningless.
 */
export function fitTrend(points: readonly { t: number; v: number }[]): Trend | null {
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

/**
 * When a rising trend will reach the threshold, or null if it will not.
 *
 * A flat or falling trend never crosses, and a value already past the
 * threshold is a breach rather than a prediction, so both return null and let
 * the threshold rule handle it.
 */
export function crossingTime(trend: Trend, threshold: number, current: number): number | null {
  if (trend.slope <= 0) return null;
  if (current >= threshold) return null;
  return (threshold - trend.intercept) / trend.slope;
}

/** How far a value sits from its baseline, in standard deviations. */
export function zScore(value: number, mean: number, sd: number): number {
  if (sd <= 0) return 0;
  return (value - mean) / sd;
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function thresholdFinding(
  window: ForwardedWindow,
  context: DetectionContext,
): DetectionFinding | null {
  const limit = context.metadata.thresholds[window.sensor_type];
  if (limit === undefined || window.smoothed < limit) return null;

  return {
    type: 'threshold-breach',
    severity: 'high',
    reason: `${window.sensor_type} ${round(window.smoothed, 2)} ${window.unit} at or above safety limit ${limit}`,
  };
}

function anomalyFinding(
  window: ForwardedWindow,
  context: DetectionContext,
  config: DetectionConfig,
): DetectionFinding | null {
  const baseline = context.metadata.baseline[window.sensor_type];
  if (!baseline) return null;

  const score = zScore(window.smoothed, baseline.mean, baseline.sd);
  const dangerous = ALARM_DIRECTION[window.sensor_type] === 'above' ? score : -score;
  if (dangerous < config.zScoreSigma) return null;

  return {
    type: 'anomaly',
    severity: dangerous >= config.zScoreSigma * 2 ? 'high' : 'medium',
    reason: `${window.sensor_type} z-score ${round(score, 1)}`,
  };
}

function predictionFinding(
  window: ForwardedWindow,
  context: DetectionContext,
  config: DetectionConfig,
): DetectionFinding | null {
  const limit = context.metadata.thresholds[window.sensor_type];
  if (limit === undefined) return null;

  const points = context.history
    .slice(-config.historyWindows)
    .map((historic) => ({ t: historic.window_start, v: historic.smoothed }));
  if (points.length < config.historyWindows) return null;

  const trend = fitTrend(points);
  if (!trend) return null;

  const crossesAt = crossingTime(trend, limit, window.smoothed);
  if (crossesAt === null) return null;

  const remainingMs = crossesAt - window.window_start;
  if (remainingMs <= 0 || remainingMs > config.rulHorizonMs) return null;

  return {
    type: 'predicted-failure',
    severity: 'medium',
    reason: `${window.sensor_type} trending to safety limit ${limit} in ${Math.round(remainingMs / 1000)}s`,
  };
}

/**
 * The detection rules this build ships with.
 *
 * The three rules are independent and all of them run. A safety threshold
 * breach fires regardless of the z-score, because a machine whose baseline is
 * already high, or whose recent history has drifted, can be in obvious danger
 * while looking statistically unremarkable.
 */
export function createBaselineDetection(config: DetectionConfig): DetectionStrategy {
  return {
    name: 'baseline',
    evaluate(window, context) {
      return [
        thresholdFinding(window, context),
        anomalyFinding(window, context, config),
        predictionFinding(window, context, config),
      ].filter((finding): finding is DetectionFinding => finding !== null);
    },
  };
}

detectionRegistry.register('baseline', createBaselineDetection);
