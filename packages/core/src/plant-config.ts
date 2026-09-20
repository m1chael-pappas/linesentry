import type { SensorType } from './contracts.js';

/**
 * Fixed safety limits, applied regardless of what a machine's baseline says.
 *
 * These exist so an obvious danger still fires when the z-score does not, for
 * instance on a machine whose baseline is already high or whose recent history
 * has drifted far enough that the anomaly looks normal.
 *
 * A breach of one of these is what escalates an alert from a beacon to a
 * shutdown. Values are chosen against the simulated signal: see
 * ../../simulator/SIMULATION.md for the fault ramps they sit above.
 */
export const SAFETY_THRESHOLDS: Partial<Record<SensorType, number>> = {
  temperature: 80,
  vibration: 6,
  current: 20,
};

/**
 * Expected spread of the smoothed window value for a healthy machine.
 *
 * This is not the spread of a raw sensor sample. By the time detection sees a
 * value it has been averaged over a 10 second window and then EWMA smoothed,
 * which removes most of the sample noise, so a sample-level sd would make
 * every window look like a 20 sigma event.
 *
 * What remains is the systematic movement the simulator puts in deliberately:
 * a slow sine on temperature and a bounded random walk on load that drives
 * current. Those dominate, which is why these numbers are much larger than the
 * per-sample noise. Tuned against a no-fault run: see ../DETECTION.md.
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
 * The dangerous direction for each sensor.
 *
 * Only one tail of each sensor means trouble. A press running cooler, quieter
 * or drawing less current than usual is not a fault, and alarming on it
 * produces noise that buries the real thing. Rpm is the exception: the
 * dangerous direction is downward, because rpm sags under a jam or a failing
 * drive.
 *
 * This matters most right after a shutdown, when every sensor on the stopped
 * machine reads far below its running baseline at once.
 */
export const ALARM_DIRECTION: Record<SensorType, AlarmDirection> = {
  vibration: 'above',
  temperature: 'above',
  current: 'above',
  rpm: 'below',
};
