import { describe, expect, it } from 'vitest';
import type { ForwardedWindow } from '@linesentry/core';
import { createHistoryBuffer, looksStopped } from './history.js';

function window(index: number, machineId = 'press-01'): ForwardedWindow {
  const windowStart = 1789000000000 + index * 10000;
  return {
    edge_ts: windowStart + 10000,
    window_start: windowStart,
    window_end: windowStart + 10000,
    window: '10s',
    site_id: 'plant-01',
    line_id: 'line-A',
    machine_id: machineId,
    sensor_type: 'temperature',
    unit: 'C',
    count: 10,
    mean: index,
    min: index,
    max: index,
    rms: index,
    smoothed: index,
    forward_reason: 'changed',
  };
}

describe('createHistoryBuffer', () => {
  it('keeps at most the capacity', () => {
    const buffer = createHistoryBuffer(3);
    let held: readonly ForwardedWindow[] = [];
    for (let i = 0; i < 10; i++) held = buffer.add(window(i));
    expect(held).toHaveLength(3);
    expect(held.map((w) => w.smoothed)).toEqual([7, 8, 9]);
  });

  it('keeps machines and sensors apart', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(window(0, 'press-01'));
    const other = buffer.add(window(0, 'press-02'));
    expect(other).toHaveLength(1);
    expect(buffer.size()).toBe(2);
  });

  it('orders by window start, not arrival, so a late redelivery does not skew the trend', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(window(3));
    buffer.add(window(1));
    const held = buffer.add(window(2));
    expect(held.map((w) => w.smoothed)).toEqual([1, 2, 3]);
  });

  it('replaces a window rather than holding it twice when it is redelivered', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(window(1));
    const held = buffer.add(window(1));
    expect(held).toHaveLength(1);
  });
});

describe('looksStopped', () => {
  function reading(sensor: 'rpm' | 'current', value: number): ForwardedWindow {
    return { ...window(0), sensor_type: sensor, smoothed: value, unit: sensor === 'rpm' ? 'rpm' : 'A' };
  }

  it('is false before both sensors have reported', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(reading('rpm', 0));
    expect(looksStopped(buffer, 'press-01')).toBe(false);
  });

  it('is true when the machine is neither turning nor drawing current', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(reading('rpm', 0));
    buffer.add(reading('current', 0));
    expect(looksStopped(buffer, 'press-01')).toBe(true);
  });

  it('is false for a seized motor, which reads no rpm while still drawing current', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(reading('rpm', 0));
    buffer.add(reading('current', 18));
    expect(looksStopped(buffer, 'press-01')).toBe(false);
  });

  it('is false for a running machine', () => {
    const buffer = createHistoryBuffer(5);
    buffer.add(reading('rpm', 1450));
    buffer.add(reading('current', 12));
    expect(looksStopped(buffer, 'press-01')).toBe(false);
  });
});
