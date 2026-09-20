import {
  ALARM_DIRECTION,
  detectionRegistry,
  fitTrend,
  type DetectionConfig,
  type DetectionContext,
  type DetectionFinding,
  type DetectionStrategy,
  type ForwardedWindow,
  type LinearModel,
} from '@linesentry/core';

/**
 * The `t` at which `trend` reaches `threshold`, or null when the slope is not
 * positive or `current` is already at or above `threshold`.
 *
 * Pure.
 */
export function crossingTime(trend: LinearModel, threshold: number, current: number): number | null {
  if (trend.slope <= 0) return null;
  if (current >= threshold) return null;
  return (threshold - trend.intercept) / trend.slope;
}

/** `(value - mean) / sd`, or 0 when `sd` is not positive. Pure. */
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
 * Returns the `baseline` detection strategy: a safety threshold rule, a
 * directional z-score rule and a least-squares trend rule.
 *
 * All three run on every window and each may contribute a finding. See
 * ../../../packages/core/DETECTION.md.
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
