import {
  WINDOW_MS,
  detectionRegistry,
  readDualPrediction,
  reconstructGap,
  type DetectionConfig,
  type DetectionStrategy,
  type ForwardedWindow,
} from '@linesentry/core';
import { createBaselineDetection } from './baseline.js';

/**
 * Returns the windows the gateway suppressed before `window`, newest last.
 *
 * Pure. Empty when `window` carries no dual prediction extension, which is
 * every window from the baseline arm. At most `limit` windows are returned,
 * the ones nearest `window`, since the rules read only that many. Each one
 * holds the predicted value in every statistic and `count` 0, because a
 * reconstructed window summarises no samples. See
 * ../../../../packages/core/DETECTION.md.
 */
export function reconstructWindows(
  window: ForwardedWindow,
  limit: number,
): readonly ForwardedWindow[] {
  const ext = readDualPrediction(window.ext);
  if (!ext) return [];

  return reconstructGap(
    ext.model,
    ext.last_forwarded_window_start,
    window.window_start,
    WINDOW_MS,
    limit,
  ).map((point) => ({
    ...window,
    window_start: point.t,
    window_end: point.t + WINDOW_MS,
    count: 0,
    mean: point.v,
    min: point.v,
    max: point.v,
    rms: point.v,
    smoothed: point.v,
    ext: undefined,
  }));
}

/**
 * Returns the `dual-prediction` detection strategy: the `baseline` rules,
 * judged against the reconstructed series rather than the forwarded one.
 *
 * `evaluate` rebuilds the windows the gateway suppressed from the model the
 * window carries, appends the window itself, and passes the result to
 * `baseline.evaluate` as the history. The three rules are the baseline's, so
 * the filter is the only difference between the arms.
 *
 * Pure, and stateless across calls, so a task that just started reconstructs a
 * gap as well as one that has been running for an hour. Reconstructed windows
 * contribute to the rules but raise no event of their own, so event identity
 * and deduplication are unchanged. See
 * ../../../../packages/core/DETECTION.md.
 */
export function createDualPredictionDetection(config: DetectionConfig): DetectionStrategy {
  const baseline = createBaselineDetection(config);

  return {
    name: 'dual-prediction',
    evaluate(window, context) {
      const reconstructed = reconstructWindows(window, config.historyWindows);
      if (reconstructed.length === 0) return baseline.evaluate(window, context);

      const dense = [...reconstructed, window].slice(-config.historyWindows);
      return baseline.evaluate(window, { metadata: context.metadata, history: dense });
    },
  };
}

detectionRegistry.register('dual-prediction', createDualPredictionDetection);
