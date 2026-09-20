#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, startedAt, finishedAt, run, variant] = process.argv.slice(2);
if (!outDir || !startedAt || !finishedAt) {
  console.error('usage: collect.mjs <outDir> <startedAt> <finishedAt> <run> <variant>');
  process.exit(1);
}

const region = process.env.AWS_REGION ?? 'us-east-1';

/** Targets from the brief, reported alongside what was measured. */
const TARGETS = {
  edge_output_msg_per_second: 80,
  p95_end_to_end_ms: 5000,
  steady_queue_depth: 100,
};

function aws(args) {
  try {
    return execFileSync('aws', [...args, '--region', region], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * Fetches one CloudWatch metric over the run window.
 *
 * Returns the datapoint values in time order, or an empty array when the
 * metric has no data, which is normal for a metric no service emitted during
 * this run.
 */
function metric(namespace, name, dimensions, stat, period = 60) {
  const query = {
    Id: 'm1',
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: name,
        Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
      },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  };

  const raw = aws([
    'cloudwatch',
    'get-metric-data',
    '--start-time',
    startedAt,
    '--end-time',
    finishedAt,
    '--metric-data-queries',
    JSON.stringify([query]),
    '--output',
    'json',
  ]);

  if (!raw) return [];
  try {
    return JSON.parse(raw).MetricDataResults?.[0]?.Values ?? [];
  } catch {
    return [];
  }
}

function summarise(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    samples: sorted.length,
    min: sorted[0],
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1],
    mean: Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2)),
  };
}

function readSamples() {
  try {
    const text = readFileSync(join(outDir, 'samples.csv'), 'utf8');
    const [header, ...rows] = text.trim().split('\n');
    const columns = header.split(',');
    return rows.map((row) => {
      const values = row.split(',');
      return Object.fromEntries(columns.map((c, i) => [c, Number(values[i])]));
    });
  } catch {
    return [];
  }
}

const samples = readSamples();
const depths = samples.map((s) => s.detection_depth).filter(Number.isFinite);
const tasks = samples.map((s) => s.detection_tasks).filter(Number.isFinite);
const aggTasks = samples.map((s) => s.aggregation_tasks).filter(Number.isFinite);
const aggDepths = samples.map((s) => s.aggregation_depth).filter(Number.isFinite);
const rows = samples.map((s) => s.timeseries_rows).filter(Number.isFinite);

const elapsed = samples.length > 1 ? samples[samples.length - 1].elapsed_seconds : 0;
const edgeOutputRate =
  rows.length > 1 && elapsed > 0
    ? Number(((rows[rows.length - 1] - rows[0]) / elapsed).toFixed(2))
    : null;

const latency = {
  window_stored: summarise(
    metric('LineSentry', 'WindowStoredLatency', { service: 'aggregation', variant }, 'Maximum'),
  ),
  edge_to_ingest: summarise(
    metric('LineSentry', 'EdgeToIngestLatency', { service: 'aggregation', variant }, 'Maximum'),
  ),
  ingest_to_detect: summarise(
    metric('LineSentry', 'IngestToDetectLatency', { service: 'detection', variant }, 'Maximum'),
  ),
  detect_to_alert: summarise(
    metric('LineSentry', 'DetectToAlertLatency', { service: 'alerting', variant }, 'Maximum'),
  ),
  end_to_end_event: summarise(
    metric('LineSentry', 'EndToEndLatency', { service: 'alerting', variant }, 'Maximum'),
  ),
};

const summary = {
  run,
  variant,
  started_at: startedAt,
  finished_at: finishedAt,
  duration_seconds: elapsed,
  measured: {
    edge_output_msg_per_second: edgeOutputRate,
    detection_queue_depth: summarise(depths),
    aggregation_queue_depth: summarise(aggDepths),
    detection_tasks: {
      min: tasks.length ? Math.min(...tasks) : null,
      max: tasks.length ? Math.max(...tasks) : null,
      final: tasks.length ? tasks[tasks.length - 1] : null,
    },
    aggregation_tasks: {
      min: aggTasks.length ? Math.min(...aggTasks) : null,
      max: aggTasks.length ? Math.max(...aggTasks) : null,
      final: aggTasks.length ? aggTasks[aggTasks.length - 1] : null,
    },
    windows_stored: rows.length ? rows[rows.length - 1] - rows[0] : null,
    latency_ms: latency,
  },
  targets: TARGETS,
  against_targets: {
    edge_output:
      edgeOutputRate === null
        ? 'not measured'
        : edgeOutputRate <= TARGETS.edge_output_msg_per_second
          ? 'met'
          : 'MISSED',
    p95_end_to_end:
      latency.window_stored === null
        ? 'not measured'
        : latency.window_stored.p95 <= TARGETS.p95_end_to_end_ms
          ? 'met'
          : 'MISSED',
    steady_queue_depth:
      depths.length === 0 || aggDepths.length === 0
        ? 'not measured'
        : Math.max(summarise(depths).p95, summarise(aggDepths).p95) <= TARGETS.steady_queue_depth
          ? 'met'
          : 'MISSED',
  },
};

writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.measured, null, 2));
console.log('against targets:', JSON.stringify(summary.against_targets));
