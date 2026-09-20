import { describe, expect, it } from 'vitest';
import { eventId, type DetectionFinding, type ForwardedWindow } from '@linesentry/core';
import { buildEvent, eventRank } from './events.js';

const window: ForwardedWindow = {
  edge_ts: 1789000010000,
  window_start: 1789000000000,
  window_end: 1789000010000,
  window: '10s',
  site_id: 'plant-01',
  line_id: 'line-A',
  machine_id: 'press-01',
  sensor_type: 'temperature',
  unit: 'C',
  count: 10,
  mean: 82,
  min: 81,
  max: 83,
  rms: 82,
  smoothed: 82,
  forward_reason: 'changed',
  ingest_ts: 1789000010500,
};

const anomaly: DetectionFinding = { type: 'anomaly', severity: 'medium', reason: 'temperature z-score 4.8' };
const breach: DetectionFinding = { type: 'threshold-breach', severity: 'high', reason: 'temperature 82 C at or above safety limit 80' };
const prediction: DetectionFinding = { type: 'predicted-failure', severity: 'medium', reason: 'trending to limit' };

describe('buildEvent', () => {
  it('produces nothing when no rule fired', () => {
    expect(buildEvent(window, [], Date.now())).toBeNull();
  });

  it('gives the same id to the same window however many rules fired', () => {
    const one = buildEvent(window, [anomaly], 1)!;
    const many = buildEvent(window, [anomaly, breach, prediction], 2)!;
    expect(one.event_id).toBe(many.event_id);
    expect(one.event_id).toBe(eventId('press-01', 'temperature', 1789000000000));
  });

  it('folds several findings into one event rather than several', () => {
    const event = buildEvent(window, [anomaly, breach, prediction], 1)!;
    expect(event.reason).toContain('z-score');
    expect(event.reason).toContain('safety limit');
    expect(event.reason).toContain('trending');
  });

  it('takes the worst severity', () => {
    expect(buildEvent(window, [anomaly, breach], 1)!.severity).toBe('high');
  });

  it('reports a threshold breach ahead of the other rules, since that is what stops the machine', () => {
    expect(buildEvent(window, [anomaly, prediction, breach], 1)!.type).toBe('threshold-breach');
  });

  it('reports a prediction ahead of a plain anomaly', () => {
    expect(buildEvent(window, [anomaly, prediction], 1)!.type).toBe('predicted-failure');
  });

  it('carries the latency stamps through from the window', () => {
    const event = buildEvent(window, [breach], 1789000011000)!;
    expect(event.edge_ts).toBe(window.edge_ts);
    expect(event.ingest_ts).toBe(window.ingest_ts);
    expect(event.detected_ts).toBe(1789000011000);
  });

  it('opens every event', () => {
    expect(buildEvent(window, [breach], 1)!.status).toBe('open');
  });
});

describe('eventRank', () => {
  it('ranks a threshold breach above any anomaly', () => {
    const breachEvent = buildEvent(window, [breach], 1)!;
    const anomalyEvent = buildEvent(window, [{ ...anomaly, severity: 'high' }], 1)!;
    expect(eventRank(breachEvent)).toBeGreaterThan(eventRank(anomalyEvent));
  });

  it('ranks a prediction above an anomaly', () => {
    expect(eventRank(buildEvent(window, [prediction], 1)!)).toBeGreaterThan(
      eventRank(buildEvent(window, [anomaly], 1)!),
    );
  });

  it('ranks a worse severity above a milder one of the same type', () => {
    const mild = buildEvent(window, [{ ...anomaly, severity: 'medium' }], 1)!;
    const severe = buildEvent(window, [{ ...anomaly, severity: 'high' }], 1)!;
    expect(eventRank(severe)).toBeGreaterThan(eventRank(mild));
  });
});
