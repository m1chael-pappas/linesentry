import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DetectionEvent, WorkOrder } from './contracts.js';
import {
  createDynamoAlertStateStore,
  createDynamoEventStore,
  createDynamoWorkOrderStore,
} from './dynamo.js';
import { alertKey } from './stores.js';
import { eventId, workOrderId } from './ids.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const suffix = `test-${process.pid}-${Date.now()}`;
const EVENTS = `linesentry-events-${suffix}`;
const WORKORDERS = `linesentry-workorders-${suffix}`;
const ALERTS = `linesentry-alerts-${suffix}`;

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500) });
    return response.status > 0;
  } catch {
    return false;
  }
}

const available = await reachable();

const client = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const documents = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const events = createDynamoEventStore(documents, EVENTS);
const workOrders = createDynamoWorkOrderStore(documents, WORKORDERS);
const alerts = createDynamoAlertStateStore(documents, ALERTS);

function event(windowStart: number, overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    event_id: eventId('press-01', 'temperature', windowStart),
    site_id: 'plant-01',
    line_id: 'line-A',
    machine_id: 'press-01',
    sensor_type: 'temperature',
    type: 'anomaly',
    severity: 'medium',
    detected_at: new Date(windowStart).toISOString(),
    reason: 'temperature z-score 4.1',
    status: 'open',
    window_start: windowStart,
    edge_ts: windowStart + 10000,
    detected_ts: windowStart + 11000,
    ...overrides,
  };
}

function order(forEvent: DetectionEvent): WorkOrder {
  return {
    work_order_id: workOrderId(forEvent.event_id),
    event_id: forEvent.event_id,
    machine_id: forEvent.machine_id,
    sensor_type: forEvent.sensor_type,
    severity: forEvent.severity,
    status: 'open',
    opened_at: forEvent.detected_at,
    reason: forEvent.reason,
  };
}

describe.skipIf(!available)('conditional writes against DynamoDB', () => {
  beforeAll(async () => {
    await Promise.all([
      client.send(
        new CreateTableCommand({
          TableName: EVENTS,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'event_id', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'event_id', KeyType: 'HASH' }],
        }),
      ),
      client.send(
        new CreateTableCommand({
          TableName: WORKORDERS,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'work_order_id', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'work_order_id', KeyType: 'HASH' }],
        }),
      ),
      client.send(
        new CreateTableCommand({
          TableName: ALERTS,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'alert_key', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'alert_key', KeyType: 'HASH' }],
        }),
      ),
    ]);

    await Promise.all(
      [EVENTS, WORKORDERS, ALERTS].map((TableName) =>
        waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName }),
      ),
    );
  }, 60000);

  afterAll(async () => {
    await Promise.all(
      [EVENTS, WORKORDERS, ALERTS].map((TableName) =>
        client.send(new DeleteTableCommand({ TableName })).catch(() => undefined),
      ),
    );
  });

  it('accepts an event once and refuses the redelivery', async () => {
    const redelivered = event(1789000000000);
    expect(await events.putIfAbsent(redelivered)).toBe(true);
    expect(await events.putIfAbsent(redelivered)).toBe(false);
  });

  it('refuses the redelivery even when its contents differ', async () => {
    const first = event(1789000010000);
    expect(await events.putIfAbsent(first)).toBe(true);
    expect(await events.putIfAbsent({ ...first, severity: 'high', reason: 'changed' })).toBe(false);
  });

  it('lets only one of several concurrent writers win', async () => {
    const contended = event(1789000020000);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => events.putIfAbsent(contended)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('opens one work order per event however many times the event arrives', async () => {
    const source = event(1789000030000);
    const job = order(source);
    expect(await workOrders.putIfAbsent(job)).toBe(true);
    expect(await workOrders.putIfAbsent(job)).toBe(false);
  });

  describe('alert episodes', () => {
    const key = alertKey('press-02', 'temperature');

    it('opens an episode, then refuses an equal ranked repeat', async () => {
      expect(await alerts.claim(key, 1, 'evt-a', 60000)).toBe(true);
      expect(await alerts.claim(key, 1, 'evt-b', 60000)).toBe(false);
    });

    it('accepts an escalation', async () => {
      expect(await alerts.claim(key, 22, 'evt-c', 60000)).toBe(true);
    });

    it('refuses a de-escalation', async () => {
      expect(await alerts.claim(key, 2, 'evt-d', 60000)).toBe(false);
    });

    it('lets the holding event re-claim, so a crashed task can retry', async () => {
      expect(await alerts.claim(key, 22, 'evt-c', 60000)).toBe(true);
    });

    it('reopens once the episode has expired', async () => {
      const expiring = alertKey('press-03', 'vibration');
      expect(await alerts.claim(expiring, 5, 'evt-e', 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await alerts.claim(expiring, 1, 'evt-f', 60000)).toBe(true);
    });

    it('lets only one of several concurrent writers open an episode', async () => {
      const contended = alertKey('press-04', 'current');
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) => alerts.claim(contended, 1, `evt-${i}`, 60000)),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });
  });
});
