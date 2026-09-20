#!/usr/bin/env node
import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';

/**
 * Publishes synthetic forwarded windows straight to the ingest topic at a
 * fixed rate.
 *
 * This bypasses the simulator and the edge gateway. It exists to load the
 * cloud pipeline past the rate the edge can produce, so the autoscaling
 * policies can be measured. The messages are the same shape the topic rule
 * delivers, so no consumer behaves differently.
 *
 *   node experiments/load.mjs <windows-per-second> <seconds> [topic-arn]
 */

const [rateArg, durationArg, topicArg] = process.argv.slice(2);
if (!rateArg || !durationArg) {
  console.error('usage: load.mjs <windows-per-second> <seconds> [topic-arn]');
  process.exit(1);
}

const rate = Number(rateArg);
const duration = Number(durationArg);
const region = process.env.AWS_REGION ?? 'us-east-1';
const topicArn = topicArg ?? process.env.WINDOWS_TOPIC_ARN;

if (!topicArn) {
  console.error('set WINDOWS_TOPIC_ARN or pass the topic arn');
  process.exit(1);
}

const SENSORS = ['vibration', 'temperature', 'current', 'rpm'];
const UNITS = { vibration: 'mm/s', temperature: 'C', current: 'A', rpm: 'rpm' };
const MACHINES = Number(process.env.LOAD_MACHINES ?? 200);
const BATCH = 10;

const client = new SNSClient({ region });

/** Builds one window for a machine and sensor, carrying both latency stamps. */
function window(index, windowStart) {
  const machine = `press-${String((index % MACHINES) + 1).padStart(2, '0')}`;
  const sensor = SENSORS[index % SENSORS.length];
  const now = Date.now();

  return {
    edge_ts: now,
    window_start: windowStart,
    window_end: windowStart + 10000,
    window: '10s',
    site_id: process.env.SITE_ID ?? 'plant-01',
    line_id: `line-${String.fromCharCode(65 + (index % 4))}`,
    machine_id: machine,
    sensor_type: sensor,
    unit: UNITS[sensor],
    count: 10,
    mean: 50,
    min: 49,
    max: 51,
    rms: 50,
    smoothed: 50,
    forward_reason: 'changed',
    ingest_ts: now,
  };
}

let published = 0;
let failed = 0;
let sequence = 0;

async function publishBatch(size, windowStart) {
  const entries = Array.from({ length: size }, (_, i) => ({
    Id: `m${i}`,
    Message: JSON.stringify(window(sequence + i, windowStart)),
  }));
  sequence += size;

  try {
    await client.send(new PublishBatchCommand({ TopicArn: topicArn, PublishBatchRequestEntries: entries }));
    published += size;
  } catch (error) {
    failed += size;
    if (failed <= BATCH) console.error('publish failed', error.name ?? error);
  }
}

const started = Date.now();
const batchesPerSecond = Math.max(1, Math.round(rate / BATCH));
const intervalMs = Math.max(1, Math.round(1000 / batchesPerSecond));

console.log(
  `publishing ${rate} windows/s for ${duration}s to ${topicArn.split(':').pop()}, ${batchesPerSecond} batches/s`,
);

const reporter = setInterval(() => {
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`  t+${String(elapsed).padStart(4)}s  published ${published}, failed ${failed}`);
}, 10000);

const inFlight = new Set();

const timer = setInterval(() => {
  if ((Date.now() - started) / 1000 >= duration) {
    clearInterval(timer);
    clearInterval(reporter);
    void Promise.allSettled([...inFlight]).then(() => {
      console.log(`finished, published ${published}, failed ${failed}`);
      process.exit(0);
    });
    return;
  }

  const windowStart = Math.floor(Date.now() / 10000) * 10000;
  const task = publishBatch(BATCH, windowStart).finally(() => inFlight.delete(task));
  inFlight.add(task);
}, intervalMs);
