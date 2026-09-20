import {
  createDeadLetterWatcher,
  createDynamoClient,
  createDynamoTimeSeriesStore,
  createMetrics,
  createQueueConsumer,
  createSqsClient,
  numberEnv,
  onShutdown,
  optionalEnv,
  requiredEnv,
  runConsumerLoop,
  type ForwardedWindow,
} from '@linesentry/core';

const QUEUE_URL = requiredEnv('AGGREGATION_QUEUE_URL');
const DLQ_URL = optionalEnv('AGGREGATION_DLQ_URL', '');
const TABLE = requiredEnv('TIMESERIES_TABLE');
const FLUSH_MS = numberEnv('METRICS_FLUSH_MS', 10000);

const metrics = createMetrics('aggregation');
const store = createDynamoTimeSeriesStore(createDynamoClient(), TABLE);
const sqs = createSqsClient();
const consumer = createQueueConsumer<ForwardedWindow>(sqs, QUEUE_URL);

let written = 0;

console.log(`aggregation consuming ${QUEUE_URL} into ${TABLE}`);

const loop = runConsumerLoop(consumer, async (message) => {
  metrics.count('MessagesProcessed');
  if (message.receiveCount > 1) metrics.count('MessagesRedelivered');

  await store.put(message.body);
  written++;
  metrics.count('WindowsStored');
});

const deadLetters = DLQ_URL
  ? createDeadLetterWatcher(sqs, DLQ_URL, metrics, FLUSH_MS)
  : undefined;

const report = setInterval(() => {
  console.log(`aggregation wrote ${written} windows`);
  written = 0;
  metrics.flush();
}, FLUSH_MS);

onShutdown(async () => {
  clearInterval(report);
  deadLetters?.stop();
  await loop.stop();
  metrics.flush();
});
