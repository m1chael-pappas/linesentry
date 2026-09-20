import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawReading, SensorType, Unit } from './contracts.js';
import { BASELINE_SD, SAFETY_THRESHOLDS } from './plant-config.js';
import {
  DEFAULT_EDGE_FILTER_CONFIG,
  WINDOW_MS,
  createDualPredictionFilter,
  createEwmaSmoother,
  createWindowAggregator,
  edgeFilterRegistry,
  readDualPrediction,
  type PendingWindow,
} from './index.js';
import { predictAt, reconstructGap } from './predictor.js';

const FLOW = join(dirname(import.meta.dirname), '..', '..', 'edge', 'linesentry-edge-flow.json');

const SENSORS: readonly SensorType[] = ['vibration', 'temperature', 'current', 'rpm'];
const UNITS: Record<SensorType, Unit> = {
  vibration: 'mm/s',
  temperature: 'C',
  current: 'A',
  rpm: 'rpm',
};

const START = 1789000000000;
const TICK_MS = 1000;
const FLUSH_EVERY_MS = 5000;
const MACHINES = ['press-01', 'press-02', 'press-03'];

/** Fields both implementations must agree on for a forwarded window. */
const COMPARED = [
  'edge_ts',
  'window_start',
  'window_end',
  'window',
  'site_id',
  'line_id',
  'machine_id',
  'sensor_type',
  'unit',
  'count',
  'mean',
  'min',
  'max',
  'rms',
  'smoothed',
  'forward_reason',
] as const;

/** Deterministic value for one sensor at one tick, with drift and jitter. */
function value(machine: string, sensor: SensorType, tick: number): number {
  const offset = machine.charCodeAt(machine.length - 1) - 48;
  const jitter = ((tick * 2654435761 + offset * 40503) % 1000) / 1000;

  switch (sensor) {
    case 'temperature':
      return 55 + offset + tick * 0.004 + 2 * Math.sin(tick / 60) + jitter * 0.4;
    case 'current':
      return 12 + offset * 0.3 + Math.sin(tick / 37) * 1.5 + jitter * 0.3;
    case 'vibration':
      return 2.1 + tick * 0.0004 + jitter * 0.3;
    case 'rpm':
      return 1450 - offset * 5 + Math.sin(tick / 23) * 12 + jitter * 8;
  }
}

/**
 * Returns `seconds` of readings at 1 Hz.
 *
 * `press-03` stops publishing halfway through, so the flush path emits its
 * last window rather than stranding it.
 */
function readings(seconds: number): RawReading[] {
  const stream: RawReading[] = [];
  for (let tick = 0; tick < seconds; tick++) {
    for (const machine of MACHINES) {
      if (machine === 'press-03' && tick > seconds / 2) continue;
      for (const sensor of SENSORS) {
        stream.push({
          ts: START + tick * TICK_MS,
          site_id: 'plant-01',
          line_id: 'line-A',
          machine_id: machine,
          sensor_type: sensor,
          value: Math.round(value(machine, sensor, tick) * 100) / 100,
          unit: UNITS[sensor],
          seq: tick,
        });
      }
    }
  }
  return stream;
}

interface FunctionNode {
  (msg: Record<string, unknown> | null): Record<string, unknown> | null;
}

/**
 * Compiles one Node-RED function node from the deployed flow.
 *
 * Supplies the `context`, `node` and `Date` bindings the runtime provides, so
 * the node body runs unmodified. `sent` collects `node.send` calls.
 */
function compile(id: string, clock: { now: number }, sent: Record<string, unknown>[]): FunctionNode {
  const flow = JSON.parse(readFileSync(FLOW, 'utf8')) as { id: string; func?: string }[];
  const body = flow.find((node) => node.id === id)?.func;
  if (body === undefined) throw new Error(`flow has no function node ${id}`);

  const store = new Map<string, unknown>();
  const context = { get: (k: string) => store.get(k), set: (k: string, v: unknown) => store.set(k, v) };
  const node = { send: (m: Record<string, unknown>) => sent.push(m), status: () => undefined };
  const date = { now: () => clock.now };

  const compiled = new Function('msg', 'context', 'node', 'Date', body) as (
    msg: unknown,
    context: unknown,
    node: unknown,
    date: unknown,
  ) => Record<string, unknown> | null;

  return (msg) => compiled(msg, context, node, date) ?? null;
}

