import { SENSOR_TYPES, type MachineMetadata, type SensorType } from './contracts.js';

/**
 * Per-sensor safety limits in each sensor's own unit.
 *
 * A smoothed value at or above the limit is a `threshold-breach`. Sensors
 * absent from this map have no threshold rule and no trend rule. See
 * ../DETECTION.md.
 */
export const SAFETY_THRESHOLDS: Partial<Record<SensorType, number>> = {
  temperature: 80,
  vibration: 6,
  current: 20,
};

/**
 * Per-sensor standard deviation of the smoothed window value for a healthy
 * machine, used as the denominator of the z-score.
 *
 * Measured after 10 sample averaging and EWMA smoothing, not per sample. See
 * ../DETECTION.md.
 */
export const BASELINE_SD: Record<SensorType, number> = {
  vibration: 0.08,
  temperature: 1.5,
  current: 2.0,
  rpm: 10,
};

/** Which side of the baseline is worth alarming about. */
export type AlarmDirection = 'above' | 'below';

/**
 * The tail of each sensor's distribution the z-score rule alarms on.
 *
 * `above` alarms on positive z-scores only, `below` on negative only. See
 * ../DETECTION.md.
 */
export const ALARM_DIRECTION: Record<SensorType, AlarmDirection> = {
  vibration: 'above',
  temperature: 'above',
  current: 'above',
  rpm: 'below',
};

/**
 * Returns the metadata row for one machine, taking each baseline mean from
 * `base`, each spread from `BASELINE_SD`, and `SAFETY_THRESHOLDS` as the
 * thresholds.
 *
 * Pure. See ../DETECTION.md.
 */
export function machineMetadata(
  machineId: string,
  siteId: string,
  lineId: string,
  base: Record<SensorType, number>,
): MachineMetadata {
  const baseline: MachineMetadata['baseline'] = {};
  for (const sensor of SENSOR_TYPES) {
    baseline[sensor] = { mean: base[sensor], sd: BASELINE_SD[sensor] };
  }

  return { machine_id: machineId, site_id: siteId, line_id: lineId, baseline, thresholds: SAFETY_THRESHOLDS };
}
