import mqtt from 'mqtt';
import {
  LATENCY_METRICS,
  createFanoutPublisher,
  createMetrics,
  createSqsClient,
  numberEnv,
  onShutdown,
  parseQueueUrls,
  requiredEnv,
  windowLatencies,
  type ForwardedWindow,
} from '@linesentry/core';

const MQTT_URL = requiredEnv('MQTT_URL');
const EDGE_TOPIC = requiredEnv('EDGE_TOPIC');
const QUEUE_URLS = parseQueueUrls(requiredEnv('FANOUT_QUEUE_URLS'));
const FLUSH_MS = numberEnv('METRICS_FLUSH_MS', 10000);

const metrics = createMetrics('ingest');
const publisher = createFanoutPublisher<ForwardedWindow>(createSqsClient(), QUEUE_URLS);
const client = mqtt.connect(MQTT_URL, { clientId: `linesentry-ingest-${process.pid}` });

let forwarded = 0;
let failed = 0;

client.on('connect', () => {
  console.log(`ingest connected to ${MQTT_URL}, subscribing ${EDGE_TOPIC}`);
  console.log(`fanning out to ${QUEUE_URLS.length} queue(s): ${QUEUE_URLS.join(', ')}`);
  client.subscribe(EDGE_TOPIC);
});

client.on('error', (err: Error) => console.error('mqtt error', err.message));

client.on('message', (_topic: string, buf: Buffer) => {
  let window: ForwardedWindow;
  try {
    window = JSON.parse(buf.toString()) as ForwardedWindow;
  } catch {
    failed++;
    metrics.count('ParseFailures');
    return;
  }

  const stamped: ForwardedWindow = { ...window, ingest_ts: Date.now() };
  const latencies = windowLatencies(stamped);
  if (latencies.edgeToIngest !== undefined) {
    metrics.record(LATENCY_METRICS.edgeToIngest, latencies.edgeToIngest);
  }

  void publisher
    .publish(stamped)
    .then(() => {
      forwarded++;
      metrics.count('MessagesProcessed');
    })
    .catch((error: unknown) => {
      failed++;
      metrics.count('FanoutFailures');
      console.error('fanout failed', error);
    });
});

const report = setInterval(() => {
  console.log(`ingest forwarded ${forwarded}, failed ${failed}`);
  forwarded = 0;
  failed = 0;
  metrics.flush();
}, FLUSH_MS);

onShutdown(() => {
  clearInterval(report);
  metrics.flush();
  client.end();
});