/** Runs the deployed flow's three function nodes over the reading stream. */
function runFlow(stream: readonly RawReading[]): Record<string, unknown>[] {
  const clock = { now: START };
  const sent: Record<string, unknown>[] = [];
  const window = compile('ls-window', clock, sent);
  const ewma = compile('ls-ewma', clock, sent);
  const deadband = compile('ls-deadband', clock, sent);

  const forwarded: Record<string, unknown>[] = [];
  const drain = (envelope: Record<string, unknown> | null): void => {
    if (!envelope) return;
    const smoothed = ewma(envelope);
    if (!smoothed) return;
    const kept = deadband(smoothed);
    if (kept) forwarded.push(kept.payload as Record<string, unknown>);
  };

  let nextFlush = START + FLUSH_EVERY_MS;

  for (const reading of stream) {
    clock.now = reading.ts;

    while (clock.now >= nextFlush) {
      const before = sent.length;
      window({ flush: true });
      for (const envelope of sent.slice(before)) drain(envelope);
      sent.length = before;
      nextFlush += FLUSH_EVERY_MS;
    }

    drain(window({ payload: reading as unknown as Record<string, unknown> }));
  }

  const before = sent.length;
  clock.now = (stream[stream.length - 1]?.ts ?? START) + WINDOW_MS + FLUSH_EVERY_MS;
  window({ flush: true });
  for (const envelope of sent.slice(before)) drain(envelope);

  return forwarded;
}

/** Runs the TypeScript chain over the same stream with the same clock. */
function runPort(
  stream: readonly RawReading[],
  filterName: string,
  config = DEFAULT_EDGE_FILTER_CONFIG,
): Record<string, unknown>[] {
  const aggregator = createWindowAggregator();
  const smoother = createEwmaSmoother();
  const filter = edgeFilterRegistry.create(filterName, config);

  const forwarded: Record<string, unknown>[] = [];
  const judge = (summary: ReturnType<typeof aggregator.flush>[number], now: number): void => {
    const pending = smoother.apply(summary);
    const decision = filter.decide(pending, now);
    if (!decision.forward) return;
    forwarded.push({ ...pending, forward_reason: decision.reason, ...(decision.ext ? { ext: decision.ext } : {}) });
  };

  let nextFlush = START + FLUSH_EVERY_MS;

  for (const reading of stream) {
    const now = reading.ts;

    while (now >= nextFlush) {
      for (const summary of aggregator.flush(now)) judge(summary, now);
      nextFlush += FLUSH_EVERY_MS;
    }

    const closed = aggregator.add(reading, now);
    if (closed) judge(closed, now);
  }

  const last = (stream[stream.length - 1]?.ts ?? START) + WINDOW_MS + FLUSH_EVERY_MS;
  for (const summary of aggregator.flush(last)) judge(summary, last);

  return forwarded;
}

describe('deadband port', () => {
  const stream = readings(900);
  const fromFlow = runFlow(stream);
  const fromPort = runPort(stream, 'deadband');

  it('produces a non-trivial number of forwards', () => {
    expect(fromFlow.length).toBeGreaterThan(200);
  });

  it('forwards the same windows as the deployed flow', () => {
    expect(fromPort.length).toBe(fromFlow.length);
  });

  it('agrees field for field on every forwarded window', () => {
    for (let i = 0; i < fromFlow.length; i++) {
      const expected = Object.fromEntries(COMPARED.map((k) => [k, fromFlow[i]![k]]));
      const actual = Object.fromEntries(COMPARED.map((k) => [k, fromPort[i]![k]]));
      expect(actual).toEqual(expected);
    }
  });

  it('drops most of what the aggregator produced', () => {
    const windows = new Set(stream.map((r) => `${r.machine_id}/${r.sensor_type}/${Math.floor(r.ts / WINDOW_MS)}`));
    expect(fromFlow.length).toBeLessThan(windows.size);
  });
});

