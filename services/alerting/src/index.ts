import { onShutdown, optionalEnv } from '@linesentry/core';

const QUEUE_URL = optionalEnv('ALERTING_QUEUE_URL', 'not-configured');

console.log(`alerting service starting, queue ${QUEUE_URL}`);

onShutdown(() => console.log('alerting service stopped'));
