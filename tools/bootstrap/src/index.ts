import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  EVENTS_BY_SITE_INDEX,
  createDynamoClient,
  createDynamoMetadataStore,
  machineMetadata,
  numberEnv,
  optionalEnv,
  requiredEnv,
} from '@linesentry/core';
import { DEFAULT_SEED, buildPlant } from '@linesentry/simulator';

const CREATE_TABLES = optionalEnv('CREATE_TABLES', 'false') === 'true';
const SITE_ID = optionalEnv('SITE_ID', 'plant-01');
const SEED = optionalEnv('SEED', DEFAULT_SEED);
const MACHINES = numberEnv('SEED_MACHINES', 5);
const LINES = numberEnv('SEED_LINES', 1);
const CONCURRENCY = numberEnv('SEED_CONCURRENCY', 32);

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

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < machines.length) {
      const machine = machines[next++]!;
      await store.put(machineMetadata(machine.id, SITE_ID, machine.lineId, machine.base));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, machines.length) }, worker));

  console.log(`seeded metadata for ${machines.length} machines, seed ${SEED}`);
}

await main();
