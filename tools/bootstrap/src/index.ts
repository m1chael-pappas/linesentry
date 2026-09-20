import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  BASELINE_SD,
  EVENTS_BY_SITE_INDEX,
  SAFETY_THRESHOLDS,
  createDynamoClient,
  createDynamoMetadataStore,
  numberEnv,
  optionalEnv,
  requiredEnv,
  type MachineMetadata,
  type SensorType,
} from '@linesentry/core';
import { DEFAULT_SEED, SENSORS, buildPlant } from '@linesentry/simulator';

const CREATE_TABLES = optionalEnv('CREATE_TABLES', 'false') === 'true';
const SITE_ID = optionalEnv('SITE_ID', 'plant-01');
const SEED = optionalEnv('SEED', DEFAULT_SEED);
const MACHINES = numberEnv('SEED_MACHINES', 5);
const LINES = numberEnv('SEED_LINES', 1);

const TIMESERIES_TABLE = requiredEnv('TIMESERIES_TABLE');
const EVENTS_TABLE = requiredEnv('EVENTS_TABLE');
const WORKORDERS_TABLE = requiredEnv('WORKORDERS_TABLE');
const METADATA_TABLE = requiredEnv('METADATA_TABLE');
const ALERTS_TABLE = requiredEnv('ALERTS_TABLE');

function tableDefinitions(): CreateTableCommandInput[] {
  return [
    {
      TableName: TIMESERIES_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'window_start', AttributeType: 'N' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'window_start', KeyType: 'RANGE' },
      ],
    },
    {
      TableName: EVENTS_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'event_id', AttributeType: 'S' },
        { AttributeName: 'site_id', AttributeType: 'S' },
        { AttributeName: 'detected_at', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'event_id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: EVENTS_BY_SITE_INDEX,
          KeySchema: [
            { AttributeName: 'site_id', KeyType: 'HASH' },
            { AttributeName: 'detected_at', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    },
    {
      TableName: WORKORDERS_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'work_order_id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'work_order_id', KeyType: 'HASH' }],
    },
    {
      TableName: ALERTS_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'alert_key', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'alert_key', KeyType: 'HASH' }],
    },
    {
      TableName: METADATA_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'machine_id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'machine_id', KeyType: 'HASH' }],
    },
  ];
}

async function ensureTable(client: DynamoDBClient, definition: CreateTableCommandInput): Promise<void> {
  const name = definition.TableName!;
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    console.log(`table ${name} already exists`);
    return;
  } catch (error) {
    if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
  }

  await client.send(new CreateTableCommand(definition));
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: name });
  console.log(`created table ${name}`);
}

/**
 * Builds the metadata row for one machine.
 *
 * The baseline mean is the machine's own resting value, derived from the run
 * seed and the machine id by the same function the simulator uses, so the
 * stored baseline is what the machine actually produces rather than an
 * approximation of it. The spread is the expected variability of the smoothed
 * window value, which is a property of the pipeline rather than of the
 * machine. See packages/core/src/plant-config.ts.
 */
function metadataFor(machineId: string, lineId: string, base: Record<SensorType, number>): MachineMetadata {
  const baseline: MachineMetadata['baseline'] = {};
  for (const sensor of SENSORS) {
    baseline[sensor] = { mean: base[sensor], sd: BASELINE_SD[sensor] };
  }

  return {
    machine_id: machineId,
    site_id: SITE_ID,
    line_id: lineId,
    baseline,
    thresholds: SAFETY_THRESHOLDS,
  };
}

async function main(): Promise<void> {
  if (CREATE_TABLES) {
    const raw = new DynamoDBClient(
      optionalEnv('DYNAMODB_ENDPOINT', '') ? { endpoint: optionalEnv('DYNAMODB_ENDPOINT', '') } : {},
    );
    for (const definition of tableDefinitions()) {
      await ensureTable(raw, definition);
    }
  }

  const store = createDynamoMetadataStore(createDynamoClient(), METADATA_TABLE);
  const machines = buildPlant(MACHINES, LINES, SEED);

  for (const machine of machines) {
    await store.put(metadataFor(machine.id, machine.lineId, machine.base));
  }

  console.log(`seeded metadata for ${machines.length} machines, seed ${SEED}`);
}

await main();
