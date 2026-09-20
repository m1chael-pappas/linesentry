import { onShutdown, optionalEnv } from '@linesentry/core';

const QUEUE_URL = optionalEnv('AGGREGATION_QUEUE_URL', 'not-configured');

console.log(`aggregation service starting, queue ${QUEUE_URL}`);

onShutdown(() => console.log('aggregation service stopped'));
