import {
  alertKey,
  machineAlertKey,
  cacheMetadata,
  createDynamoAlertStateStore,
  createDynamoClient,
  createDynamoEventStore,
  createDynamoMetadataStore,
  createFanoutPublisher,
  createQueueConsumer,
  createSqsClient,
  detectionRegistry,
  numberEnv,
  onShutdown,
  optionalEnv,
  parseQueueUrls,
  requiredEnv,
  runConsumerLoop,
  type DetectionEvent,
  type ForwardedWindow,
} from '@linesentry/core';
import { buildEvent, eventRank } from './events.js';
import { createHistoryBuffer, looksStopped } from './history.js';
import './strategies/baseline.js';

const QUEUE_URL = requiredEnv('DETECTION_QUEUE_URL');
const EVENTS_TABLE = requiredEnv('EVENTS_TABLE');
const METADATA_TABLE = requiredEnv('METADATA_TABLE');
const ALERTS_TABLE = requiredEnv('ALERTS_TABLE');
const EVENTS_FANOUT = parseQueueUrls(requiredEnv('EVENTS_FANOUT_QUEUE_URLS'));

const STRATEGY = optionalEnv('DETECTION_STRATEGY', 'baseline');
const METADATA_TTL_MS = numberEnv('METADATA_TTL_MS', 60000);
const HISTORY_WINDOWS = numberEnv('HISTORY_WINDOWS', 6);
const ALERT_EPISODE_MS = numberEnv('ALERT_EPISODE_MS', 600000);
const MACHINE_STOP_TTL_MS = numberEnv('MACHINE_STOP_TTL_MS', 5000);

const strategy = detectionRegistry.create(STRATEGY, {
  zScoreSigma: numberEnv('Z_SCORE_SIGMA', 3),
  historyWindows: HISTORY_WINDOWS,
  rulHorizonMs: numberEnv('RUL_HORIZON_MS', 300000),
});

const dynamo = createDynamoClient();
const events = createDynamoEventStore(dynamo, EVENTS_TABLE);
const metadata = cacheMetadata(createDynamoMetadataStore(dynamo, METADATA_TABLE), METADATA_TTL_MS);
const alerts = createDynamoAlertStateStore(dynamo, ALERTS_TABLE);
const history = createHistoryBuffer(HISTORY_WINDOWS);

const sqs = createSqsClient();
const consumer = createQueueConsumer<ForwardedWindow>(sqs, QUEUE_URL);
const publisher = createFanoutPublisher<DetectionEvent>(sqs, EVENTS_FANOUT);

let processed = 0;
let written = 0;
let duplicates = 0;
let unknownMachines = 0;
let suppressed = 0;
let stoppedSkips = 0;
let redelivered = 0;

const stopCache = new Map<string, { stopped: boolean; expiresAt: number }>();

/**
 * True when an unexpired entry exists under `machineAlertKey(machineId)`.
 *
 * Results are cached for `MACHINE_STOP_TTL_MS`, so a stop written by another
 * task is visible after at most that delay. See ../../packages/core/DETECTION.md.
 */
async function orderedToStop(machineId: string): Promise<boolean> {
  const now = Date.now();
  const hit = stopCache.get(machineId);
  if (hit && hit.expiresAt > now) return hit.stopped;

  const state = await alerts.get(machineAlertKey(machineId));
  const stopped = state !== undefined && state.expires_at > now;
  stopCache.set(machineId, { stopped, expiresAt: now + MACHINE_STOP_TTL_MS });
  return stopped;
}

console.log(
  `detection consuming ${QUEUE_URL}, strategy ${strategy.name}, registered [${detectionRegistry.names().join(', ')}]`,
);

const loop = runConsumerLoop(consumer, async (message) => {
  const window = message.body;
  processed++;
  if (message.receiveCount > 1) redelivered++;

  const machine = await metadata.get(window.machine_id);
  if (!machine) {
    unknownMachines++;
    return;
  }

  if (looksStopped(history, window.machine_id) || (await orderedToStop(window.machine_id))) {
    stoppedSkips++;
    return;
  }

  const windows = history.add(window);
  const findings = strategy.evaluate(window, { metadata: machine, history: windows });
  const event = buildEvent(window, findings, Date.now());
  if (!event) return;

  const key = alertKey(window.machine_id, window.sensor_type);
  if (!(await alerts.claim(key, eventRank(event), event.event_id, ALERT_EPISODE_MS))) {
    suppressed++;
    return;
  }

  await publisher.publish(event);

  if (!(await events.putIfAbsent(event))) {
    duplicates++;
    return;
  }

  if (event.type === 'threshold-breach') {
    await alerts.claim(
      machineAlertKey(window.machine_id),
      eventRank(event),
      event.event_id,
      ALERT_EPISODE_MS,
    );
    stopCache.set(window.machine_id, { stopped: true, expiresAt: Date.now() + MACHINE_STOP_TTL_MS });
  }

  written++;
  console.log(`event ${event.event_id} ${event.severity} ${event.machine_id} ${event.reason}`);
}, (batch) => {
  for (const message of batch) history.add(message.body);
});

const report = setInterval(() => {
  console.log(
    `detection processed ${processed}, redelivered ${redelivered}, events ${written}, duplicates rejected ${duplicates}, episode suppressed ${suppressed}, stopped machines ${stoppedSkips}, unknown machines ${unknownMachines}`,
  );
  processed = 0;
  written = 0;
  duplicates = 0;
  suppressed = 0;
  stoppedSkips = 0;
  redelivered = 0;
  unknownMachines = 0;
}, 10000);

onShutdown(async () => {
  clearInterval(report);
  await loop.stop();
});
