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

function timeSeriesRows() {
  return aws([
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
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `elapsed_seconds,${QUEUES.map((q) => q.replace('-q', '_depth')).join(',')},detection_tasks,timeseries_rows\n`,
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
  const tasks = runningCount('detection') || '0';
  const rows = timeSeriesRows() || '0';

  appendFileSync(outputPath, `${elapsed},${depths.join(',')},${tasks},${rows}\n`);
  process.stdout.write(
    `  t+${String(elapsed).padStart(4)}s  detection queue ${depths[1].padStart(5)}  tasks ${tasks}  rows ${rows}\n`,
  );

  const next = started + (elapsed + INTERVAL_SECONDS) * 1000;
  const wait = next - Date.now();
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

console.log(`sampling finished, ${outputPath}`);
