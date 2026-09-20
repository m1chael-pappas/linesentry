import mqtt from 'mqtt';
import {
  createFanoutPublisher,
  createSqsClient,
  onShutdown,
  parseQueueUrls,
  requiredEnv,
  type ForwardedWindow,
} from '@linesentry/core';

const MQTT_URL = requiredEnv('MQTT_URL');
const EDGE_TOPIC = requiredEnv('EDGE_TOPIC');
const QUEUE_URLS = parseQueueUrls(requiredEnv('FANOUT_QUEUE_URLS'));

const publisher = createFanoutPublisher<ForwardedWindow>(createSqsClient(), QUEUE_URLS);
const client = mqtt.connect(MQTT_URL, { clientId: `linesentry-ingest-${process.pid}` });

let forwarded = 0;
let failed = 0;

client.on('connect', () => {
  console.log(`ingest connected to ${MQTT_URL}, subscribing ${EDGE_TOPIC}`);
  console.log(`fanning out to ${QUEUE_URLS.length} queue(s): ${QUEUE_URLS.join(', ')}`);
  client.subscribe(EDGE_TOPIC);
  setInterval(() => {
    console.log(`ingest forwarded ${forwarded}, failed ${failed}`);
    forwarded = 0;
    failed = 0;
  }, 10000);
});

client.on('error', (err: Error) => console.error('mqtt error', err.message));

client.on('message', (_topic: string, buf: Buffer) => {
  let window: ForwardedWindow;
  try {
    window = JSON.parse(buf.toString()) as ForwardedWindow;
  } catch {
    failed++;
    return;
  }

  void publisher
    .publish({ ...window, ingest_ts: Date.now() })
    .then(() => {
      forwarded++;
    })
    .catch((error: unknown) => {
      failed++;
      console.error('fanout failed', error);
    });
});

onShutdown(() => {
  client.end();
});
