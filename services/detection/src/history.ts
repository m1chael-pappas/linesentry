import type { ForwardedWindow, SensorType } from '@linesentry/core';

/** rpm below this counts as not turning. */
const STOPPED_RPM = 50;

/** Amps below this count as drawing no current. */
const STOPPED_CURRENT = 0.5;

/** `latest` returns the newest window held for a key, or undefined. */
export interface HistoryBuffer {
  add(window: ForwardedWindow): readonly ForwardedWindow[];
  latest(machineId: string, sensorType: SensorType): ForwardedWindow | undefined;
  size(): number;
}

function key(window: ForwardedWindow): string {
  return `${window.machine_id}#${window.sensor_type}`;
}

/**
 * Returns an in-memory buffer holding at most `capacity` windows per
 * machine-and-sensor key, ordered by `window_start` ascending.
 *
 * `add` replaces any window already held with the same `window_start`, sorts,
 * trims to the newest `capacity` and returns the resulting list. Unbounded in
 * the number of keys. See ../../packages/core/DETECTION.md.
 */
export function createHistoryBuffer(capacity: number): HistoryBuffer {
  const buffers = new Map<string, ForwardedWindow[]>();

  return {
    add(window) {
      const id = key(window);
      const existing = buffers.get(id) ?? [];

      const deduped = existing.filter((held) => held.window_start !== window.window_start);
      deduped.push(window);
      deduped.sort((a, b) => a.window_start - b.window_start);

      const trimmed = deduped.slice(-capacity);
      buffers.set(id, trimmed);
      return trimmed;
    },

    latest(machineId, sensorType) {
      const held = buffers.get(`${machineId}#${sensorType}`);
      return held?.[held.length - 1];
    },

    size() {
      return buffers.size;
    },
  };
}

/**
 * True when the machine's latest rpm window is below `STOPPED_RPM` and its
 * latest current window is below `STOPPED_CURRENT`.
 *
 * False when either window is absent. See ../../packages/core/DETECTION.md.
 */
export function looksStopped(history: HistoryBuffer, machineId: string): boolean {
  const rpm = history.latest(machineId, 'rpm');
  const current = history.latest(machineId, 'current');
  if (!rpm || !current) return false;
  return rpm.smoothed < STOPPED_RPM && current.smoothed < STOPPED_CURRENT;
}
