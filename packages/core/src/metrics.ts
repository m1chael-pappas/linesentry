import { appendFileSync } from 'node:fs';
import { optionalEnv } from './runtime.js';

/** CloudWatch metric units used by this pipeline. */
export type MetricUnit = 'Milliseconds' | 'Count' | 'Count/Second' | 'None';

/** Maximum numeric values one EMF metric target may hold. */
const MAX_SAMPLES = 100;

/** Namespace every metric is published under. */
export const METRICS_NAMESPACE = 'LineSentry';

/** A metric name paired with the unit its values are in. */
export interface MetricDefinition {
  name: string;
  unit: MetricUnit;
}

/** Values recorded for one metric since the last flush. */
type Samples = Map<string, number[]>;

/** Accumulates values and writes them out as embedded metric format. */
export interface Metrics {
  /** Adds one observation of `name`. */
  record(name: string, value: number, unit?: MetricUnit): void;
  /** Adds `count` to a counter, defaulting to 1. */
  count(name: string, count?: number): void;
  /** Writes everything recorded since the last flush and clears it. */
  flush(): void;
  /** Flushes every `intervalMs`. Returns a handle that stops the timer. */
  every(intervalMs: number): { stop(): void };
}

function emfDocument(
  service: string,
  variant: string,
  units: Map<string, MetricUnit>,
  samples: Samples,
): Record<string, unknown> {
  const definitions: MetricDefinition[] = [];
  const targets: Record<string, number | number[]> = {};

  for (const [name, values] of samples) {
    if (values.length === 0) continue;
    definitions.push({ name, unit: units.get(name) ?? 'None' });
    targets[name] = values.length === 1 ? values[0]! : values;
  }

  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [['service', 'variant']],
          Metrics: definitions.map((d) => ({ Name: d.name, Unit: d.unit })),
        },
      ],
    },
    service,
    variant,
    ...targets,
  };
}

/**
 * Returns a metrics sink for one service, dimensioned by `service` and
 * `variant`.
 *
 * `variant` comes from the `VARIANT` environment variable, default `baseline`.
 * Output goes to the file named by `EMF_FILE` when it is set, otherwise to
 * stdout, one JSON document per line.
 *
 * `record` keeps at most 100 values per metric per flush, since that is the
 * EMF limit on a numeric array target; values beyond that are dropped until
 * the next flush. `count` sums into a single value instead. Metrics with no
 * values recorded are omitted from the document, and a flush with nothing
 * recorded writes nothing. See ../METRICS.md.
 */
export function createMetrics(service: string): Metrics {
  const variant = optionalEnv('VARIANT', 'baseline');
  const emfFile = optionalEnv('EMF_FILE', '');

  const units = new Map<string, MetricUnit>();
  const samples: Samples = new Map();
  const counters = new Map<string, number>();

  const write = (line: string): void => {
    if (emfFile) {
      appendFileSync(emfFile, `${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  };

  return {
    record(name, value, unit = 'Milliseconds') {
      units.set(name, unit);
      const held = samples.get(name) ?? [];
      if (held.length < MAX_SAMPLES) held.push(value);
      samples.set(name, held);
    },

    count(name, count = 1) {
      units.set(name, 'Count');
      counters.set(name, (counters.get(name) ?? 0) + count);
    },

    flush() {
      for (const [name, total] of counters) samples.set(name, [total]);

      const document = emfDocument(service, variant, units, samples);
      const hasMetrics =
        (document._aws as { CloudWatchMetrics: { Metrics: unknown[] }[] }).CloudWatchMetrics[0]!
          .Metrics.length > 0;

      samples.clear();
      counters.clear();

      if (hasMetrics) write(JSON.stringify(document));
    },

    every(intervalMs) {
      const timer = setInterval(() => this.flush(), intervalMs);
      return {
        stop: () => {
          clearInterval(timer);
          this.flush();
        },
      };
    },
  };
}
