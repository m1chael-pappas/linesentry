import {
  createDynamoClient,
  createDynamoTimeSeriesStore,
  createQueueConsumer,
  createSqsClient,
  onShutdown,
  requiredEnv,
  runConsumerLoop,
  type ForwardedWindow,
} from '@linesentry/core';

const QUEUE_URL = requiredEnv('AGGREGATION_QUEUE_URL');
const TABLE = requiredEnv('TIMESERIES_TABLE');

const store = createDynamoTimeSeriesStore(createDynamoClient(), TABLE);
const consumer = createQueueConsumer<ForwardedWindow>(createSqsClient(), QUEUE_URL);

let written = 0;

console.log(`aggregation consuming ${QUEUE_URL} into ${TABLE}`);

const loop = runConsumerLoop(consumer, async (message) => {
  await store.put(message.body);
  written++;
});

const report = setInterval(() => {
  console.log(`aggregation wrote ${written} windows`);
  written = 0;
}, 10000);

onShutdown(async () => {
  clearInterval(report);
  await loop.stop();
});
