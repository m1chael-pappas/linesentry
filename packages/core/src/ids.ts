import { createHash } from 'node:crypto';
import type { SensorType } from './contracts.js';

const ID_HEX_CHARS = 16;

/**
 * Returns `evt-` followed by the first 16 hex characters of the SHA-256 of
 * `machineId|sensorType|windowStart`.
 *
 * Pure. Depends only on its arguments, so the same window always yields the
 * same id across processes and runs. See ../QUEUES.md.
 */
export function eventId(machineId: string, sensorType: SensorType, windowStart: number): string {
  const digest = createHash('sha256')
    .update(`${machineId}|${sensorType}|${windowStart}`)
    .digest('hex');
  return `evt-${digest.slice(0, ID_HEX_CHARS)}`;
}

/**
 * Returns the event id with its `evt-` prefix replaced by `wo-`.
 *
 * Pure and injective over event ids. See ../QUEUES.md.
 */
export function workOrderId(eventIdValue: string): string {
  return `wo-${eventIdValue.replace(/^evt-/, '')}`;
}
