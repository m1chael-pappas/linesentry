#!/usr/bin/env node
import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';

/**
 * Publishes forwarded windows straight to the ingest topic, bypassing the
 * simulator process, the Node-RED gateway and IoT Core.
 *
 * Synthetic mode publishes identical windows at a fixed rate, to load the cloud
 * pipeline past what one gateway produces. Every window is the same, so every
 * arm receives the same rate and it measures capacity rather than a filter.
 *
 * Plant mode runs the seeded plant through the TypeScript edge chain and the
 * arm's filter, and publishes only what that filter forwards. Every arm sees
 * the same plant, so the rate each one publishes differs only by its filter.
 * The chain is the one edge.test.ts proves equal to the deployed flow.
 *
 *   node experiments/load.mjs <windows-per-second> <seconds> [topic-arn]
 *   EDGE_FILTER=dual-prediction ERROR_BOUND_SIGMA=0.5 HEARTBEAT_MS=600000 \
 *     node experiments/load.mjs plant <machines> <seconds> [topic-arn]
 */

const plantMode = process.argv[2] === 'plant';
const [rateArg, durationArg, topicArg] = process.argv.slice(plantMode ? 3 : 2);
if (!rateArg || !durationArg) {
  console.error('usage: load.mjs <windows-per-second> <seconds> [topic-arn]');
  console.error('       load.mjs plant <machines> <seconds> [topic-arn]');
  process.exit(1);
}

const rate = Number(rateArg);
const duration = Number(durationArg);
const region = process.env.AWS_REGION ?? 'us-east-1';
const topicArn = topicArg ?? process.env.WINDOWS_TOPIC_ARN;

const dryRun = process.env.DRY_RUN === '1';

