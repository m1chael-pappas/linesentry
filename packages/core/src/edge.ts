import type { RawReading, SensorType, WindowExtension } from './contracts.js';
import { BASELINE_SD, SAFETY_THRESHOLDS } from './plant-config.js';
import {
  fitTrend,
  gapWindowCount,
  predictAt,
  predictorVersion,
  type LinearModel,
  type Point,
} from './predictor.js';
import {
  edgeFilterRegistry,
  type EdgeFilterConfig,
  type EdgeFilterDecision,
  type EdgeFilterStrategy,
  type PendingWindow,
} from './strategies.js';

/** Width of one aggregation window in milliseconds. */
export const WINDOW_MS = 10000;

/** How long past its close a window waits before the flush tick emits it. */
export const FLUSH_GRACE_MS = 3000;

/** Weight the EWMA gives the newest window mean. */
export const EWMA_ALPHA = 0.3;

/** Interval after which a filter forwards a window it would otherwise drop. */
export const HEARTBEAT_MS = 60000;

/** Smoothed-value movement the `deadband` filter treats as meaningful. */
export const DEADBAND: Record<SensorType, number> = {
  vibration: 0.15,
  temperature: 1.0,
  current: 0.5,
  rpm: 20,
};

/** Windows the `dual-prediction` filter fits its model over. */
export const PREDICTOR_HISTORY_WINDOWS = 6;

/** Error bound the `dual-prediction` filter uses when none is configured. */
export const DEFAULT_ERROR_BOUND_SIGMA = 1;

/** A closed window before smoothing has added `smoothed`. */
export type WindowSummary = Omit<PendingWindow, 'smoothed'>;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sensorKey(machineId: string, sensorType: SensorType): string {
  return `${machineId}/${sensorType}`;
}

interface OpenWindow {
  window_start: number;
  site_id: string;
  line_id: string;
  machine_id: string;
  sensor_type: SensorType;
  unit: PendingWindow['unit'];
  values: number[];
}

/** `add` returns the window a reading closed. `flush` returns idle windows. */
export interface WindowAggregator {
  add(reading: RawReading, now: number): WindowSummary | null;
  flush(now: number): WindowSummary[];
  open(): number;
}

function summarise(open: OpenWindow, now: number): WindowSummary {
  const n = open.values.length;
  let sum = 0;
  let sumSq = 0;
  for (const value of open.values) {
    sum += value;
    sumSq += value * value;
  }

  return {
    edge_ts: now,
    window_start: open.window_start,
    window_end: open.window_start + WINDOW_MS,
    window: '10s',
    site_id: open.site_id,
    line_id: open.line_id,
    machine_id: open.machine_id,
    sensor_type: open.sensor_type,
    unit: open.unit,
    count: n,
    mean: round3(sum / n),
    min: Math.min(...open.values),
    max: Math.max(...open.values),
    rms: round3(Math.sqrt(sumSq / n)),
  };
}

/**
 * Returns an aggregator rolling raw readings into fixed `WINDOW_MS` windows,
 * one per machine and sensor.
 *
 * A window is returned by `add` when a reading arrives that belongs to a later
 * window, and by `flush` once it has been closed for `FLUSH_GRACE_MS`. Without
 * the flush a key that stops publishing strands its last window. Stateful. See
 * ../EDGE.md.
 */
export function createWindowAggregator(): WindowAggregator {
  const windows = new Map<string, OpenWindow>();

  return {
    add(reading, now) {
      const key = sensorKey(reading.machine_id, reading.sensor_type);
      const windowStart = Math.floor(reading.ts / WINDOW_MS) * WINDOW_MS;

      const held = windows.get(key);
      let closed: WindowSummary | null = null;
      let current = held;

      if (held && held.window_start !== windowStart) {
        closed = summarise(held, now);
        current = undefined;
      }

      if (!current) {
        current = {
          window_start: windowStart,
          site_id: reading.site_id,
          line_id: reading.line_id,
          machine_id: reading.machine_id,
          sensor_type: reading.sensor_type,
          unit: reading.unit,
          values: [],
        };
      }

      current.values.push(reading.value);
      windows.set(key, current);
      return closed;
    },

    flush(now) {
      const emitted: WindowSummary[] = [];
      for (const [key, open] of windows) {
        if (now >= open.window_start + WINDOW_MS + FLUSH_GRACE_MS) {
          emitted.push(summarise(open, now));
          windows.delete(key);
        }
      }
      return emitted;
    },

    open() {
      return windows.size;
    },
  };
}

