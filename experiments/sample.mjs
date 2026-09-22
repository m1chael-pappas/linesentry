#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Seconds between samples. */
const INTERVAL_SECONDS = Number(process.env.SAMPLE_INTERVAL_SECONDS ?? 10);

/** Queues sampled every interval. */
const QUEUES = ['aggregation-q', 'detection-q', 'alerting-q'];

const [outputPath, durationArg] = process.argv.slice(2);
if (!outputPath || !durationArg) {
  console.error('usage: sample.mjs <output.csv> <duration-seconds>');
  process.exit(1);
}

const duration = Number(durationArg);
const region = process.env.AWS_REGION ?? 'us-east-1';
const cluster = process.env.CLUSTER ?? 'linesentry';

/**
 * Runs the AWS CLI and returns its trimmed stdout, or an empty string when the
 * call fails.
 *
 * A failed sample must not end the run, since a single throttled call is worth
 * less than the rest of the series.
 */
function aws(args) {
  try {
    return execFileSync('aws', [...args, '--region', region], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function queueDepth(name) {
  const account = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  return aws([
    'sqs',
    'get-queue-attributes',
    '--queue-url',
    `https://sqs.${region}.amazonaws.com/${account}/linesentry-${name}`,
    '--attribute-names',
    'ApproximateNumberOfMessages',
    '--query',
    'Attributes.ApproximateNumberOfMessages',
    '--output',
    'text',
  ]);
}

function runningCount(service) {
  return aws([
    'ecs',
    'describe-services',
    '--cluster',
    cluster,
    '--services',
    `linesentry-${service}`,
    '--query',
    'services[0].runningCount',
    '--output',
    'text',
  ]);
}

/**
 * Total rows in the time-series table.
 *
 * `scan --select COUNT` paginates past 1 MB and the CLI prints one count per
 * page, so the pages are summed. Returns an empty string when the call fails,
 * or unless `COUNT_ROWS=1`, since the scan reads the whole table every sample
 * and slows sampling as the table grows. collect.mjs takes the stored window
 * count from the `WindowsStored` metric instead.
 */
function timeSeriesRows() {
  if (process.env.COUNT_ROWS !== '1') return '';
  const output = aws([
    'dynamodb',
    'scan',
    '--table-name',
    'linesentry-timeseries',
    '--select',
    'COUNT',
    '--query',
    'Count',
    '--output',
    'text',
  ]);

  if (!output) return '';
  const total = output
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  return String(total);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `elapsed_seconds,${QUEUES.map((q) => q.replace('-q', '_depth')).join(',')},detection_tasks,aggregation_tasks,timeseries_rows\n`,
);

const account = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
if (!account) {
  console.error('cannot reach AWS, is the lab session live?');
  process.exit(1);
}

const started = Date.now();
console.log(`sampling every ${INTERVAL_SECONDS}s for ${duration}s into ${outputPath}`);

while ((Date.now() - started) / 1000 < duration) {
  const elapsed = Math.round((Date.now() - started) / 1000);
  const depths = QUEUES.map((q) => queueDepth(q) || '0');
  const detectionTasks = runningCount('detection') || '0';
  const aggregationTasks = runningCount('aggregation') || '0';
  const rows = timeSeriesRows() || '0';

  appendFileSync(
    outputPath,
    `${elapsed},${depths.join(',')},${detectionTasks},${aggregationTasks},${rows}\n`,
  );
  process.stdout.write(
    `  t+${String(elapsed).padStart(4)}s  agg queue ${depths[0].padStart(5)} tasks ${aggregationTasks}  det queue ${depths[1].padStart(5)} tasks ${detectionTasks}  rows ${rows}\n`,
  );

  const next = started + (elapsed + INTERVAL_SECONDS) * 1000;
  const wait = next - Date.now();
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

console.log(`sampling finished, ${outputPath}`);
