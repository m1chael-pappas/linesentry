import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DetectionEvent, MachineMetadata, SensorType, WorkOrder } from './contracts.js';
import type {
  AlertState,
  AlertStateStore,
  EventStore,
  MetadataStore,
  TimeSeriesPoint,
  TimeSeriesStore,
  WorkOrderStore,
} from './stores.js';
import { optionalEnv } from './runtime.js';

/** Name of the events table index on `site_id` and `detected_at`. */
export const EVENTS_BY_SITE_INDEX = 'by-site';

/** Returns a document client, overriding the endpoint when `DYNAMODB_ENDPOINT` is set. Undefined values are stripped on write. */
export function createDynamoClient(): DynamoDBDocumentClient {
  const endpoint = optionalEnv('DYNAMODB_ENDPOINT', '');
  const client = new DynamoDBClient(endpoint ? { endpoint } : {});
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: string }).name === 'ConditionalCheckFailedException'
  );
}

/** Returns `<machineId>#<sensorType>`. */
export function timeSeriesKey(machineId: string, sensorType: SensorType): string {
  return `${machineId}#${sensorType}`;
}

/**
 * `TimeSeriesStore` over a table with partition key `pk` and sort key
 * `window_start`. `range` is one query within a single partition.
 */
export function createDynamoTimeSeriesStore(
  client: DynamoDBDocumentClient,
  tableName: string,
): TimeSeriesStore {
  return {
    async put(window) {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: timeSeriesKey(window.machine_id, window.sensor_type),
            window_start: window.window_start,
            machine_id: window.machine_id,
            sensor_type: window.sensor_type,
            site_id: window.site_id,
            line_id: window.line_id,
            unit: window.unit,
            count: window.count,
            mean: window.mean,
            min: window.min,
            max: window.max,
            rms: window.rms,
            smoothed: window.smoothed,
            forward_reason: window.forward_reason,
            edge_ts: window.edge_ts,
            ingest_ts: window.ingest_ts,
          },
        }),
      );
    },

    async range(machineId, sensorType, from, to) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND window_start BETWEEN :from AND :to',
          ExpressionAttributeValues: {
            ':pk': timeSeriesKey(machineId, sensorType),
            ':from': from,
            ':to': to,
          },
        }),
      );
      return (result.Items ?? []) as TimeSeriesPoint[];
    },
  };
}

/**
 * `EventStore` over a table with partition key `event_id` and a
 * `EVENTS_BY_SITE_INDEX` index on `site_id` and `detected_at`.
 *
 * `recent` queries that index descending, scoped to `SITE_ID`, default
 * `plant-01`.
 */
export function createDynamoEventStore(
  client: DynamoDBDocumentClient,
  tableName: string,
): EventStore {
  return {
    async putIfAbsent(event) {
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: event,
            ConditionExpression: 'attribute_not_exists(event_id)',
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async get(eventId) {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { event_id: eventId } }),
      );
      return result.Item as DetectionEvent | undefined;
    },

    async recent(limit) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: EVENTS_BY_SITE_INDEX,
          KeyConditionExpression: 'site_id = :site',
          ExpressionAttributeValues: { ':site': optionalEnv('SITE_ID', 'plant-01') },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return (result.Items ?? []) as DetectionEvent[];
    },

    async acknowledge(eventId) {
      const result = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { event_id: eventId },
          UpdateExpression: 'SET #status = :acked',
          ConditionExpression: 'attribute_exists(event_id)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':acked': 'acked' },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes as DetectionEvent | undefined;
    },
  };
}

/** `WorkOrderStore` over a table with partition key `work_order_id`. `list` scans. */
export function createDynamoWorkOrderStore(
  client: DynamoDBDocumentClient,
  tableName: string,
): WorkOrderStore {
  return {
    async putIfAbsent(workOrder) {
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: workOrder,
            ConditionExpression: 'attribute_not_exists(work_order_id)',
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async list(limit) {
      const result = await client.send(new ScanCommand({ TableName: tableName, Limit: limit }));
      return (result.Items ?? []) as WorkOrder[];
    },
  };
}

/** `MetadataStore` over a table with partition key `machine_id`. `list` scans. */
export function createDynamoMetadataStore(
  client: DynamoDBDocumentClient,
  tableName: string,
): MetadataStore {
  return {
    async get(machineId) {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { machine_id: machineId } }),
      );
      return result.Item as MachineMetadata | undefined;
    },

    async put(metadata) {
      await client.send(new PutCommand({ TableName: tableName, Item: metadata }));
    },

    async list() {
      const result = await client.send(new ScanCommand({ TableName: tableName }));
      return (result.Items ?? []) as MachineMetadata[];
    },
  };
}

/**
 * `AlertStateStore` over a table with partition key `alert_key`.
 *
 * `claim` is one `UpdateItem` conditional on
 * `attribute_not_exists(alert_key) OR expires_at < now OR rank < :rank OR
 * event_id = :event`.
 */
export function createDynamoAlertStateStore(
  client: DynamoDBDocumentClient,
  tableName: string,
): AlertStateStore {
  return {
    async claim(key, rank, eventId, ttlMs) {
      const now = Date.now();
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { alert_key: key },
            UpdateExpression: 'SET #rank = :rank, event_id = :event, expires_at = :expires',
            ConditionExpression:
              'attribute_not_exists(alert_key) OR expires_at < :now OR #rank < :rank OR event_id = :event',
            ExpressionAttributeNames: { '#rank': 'rank' },
            ExpressionAttributeValues: {
              ':rank': rank,
              ':event': eventId,
              ':expires': now + ttlMs,
              ':now': now,
            },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async get(key) {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { alert_key: key } }),
      );
      return result.Item as AlertState | undefined;
    },
  };
}