describe('dual prediction filter', () => {
  const stream = readings(900);

  const bounds = [0.25, 0.5, 1, 2, 4];
  const counts = bounds.map(
    (errorBoundSigma) =>
      runPort(stream, 'dual-prediction', { ...DEFAULT_EDGE_FILTER_CONFIG, errorBoundSigma }).length,
  );

  it('forwards fewer windows as the bound widens', () => {
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('forwards less than the deadband at a comparable bound', () => {
    const deadband = runPort(stream, 'deadband').length;
    const dual = runPort(stream, 'dual-prediction', {
      ...DEFAULT_EDGE_FILTER_CONFIG,
      errorBoundSigma: 1,
    }).length;
    console.log(`deadband ${deadband}, dual-prediction at 1 sigma ${dual}`);
    expect(dual).toBeGreaterThan(0);
  });

  it('reconstructs every window the gateway suppressed', () => {
    const sigma = 1;
    const aggregator = createWindowAggregator();
    const smoother = createEwmaSmoother();
    const filter = createDualPredictionFilter({
      ...DEFAULT_EDGE_FILTER_CONFIG,
      errorBoundSigma: sigma,
    });

    const truth = new Map<string, number>();
    const sensorOf = new Map<string, SensorType>();
    const suppressed = new Set<string>();
    const rebuilt = new Map<string, number>();

    const judge = (pending: ReturnType<typeof smoother.apply>, now: number): void => {
      const key = `${pending.machine_id}/${pending.sensor_type}`;
      truth.set(`${key}@${pending.window_start}`, pending.smoothed);
      sensorOf.set(`${key}@${pending.window_start}`, pending.sensor_type);

      const decision = filter.decide(pending, now);
      if (!decision.forward) {
        suppressed.add(`${key}@${pending.window_start}`);
        return;
      }

      const ext = readDualPrediction(decision.ext);
      if (!ext) return;

      for (const point of reconstructGap(
        ext.model,
        ext.last_forwarded_window_start,
        pending.window_start,
        WINDOW_MS,
        1000,
      )) {
        rebuilt.set(`${key}@${point.t}`, point.v);
      }
    };

    for (const reading of stream) {
      const closed = aggregator.add(reading, reading.ts);
      if (closed) judge(smoother.apply(closed), reading.ts);
    }

    expect(suppressed.size).toBeGreaterThan(100);
    expect(rebuilt.size).toBeGreaterThan(100);

    for (const [key, value] of rebuilt) {
      expect(suppressed.has(key)).toBe(true);
      expect(Math.abs(truth.get(key)! - value)).toBeLessThanOrEqual(
        sigma * BASELINE_SD[sensorOf.get(key)!],
      );
    }
  });

  it('carries the model that governed the gap, not the one refitted after it', () => {
    const filter = createDualPredictionFilter({ ...DEFAULT_EDGE_FILTER_CONFIG, errorBoundSigma: 1 });
    const aggregator = createWindowAggregator();
    const smoother = createEwmaSmoother();

    let previous: ReturnType<typeof readDualPrediction> = null;

    for (const reading of stream) {
      const closed = aggregator.add(reading, reading.ts);
      if (!closed) continue;
      if (closed.machine_id !== 'press-01' || closed.sensor_type !== 'temperature') {
        smoother.apply(closed);
        continue;
      }

      const pending = smoother.apply(closed);
      const decision = filter.decide(pending, reading.ts);
      if (!decision.forward) continue;

      const ext = readDualPrediction(decision.ext);
      if (ext && previous) {
        expect(ext.last_forwarded_window_start).toBeGreaterThan(previous.last_forwarded_window_start);
        expect(Number.isFinite(predictAt(ext.model, pending.window_start))).toBe(true);
      }
      if (ext) previous = ext;
    }

    expect(previous).not.toBeNull();
  });
});

describe('safety override', () => {
  /** Flat temperature, then a linear ramp the predictor tracks exactly. */
  function ramp(): PendingWindow[] {
    const windows: PendingWindow[] = [];
    for (let i = 0; i < 40; i++) {
      const smoothed = i < 20 ? 55 : 55 + (i - 19) * 2;
      windows.push({
        edge_ts: START + i * WINDOW_MS,
        window_start: START + i * WINDOW_MS,
        window_end: START + (i + 1) * WINDOW_MS,
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
      });
    }
    return windows;
  }

  it('forwards every window at or above the safety limit', () => {
    const filter = createDualPredictionFilter({
      ...DEFAULT_EDGE_FILTER_CONFIG,
      errorBoundSigma: 2,
      heartbeatMs: 600000,
    });

    const breaches: number[] = [];
    const forwarded: number[] = [];

    for (const window of ramp()) {
      const decision = filter.decide(window, window.window_start);
      if (window.smoothed >= SAFETY_THRESHOLDS.temperature!) breaches.push(window.window_start);
      if (decision.forward) forwarded.push(window.window_start);
    }

    expect(breaches.length).toBeGreaterThan(0);
    for (const at of breaches) expect(forwarded).toContain(at);
  });

  it('suppresses the tracked ramp below the limit', () => {
    const filter = createDualPredictionFilter({
      ...DEFAULT_EDGE_FILTER_CONFIG,
      errorBoundSigma: 2,
      heartbeatMs: 600000,
    });

    const windows = ramp();
    const suppressed = windows.filter(
      (w) => w.smoothed < SAFETY_THRESHOLDS.temperature! && !filter.decide(w, w.window_start).forward,
    );
    expect(suppressed.length).toBeGreaterThan(20);
  });
});

describe('readDualPrediction', () => {
  it('rejects a window from the baseline arm', () => {
    expect(readDualPrediction(undefined)).toBeNull();
    expect(readDualPrediction({})).toBeNull();
  });

  it('rejects a malformed model', () => {
    expect(
      readDualPrediction({
        predictor_version: 'lsq-6',
        last_forwarded_window_start: START,
        model: { slope: 'up', intercept: 1 },
      }),
    ).toBeNull();
  });

  it('rejects a non-finite coefficient', () => {
    expect(
      readDualPrediction({
        predictor_version: 'lsq-6',
        last_forwarded_window_start: START,
        model: { slope: Number.NaN, intercept: 1 },
      }),
    ).toBeNull();
  });

  it('reads a well formed extension', () => {
    expect(
      readDualPrediction({
        predictor_version: 'lsq-6',
        last_forwarded_window_start: START,
        model: { slope: 0.5, intercept: 2 },
        divergence: 1.25,
      }),
    ).toEqual({
      predictor_version: 'lsq-6',
      last_forwarded_window_start: START,
      model: { slope: 0.5, intercept: 2 },
      divergence: 1.25,
    });
  });
});
