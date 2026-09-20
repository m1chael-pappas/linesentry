import type { ForwardedWindow, SensorType } from '@linesentry/core';

/** Below this the machine is not turning. */
const STOPPED_RPM = 50;

/** Below this the machine is drawing no meaningful current. */
const STOPPED_CURRENT = 0.5;

/** Recent windows per machine and sensor, used for the trend fit. */
export interface HistoryBuffer {
  add(window: ForwardedWindow): readonly ForwardedWindow[];
  latest(machineId: string, sensorType: SensorType): ForwardedWindow | undefined;
  size(): number;
}

function key(window: ForwardedWindow): string {
  return `${window.machine_id}#${window.sensor_type}`;
}

/**
 * Keeps the last N windows for each machine and sensor, in memory.
 *
 * This is the only state the detection service holds, and it is deliberately
 * disposable. A task that starts with an empty buffer simply cannot make a
 * remaining-useful-life prediction until it has seen enough windows, which the
 * trend rule handles by returning nothing rather than failing. Losing it to a
 * restart costs a few minutes of prediction, never a threshold breach or an
 * anomaly, since both of those judge a single window on its own.
 *
 * Windows are stored in window_start order rather than arrival order, because
 * a redelivery can arrive after a newer window and a trend fitted through
 * shuffled points is meaningless.
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
 * Whether a machine is stopped rather than faulty.
 *
 * A stopped machine reads zero rpm and zero current, and against a running
 * baseline that looks like a severe anomaly on every sensor it has. Without
 * this check, shutting a machine down because of one fault immediately raises
 * fresh alerts about the machine being shut down, so the system alarms about
 * its own remediation.
 *
 * Both signals are required. A seized motor reads zero rpm while still drawing
 * current, and that is a real fault that has to keep alerting.
 */
export function looksStopped(history: HistoryBuffer, machineId: string): boolean {
  const rpm = history.latest(machineId, 'rpm');
  const current = history.latest(machineId, 'current');
  if (!rpm || !current) return false;
  return rpm.smoothed < STOPPED_RPM && current.smoothed < STOPPED_CURRENT;
}
