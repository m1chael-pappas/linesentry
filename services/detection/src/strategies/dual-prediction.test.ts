import { describe, expect, it } from 'vitest';
import {
  WINDOW_MS,
  type DetectionConfig,
  type ForwardedWindow,
  type MachineMetadata,
} from '@linesentry/core';
import { createBaselineDetection } from './baseline.js';
import { createDualPredictionDetection, reconstructWindows } from './dual-prediction.js';

const START = 1789000000000;
const SLOPE = 0.0002;

const config: DetectionConfig = { zScoreSigma: 3, historyWindows: 6, rulHorizonMs: 300000 };

const metadata: MachineMetadata = {
  machine_id: 'press-01',
  site_id: 'plant-01',
  line_id: 'line-A',
  baseline: { temperature: { mean: 55, sd: 1.5 } },
  thresholds: { temperature: 80 },
};

/** `v = SLOPE * t + intercept`, holding `v(START) = 60`. */
const model = { slope: SLOPE, intercept: 60 - SLOPE * START };

/**
 * One forwarded window closing a six window gap.
 *
 * `smoothed` sits on the model line, so the reconstructed points and the
 * window itself describe one straight rise from 60 C.
 */
function forwarded(overrides: Partial<ForwardedWindow> = {}): ForwardedWindow {
  const windowStart = START + 6 * WINDOW_MS;
  const smoothed = model.slope * windowStart + model.intercept;

  return {
    edge_ts: windowStart,
    window_start: windowStart,
    window_end: windowStart + WINDOW_MS,
    window: '10s',
    site_id: 'plant-01',
    line_id: 'line-A',
    machine_id: 'press-01',
    sensor_type: 'temperature',
    unit: 'C',
    count: 10,
    mean: smoothed,
    min: smoothed,
    max: smoothed,
    rms: smoothed,
    smoothed,
    forward_reason: 'divergence',
    ext: {
      predictor_version: 'lsq-6',
      model,
      last_forwarded_window_start: START,
      divergence: 1.2,
    },
    ...overrides,
  };
}

describe('reconstructWindows', () => {
  it('returns nothing for a window from the baseline arm', () => {
    expect(reconstructWindows(forwarded({ ext: undefined }), 6)).toEqual([]);
  });

  it('returns nothing when the extension is malformed', () => {
    expect(reconstructWindows(forwarded({ ext: { predictor_version: 'lsq-6' } }), 6)).toEqual([]);
  });

  it('rebuilds every window strictly inside the gap', () => {
    const rebuilt = reconstructWindows(forwarded(), 10);
    expect(rebuilt.map((w) => w.window_start)).toEqual([
      START + WINDOW_MS,
      START + 2 * WINDOW_MS,
      START + 3 * WINDOW_MS,
      START + 4 * WINDOW_MS,
      START + 5 * WINDOW_MS,
    ]);
  });

  it('puts the predicted value in every statistic and marks the sample count zero', () => {
    const first = reconstructWindows(forwarded(), 10)[0]!;
    const predicted = model.slope * first.window_start + model.intercept;

    expect(first.smoothed).toBe(predicted);
    expect(first.mean).toBe(predicted);
    expect(first.count).toBe(0);
    expect(first.ext).toBeUndefined();
  });

  it('keeps the newest windows when the gap exceeds the limit', () => {
    const rebuilt = reconstructWindows(forwarded(), 2);
    expect(rebuilt.map((w) => w.window_start)).toEqual([
      START + 4 * WINDOW_MS,
      START + 5 * WINDOW_MS,
    ]);
  });
});

describe('dual prediction detection', () => {
  const strategy = createDualPredictionDetection(config);
  const baseline = createBaselineDetection(config);

  it('predicts the safety limit crossing from one message on a cold task', () => {
    const window = forwarded();
    const findings = strategy.evaluate(window, { metadata, history: [window] });

    expect(findings.map((f) => f.type)).toContain('predicted-failure');
  });

  it('is what the baseline cannot do with the same single message', () => {
    const window = forwarded();
    const findings = baseline.evaluate(window, { metadata, history: [window] });

    expect(findings.map((f) => f.type)).not.toContain('predicted-failure');
  });

  it('agrees with the baseline on a window carrying no extension', () => {
    const history = Array.from({ length: 6 }, (_, i) => {
      const windowStart = START + i * WINDOW_MS;
      return forwarded({
        ext: undefined,
        window_start: windowStart,
        window_end: windowStart + WINDOW_MS,
        smoothed: model.slope * windowStart + model.intercept,
      });
    });
    const window = history[5]!;

    expect(strategy.evaluate(window, { metadata, history })).toEqual(
      baseline.evaluate(window, { metadata, history }),
    );
  });

  it('reports the arriving window, not the reconstructed ones', () => {
    const window = forwarded();
    const findings = strategy.evaluate(window, { metadata, history: [window] });
    const prediction = findings.find((f) => f.type === 'predicted-failure');

    expect(prediction?.reason).toMatch(/trending to safety limit 80 in \d+s/);
    expect(findings.filter((f) => f.type === 'predicted-failure')).toHaveLength(1);
  });

  it('raises nothing on a flat reconstructed series', () => {
    const flat = { slope: 0, intercept: 55 };
    const window = forwarded({
      smoothed: 55,
      ext: {
        predictor_version: 'lsq-6',
        model: flat,
        last_forwarded_window_start: START,
        divergence: 0.1,
      },
    });

    expect(strategy.evaluate(window, { metadata, history: [window] })).toEqual([]);
  });
});
