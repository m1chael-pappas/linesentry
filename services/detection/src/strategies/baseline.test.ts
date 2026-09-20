import { describe, expect, it } from 'vitest';
import type { DetectionContext, ForwardedWindow, MachineMetadata } from '@linesentry/core';
import { createBaselineDetection, crossingTime, zScore } from './baseline.js';

const WINDOW_MS = 10000;
const START = 1789000000000;

const config = { zScoreSigma: 3, historyWindows: 6, rulHorizonMs: 300000 };

const metadata: MachineMetadata = {
  machine_id: 'press-01',
  site_id: 'plant-01',
  line_id: 'line-A',
  baseline: { temperature: { mean: 55, sd: 1.5 }, vibration: { mean: 2.1, sd: 0.08 } },
  thresholds: { temperature: 80, vibration: 6 },
};

function window(smoothed: number, index = 0, sensor: 'temperature' | 'vibration' = 'temperature'): ForwardedWindow {
  const windowStart = START + index * WINDOW_MS;
  return {
    edge_ts: windowStart + WINDOW_MS,
    window_start: windowStart,
    window_end: windowStart + WINDOW_MS,
    window: '10s',
    site_id: 'plant-01',
    line_id: 'line-A',
    machine_id: 'press-01',
    sensor_type: sensor,
    unit: sensor === 'temperature' ? 'C' : 'mm/s',
    count: 10,
    mean: smoothed,
    min: smoothed,
    max: smoothed,
    rms: smoothed,
    smoothed,
    forward_reason: 'changed',
  };
}

function context(history: ForwardedWindow[] = []): DetectionContext {
  return { metadata, history };
}

describe('crossingTime', () => {
  it('finds when a rising line reaches the threshold', () => {
    expect(crossingTime({ slope: 2, intercept: 0 }, 100, 50)).toBe(50);
  });

  it('never crosses on a falling line', () => {
    expect(crossingTime({ slope: -2, intercept: 200 }, 100, 50)).toBeNull();
  });

  it('does not predict what has already happened', () => {
    expect(crossingTime({ slope: 2, intercept: 0 }, 100, 120)).toBeNull();
  });
});

describe('zScore', () => {
  it('measures distance in standard deviations', () => {
    expect(zScore(58, 55, 1.5)).toBe(2);
  });

  it('is zero when the baseline has no spread', () => {
    expect(zScore(58, 55, 0)).toBe(0);
  });
});

describe('baseline strategy', () => {
  const strategy = createBaselineDetection(config);

  it('says nothing about a healthy window', () => {
    expect(strategy.evaluate(window(55.4), context())).toEqual([]);
  });

  it('flags a window beyond three sigma', () => {
    const findings = strategy.evaluate(window(60), context());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe('anomaly');
    expect(findings[0]?.reason).toContain('z-score');
  });

  it('escalates to high severity past six sigma', () => {
    expect(strategy.evaluate(window(65), context())[0]?.severity).toBe('high');
  });

  it('fires the safety threshold even when the z-score does not', () => {
    const highBaseline: MachineMetadata = {
      ...metadata,
      baseline: { temperature: { mean: 85, sd: 10 } },
    };
    const findings = strategy.evaluate(window(82), { metadata: highBaseline, history: [] });
    expect(findings.map((f) => f.type)).toEqual(['threshold-breach']);
  });

  it('predicts a failure from a rising trend inside the horizon', () => {
    const history = [60, 62, 64, 66, 68, 70].map((value, index) => window(value, index));
    const findings = strategy.evaluate(history[5]!, context(history));
    expect(findings.map((f) => f.type)).toContain('predicted-failure');
  });

  it('makes no prediction before it has enough history', () => {
    const history = [60, 62, 64].map((value, index) => window(value, index));
    const findings = strategy.evaluate(history[2]!, context(history));
    expect(findings.map((f) => f.type)).not.toContain('predicted-failure');
  });

  it('makes no prediction when the crossing is beyond the horizon', () => {
    const history = [55, 55.1, 55.2, 55.3, 55.4, 55.5].map((value, index) => window(value, index));
    const findings = strategy.evaluate(history[5]!, context(history));
    expect(findings.map((f) => f.type)).not.toContain('predicted-failure');
  });
});