/** Adds `smoothed` to a window summary. Stateful, one state per sensor key. */
export interface EwmaSmoother {
  apply(summary: WindowSummary): PendingWindow;
}

/**
 * Returns a smoother applying `smoothed = alpha * mean + (1 - alpha) * prev`,
 * seeded with the first window's mean.
 *
 * Carries the unrounded value forward and rounds only what it writes onto the
 * window, so rounding does not accumulate. See ../EDGE.md.
 */
export function createEwmaSmoother(alpha = EWMA_ALPHA): EwmaSmoother {
  const state = new Map<string, number>();

  return {
    apply(summary) {
      const key = sensorKey(summary.machine_id, summary.sensor_type);
      const previous = state.get(key);
      const smoothed = previous === undefined ? summary.mean : alpha * summary.mean + (1 - alpha) * previous;
      state.set(key, smoothed);
      return { ...summary, smoothed: round3(smoothed) };
    },
  };
}

interface DeadbandState {
  value: number;
  sent: number;
}

/**
 * Returns the `deadband` edge filter: forward when the smoothed value has
 * moved at least the sensor's band since the last forward, or when the
 * heartbeat is due.
 *
 * `now` is wall clock, so the heartbeat measures elapsed real time rather
 * than window time. Stateful. See ../EDGE.md.
 */
export function createDeadbandFilter(config: EdgeFilterConfig): EdgeFilterStrategy {
  const last = new Map<string, DeadbandState>();

  return {
    name: 'deadband',
    decide(window, now) {
      const key = sensorKey(window.machine_id, window.sensor_type);
      const previous = last.get(key);
      const band = config.deadband[window.sensor_type] ?? 0;

      let reason: EdgeFilterDecision['reason'];
      if (!previous) reason = 'first';
      else if (Math.abs(window.smoothed - previous.value) >= band) reason = 'changed';
      else if (now - previous.sent >= config.heartbeatMs) reason = 'heartbeat';

      if (!reason) return { forward: false };

      last.set(key, { value: window.smoothed, sent: now });
      return { forward: true, reason };
    },
  };
}

interface PredictorState {
  buffer: Point[];
  model: LinearModel | null;
  lastForwardedWindowStart: number | null;
}

/**
 * Fields a `dual-prediction` forward carries in `ext`.
 *
 * `model` is the model that governed the gap this window closes, not the one
 * refitted after it, so the consumer replays exactly what the gateway
 * predicted. `model` and `last_forwarded_window_start` are absent on the first
 * forward for a key, which closes no gap. See ../EDGE.md.
 */
export interface DualPredictionExtension {
  predictor_version: string;
  model?: LinearModel;
  last_forwarded_window_start?: number;
  divergence?: number;
}

/**
 * Returns the `ext` fields a `dual-prediction` forward carries, or null when
 * the window carries no usable model or gap.
 *
 * Pure. Validates every field it reads, so a window from another arm or a
 * malformed extension returns null rather than throwing.
 */
export function readDualPrediction(ext: unknown): Required<DualPredictionExtension> | null {
  if (typeof ext !== 'object' || ext === null) return null;

  const fields = ext as Record<string, unknown>;
  const model = fields.model as Record<string, unknown> | undefined;
  const from = fields.last_forwarded_window_start;

  if (typeof fields.predictor_version !== 'string') return null;
  if (typeof from !== 'number' || !Number.isFinite(from)) return null;
  if (typeof model !== 'object' || model === null) return null;
  if (typeof model.slope !== 'number' || !Number.isFinite(model.slope)) return null;
  if (typeof model.intercept !== 'number' || !Number.isFinite(model.intercept)) return null;

  return {
    predictor_version: fields.predictor_version,
    model: { slope: model.slope, intercept: model.intercept },
    last_forwarded_window_start: from,
    divergence: typeof fields.divergence === 'number' ? fields.divergence : 0,
  };
}

