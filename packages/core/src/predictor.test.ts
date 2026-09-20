import { describe, expect, it } from 'vitest';
import {
  fitTrend,
  predictAt,
  predictorVersion,
  reconstructGap,
  type LinearModel,
  type Point,
} from './predictor.js';

const STEP = 10000;
const START = 1789000000000;

/** Deterministic value stream: ramp, sinusoid and a repeatable jitter term. */
function series(count: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const jitter = ((i * 2654435761) % 1000) / 10000;
    points.push({ t: START + i * STEP, v: 55 + i * 0.04 + 2 * Math.sin(i / 6) + jitter });
  }
  return points;
}

interface Forward {
  t: number;
  v: number;
  model: LinearModel | null;
  lastForwardedWindowStart: number | null;
}

/**
 * Runs the gateway half of the scheme over `points` at `bound`.
 *
 * Returns the forwarded windows and, separately, the value the gateway
 * predicted at every window it suppressed.
 */
function gateway(points: readonly Point[], bound: number, historyWindows: number) {
  const buffer: Point[] = [];
  const forwards: Forward[] = [];
  const predictions = new Map<number, number>();

  let model: LinearModel | null = null;
  let lastForwardedWindowStart: number | null = null;

  for (const point of points) {
    const predicted = model === null ? null : predictAt(model, point.t);

    buffer.push(point);
    if (buffer.length > historyWindows) buffer.shift();

    if (predicted !== null && Math.abs(point.v - predicted) <= bound) {
      predictions.set(point.t, predicted);
      continue;
    }

    forwards.push({ t: point.t, v: point.v, model, lastForwardedWindowStart });
    model = fitTrend(buffer);
    lastForwardedWindowStart = point.t;
  }

  return { forwards, predictions };
}

/** Runs the consumer half, rebuilding every suppressed window from `ext`. */
function consumer(forwards: readonly Forward[], limit: number): Map<number, number> {
  const rebuilt = new Map<number, number>();

  for (const forward of forwards) {
    if (forward.model === null || forward.lastForwardedWindowStart === null) continue;
    for (const point of reconstructGap(
      forward.model,
      forward.lastForwardedWindowStart,
      forward.t,
      STEP,
      limit,
    )) {
      rebuilt.set(point.t, point.v);
    }
  }

  return rebuilt;
}

/**
 * Drops the predictions after the last forward.
 *
 * A gap is carried by the message that closes it, so windows suppressed after
 * the final forward have no message to travel on until the next one.
 */
function closedGaps(
  predictions: ReadonlyMap<number, number>,
  forwards: readonly Forward[],
): Map<number, number> {
  const last = forwards[forwards.length - 1]?.t ?? -Infinity;
  return new Map([...predictions].filter(([t]) => t < last));
}

describe('fitTrend', () => {
  it('recovers an exact line', () => {
    const model = fitTrend([
      { t: 0, v: 1 },
      { t: 10, v: 3 },
      { t: 20, v: 5 },
    ]);
    expect(model).not.toBeNull();
    expect(model!.slope).toBeCloseTo(0.2, 12);
    expect(model!.intercept).toBeCloseTo(1, 12);
  });

  it('returns null below two points', () => {
    expect(fitTrend([])).toBeNull();
    expect(fitTrend([{ t: 0, v: 1 }])).toBeNull();
  });

  it('returns null when every point shares one t', () => {
    expect(
      fitTrend([
        { t: 5, v: 1 },
        { t: 5, v: 9 },
      ]),
    ).toBeNull();
  });

  it('is order stable for the same points', () => {
    const points = series(6);
    expect(fitTrend(points)).toEqual(fitTrend([...points]));
  });
});

describe('reconstructGap', () => {
  const model: LinearModel = { slope: 0.001, intercept: 4 };

  it('is empty for adjacent, equal and reversed bounds', () => {
    expect(reconstructGap(model, START, START + STEP, STEP, 10)).toEqual([]);
    expect(reconstructGap(model, START, START, STEP, 10)).toEqual([]);
    expect(reconstructGap(model, START + STEP, START, STEP, 10)).toEqual([]);
  });

  it('returns every boundary strictly inside the gap', () => {
    const gap = reconstructGap(model, START, START + 4 * STEP, STEP, 10);
    expect(gap.map((p) => p.t)).toEqual([START + STEP, START + 2 * STEP, START + 3 * STEP]);
  });

  it('keeps the newest points when the gap exceeds the limit', () => {
    const gap = reconstructGap(model, START, START + 100 * STEP, STEP, 3);
    expect(gap.map((p) => p.t)).toEqual([
      START + 97 * STEP,
      START + 98 * STEP,
      START + 99 * STEP,
    ]);
  });

  it('evaluates the model at each boundary', () => {
    const gap = reconstructGap(model, START, START + 3 * STEP, STEP, 10);
    for (const point of gap) expect(point.v).toBe(predictAt(model, point.t));
  });
});

describe('dual prediction determinism', () => {
  const points = series(400);

  for (const bound of [0.05, 0.2, 0.5, 1.5]) {
    it(`reconstructs every suppressed window exactly at bound ${bound}`, () => {
      const { forwards, predictions } = gateway(points, bound, 6);
      const rebuilt = consumer(forwards, 1000);
      const covered = closedGaps(predictions, forwards);

      expect(covered.size).toBeGreaterThan(0);
      expect([...rebuilt.keys()].sort()).toEqual([...covered.keys()].sort());

      for (const [t, predicted] of covered) {
        expect(rebuilt.get(t)).toBe(predicted);
      }
    });
  }

  it('suppresses more windows as the bound widens', () => {
    const counts = [0.05, 0.2, 0.5, 1.5].map(
      (bound) => gateway(points, bound, 6).predictions.size,
    );
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('holds every suppressed window inside the bound', () => {
    const bound = 0.5;
    const { predictions } = gateway(points, bound, 6);
    const truth = new Map(points.map((p) => [p.t, p.v]));

    for (const [t, predicted] of predictions) {
      expect(Math.abs(truth.get(t)! - predicted)).toBeLessThanOrEqual(bound);
    }
  });
});

describe('predictorVersion', () => {
  it('names the family and the history length', () => {
    expect(predictorVersion(6)).toBe('lsq-6');
  });
});
