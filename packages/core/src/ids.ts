import { createHash } from 'node:crypto';
import type { SensorType } from './contracts.js';

const ID_BITS = 16;

/**
 * The id an event gets, derived from what the event is about rather than when
 * it was written.
 *
 * SQS standard delivery is at least once and several detection tasks run at
 * the same time, so the same window can be judged more than once. Deriving the
 * id from the machine, the sensor and the window start means every one of
 * those attempts produces the same id, and the conditional write that stores
 * it accepts only the first. A redelivery does nothing rather than raising a
 * second alert.
 *
 * Sixteen hex characters is 64 bits. At 200 machines the pipeline produces
 * roughly 7 million window ids a day, where a collision is about one in a
 * million. A shorter id would make a collision likely enough to suppress a
 * real event.
 */
export function eventId(machineId: string, sensorType: SensorType, windowStart: number): string {
  const digest = createHash('sha256')
    .update(`${machineId}|${sensorType}|${windowStart}`)
    .digest('hex');
  return `evt-${digest.slice(0, ID_BITS)}`;
}

/**
 * The id the work order for an event gets.
 *
 * Derived from the event id for the same reason: the alerting service also
 * consumes from a standard queue, so it has to be able to handle the same
 * event twice without opening two jobs for one fault.
 */
export function workOrderId(eventIdValue: string): string {
  return `wo-${eventIdValue.replace(/^evt-/, '')}`;
}