if (!topicArn && !dryRun) {
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

if (plantMode) {
  await runPlant(rate, duration);
  process.exit(0);
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

/**
 * Returns a publisher that sends queued windows in batches of `BATCH`, holding
 * at most `limit` requests in flight.
 *
 * The edge chain closes every key's window in the same second, so forwards
 * arrive in bursts. Bounding concurrency sends a burst in parallel without
 * opening one request per batch.
 */
function createBurstPublisher(limit) {
  const pending = [];
  let inFlight = 0;
  let sent = 0;
  let lost = 0;
  let idle = () => {};

  function pump() {
    while (inFlight < limit && pending.length > 0) {
      const batch = pending.splice(0, BATCH);
      inFlight++;
      const stamp = Date.now();
      const entries = batch.map((window, i) => ({
        Id: `m${i}`,
        Message: JSON.stringify({ ...window, ingest_ts: stamp }),
      }));

      const request = dryRun
        ? Promise.resolve()
        : client.send(new PublishBatchCommand({ TopicArn: topicArn, PublishBatchRequestEntries: entries }));

      request
        .then(() => {
          sent += batch.length;
        })
        .catch((error) => {
          lost += batch.length;
          if (lost <= BATCH) console.error('publish failed', error.name ?? error);
        })
        .finally(() => {
          inFlight--;
          pump();
          if (inFlight === 0 && pending.length === 0) idle();
        });
    }
  }

  return {
    push(window) {
      pending.push(window);
      pump();
    },
    stats: () => ({ sent, lost, queued: pending.length, inFlight }),
    drained: () =>
      new Promise((resolve) => {
        if (inFlight === 0 && pending.length === 0) resolve();
        else idle = resolve;
      }),
  };
}

/**
 * Runs `machines` seeded machines at 1 Hz for `seconds` after a warm-up, and
 * publishes what the configured edge filter forwards.
 *
 * Machine `i` starts `i % JOIN_SECONDS` seconds in, so first forwards and
 * heartbeats spread across the join window rather than landing together.
 * Nothing is published during `WARMUP_SECONDS`, so no arm's run starts with the
 * burst of first forwards every key makes.
 */
async function runPlant(machines, seconds) {
  const { buildPlant, SENSORS: PLANT_SENSORS, UNITS: PLANT_UNITS } = await import(
    '../simulator/dist/plant.js'
  );
  const core = await import('../packages/core/dist/index.js');

  const filterName = process.env.EDGE_FILTER ?? 'deadband';
  const config = {
    ...core.DEFAULT_EDGE_FILTER_CONFIG,
    heartbeatMs: Number(process.env.HEARTBEAT_MS ?? core.HEARTBEAT_MS),
    errorBoundSigma: Number(process.env.ERROR_BOUND_SIGMA ?? core.DEFAULT_ERROR_BOUND_SIGMA),
  };
  const warmup = Number(process.env.WARMUP_SECONDS ?? 90);
  const joinSeconds = Number(process.env.JOIN_SECONDS ?? 60);
  const site = process.env.SITE_ID ?? 'plant-01';
  const perLine = 50;

  const plant = buildPlant(perLine, Math.ceil(machines / perLine), process.env.SEED ?? 'linesentry').slice(
    0,
    machines,
  );
  const aggregator = core.createWindowAggregator();
  const smoother = core.createEwmaSmoother();
  const filter = core.edgeFilterRegistry.create(filterName, config);
  const publisher = createBurstPublisher(Number(process.env.PUBLISH_CONCURRENCY ?? 64));

  const reasons = {};
  let forwarded = 0;
  let judged = 0;
  let worstLagMs = 0;

  const started = Date.now();
  const publishFrom = started + warmup * 1000;
  const stopAt = publishFrom + seconds * 1000;

  console.log(
    `plant load: ${plant.length} machines, filter ${filterName}` +
      (filterName === 'dual-prediction' ? ` at ${config.errorBoundSigma} sigma` : '') +
      `, heartbeat ${config.heartbeatMs / 1000}s, warm-up ${warmup}s, then ${seconds}s published` +
      (dryRun ? ', dry run' : ` to ${topicArn.split(':').pop()}`),
  );

  function judge(summary, now) {
    const pending = smoother.apply(summary);
    judged++;
    const decision = filter.decide(pending, now);
    if (!decision.forward || now < publishFrom) return;

    forwarded++;
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
    const window = { ...pending, forward_reason: decision.reason };
    if (decision.ext) window.ext = decision.ext;
    publisher.push(window);
  }

  let second = 0;
  let lastFlush = started;

  await new Promise((resolve) => {
    const tick = () => {
      const now = Date.now();
      const due = started + second * 1000;
      worstLagMs = now >= publishFrom ? Math.max(worstLagMs, now - due) : worstLagMs;

      if (now >= stopAt) {
        resolve();
        return;
      }

      for (let i = 0; i < plant.length; i++) {
        if (second < i % joinSeconds) continue;
        const machine = plant[i];
        const readings = machine.readings(now);
        for (const sensor of PLANT_SENSORS) {
          const closed = aggregator.add(
            {
              ts: now,
              site_id: site,
              line_id: machine.lineId,
              machine_id: machine.id,
              sensor_type: sensor,
              value: readings[sensor],
              unit: PLANT_UNITS[sensor],
              seq: second,
            },
            now,
          );
          if (closed) judge(closed, now);
        }
      }

      if (now - lastFlush >= 5000) {
        for (const closed of aggregator.flush(now)) judge(closed, now);
        lastFlush = now;
      }

      if (second % 10 === 0) {
        const phase = now < publishFrom ? 'warm-up' : 'publishing';
        const { sent, lost, queued } = publisher.stats();
        const elapsed = Math.round((now - publishFrom) / 1000);
        console.log(
          `  ${phase.padEnd(10)} t${elapsed >= 0 ? '+' : ''}${String(elapsed).padStart(4)}s  forwarded ${forwarded}, sent ${sent}, failed ${lost}, queued ${queued}, judged ${judged}, worst tick lag ${worstLagMs}ms`,
        );
      }

      second++;
      setTimeout(tick, Math.max(0, started + second * 1000 - Date.now()));
    };
    tick();
  });

  await publisher.drained();
  const { sent, lost } = publisher.stats();
  const perMachine = forwarded / plant.length / seconds;

  console.log(
    `finished: forwarded ${forwarded} over ${seconds}s, ${(forwarded / seconds).toFixed(2)}/s, ` +
      `${perMachine.toFixed(5)}/machine/s, sent ${sent}, failed ${lost}, worst tick lag ${worstLagMs}ms`,
  );
  console.log(`reasons ${JSON.stringify(reasons)}`);
}
