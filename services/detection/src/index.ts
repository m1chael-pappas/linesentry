import { detectionRegistry, onShutdown, optionalEnv } from '@linesentry/core';

const QUEUE_URL = optionalEnv('DETECTION_QUEUE_URL', 'not-configured');
const STRATEGY = optionalEnv('DETECTION_STRATEGY', 'baseline');

console.log(
  `detection service starting, queue ${QUEUE_URL}, strategy ${STRATEGY}, registered [${detectionRegistry.names().join(', ') || 'none'}]`,
);

onShutdown(() => console.log('detection service stopped'));
