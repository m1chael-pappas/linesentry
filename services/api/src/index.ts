import { numberEnv, onShutdown } from '@linesentry/core';

const PORT = numberEnv('API_PORT', 3000);

console.log(`api service starting on port ${PORT}`);

onShutdown(() => console.log('api service stopped'));