/**
 * Returns how many windows the gateway suppressed before the one carrying
 * `ext`, uncapped.
 *
 * Pure. Zero for a window from an arm that sets no dual prediction extension.
 */
export function dualPredictionGapSize(ext: unknown, windowStart: number): number {
  const read = readDualPrediction(ext);
  if (!read) return 0;
  return gapWindowCount(read.last_forwarded_window_start, windowStart, WINDOW_MS, Infinity);
}

/**
 * Returns the `dual-prediction` edge filter: fit a least-squares line over the
 * last `historyWindows` smoothed values, and forward only when the real value
 * diverges from that line by more than `errorBoundSigma` standard deviations
 * for the sensor, or when the heartbeat is due.
 *
 * A forward carries the model that governed the preceding gap, so the consumer
 * reconstructs the suppressed windows holding no state of its own. The
 * heartbeat measures window time rather than wall clock, which makes `decide`
 * a function of the window stream alone.
 *
 * A window at or above the sensor's entry in `SAFETY_THRESHOLDS`, or one whose
 * prediction is at or above it, forwards as `safety` whatever the divergence.
 * A linear ramp to a safety limit is exactly what the model tracks, so without
 * this the breach would wait for the heartbeat. Stateful. See ../EDGE.md.
 */
export function createDualPredictionFilter(config: EdgeFilterConfig): EdgeFilterStrategy {
  const historyWindows = config.historyWindows ?? PREDICTOR_HISTORY_WINDOWS;
  const sigma = config.errorBoundSigma ?? DEFAULT_ERROR_BOUND_SIGMA;
  const version = predictorVersion(historyWindows);
  const states = new Map<string, PredictorState>();

  return {
    name: 'dual-prediction',
    decide(window) {
      const key = sensorKey(window.machine_id, window.sensor_type);
      const state = states.get(key) ?? {
        buffer: [],
        model: null,
        lastForwardedWindowStart: null,
      };
      states.set(key, state);

      const governing = state.model;
      const from = state.lastForwardedWindowStart;
      const predicted = governing === null ? null : predictAt(governing, window.window_start);
      const divergence = predicted === null ? null : Math.abs(window.smoothed - predicted);

      state.buffer.push({ t: window.window_start, v: window.smoothed });
      if (state.buffer.length > historyWindows) state.buffer.shift();

      const bound = sigma * BASELINE_SD[window.sensor_type];
      const limit = SAFETY_THRESHOLDS[window.sensor_type];
      const breaching =
        limit !== undefined && (window.smoothed >= limit || (predicted !== null && predicted >= limit));

      let reason: EdgeFilterDecision['reason'];
      if (governing === null || from === null) reason = 'first';
      else if (breaching) reason = 'safety';
      else if (divergence !== null && divergence > bound) reason = 'divergence';
      else if (window.window_start - from >= config.heartbeatMs) reason = 'heartbeat';

      if (!reason) return { forward: false };

      const ext: WindowExtension = { predictor_version: version };
      if (governing !== null && from !== null) {
        ext.model = governing;
        ext.last_forwarded_window_start = from;
      }
      if (divergence !== null) ext.divergence = round3(divergence);

      state.model = fitTrend(state.buffer);
      state.lastForwardedWindowStart = window.window_start;

      return { forward: true, reason, ext };
    },
  };
}

edgeFilterRegistry.register('deadband', createDeadbandFilter);
edgeFilterRegistry.register('dual-prediction', createDualPredictionFilter);

/** Configuration both filters are built from when nothing overrides it. */
export const DEFAULT_EDGE_FILTER_CONFIG: EdgeFilterConfig = {
  deadband: DEADBAND,
  heartbeatMs: HEARTBEAT_MS,
  errorBoundSigma: DEFAULT_ERROR_BOUND_SIGMA,
  historyWindows: PREDICTOR_HISTORY_WINDOWS,
};
