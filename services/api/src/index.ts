import express from 'express';
import {
  createDynamoClient,
  createDynamoEventStore,
  createDynamoMetadataStore,
  createDynamoTimeSeriesStore,
  createDynamoWorkOrderStore,
  numberEnv,
  onShutdown,
  requiredEnv,
  type SensorType,
} from '@linesentry/core';

const PORT = numberEnv('API_PORT', 3000);
const DEFAULT_LIMIT = 50;
const DEFAULT_RANGE_MS = 3600000;

const dynamo = createDynamoClient();
const events = createDynamoEventStore(dynamo, requiredEnv('EVENTS_TABLE'));
const metadata = createDynamoMetadataStore(dynamo, requiredEnv('METADATA_TABLE'));
const timeSeries = createDynamoTimeSeriesStore(dynamo, requiredEnv('TIMESERIES_TABLE'));
const workOrders = createDynamoWorkOrderStore(dynamo, requiredEnv('WORKORDERS_TABLE'));

const app = express();
app.use(express.json());

function limitFrom(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : DEFAULT_LIMIT;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/machines', async (_req, res) => {
  const machines = await metadata.list();
  const recent = await events.recent(200);

  res.json(
    machines.map((machine) => {
      const open = recent.filter(
        (event) => event.machine_id === machine.machine_id && event.status === 'open',
      );
      return {
        machine_id: machine.machine_id,
        site_id: machine.site_id,
        line_id: machine.line_id,
        open_events: open.length,
        worst_severity: open.some((e) => e.severity === 'high')
          ? 'high'
          : open.some((e) => e.severity === 'medium')
            ? 'medium'
            : open.length
              ? 'low'
              : 'none',
        latest_event: open[0] ?? null,
      };
    }),
  );
});

app.get('/events', async (req, res) => {
  res.json(await events.recent(limitFrom(req.query.limit)));
});

app.post('/events/:eventId/ack', async (req, res) => {
  const updated = await events.acknowledge(req.params.eventId);
  if (!updated) {
    res.status(404).json({ error: 'no such event' });
    return;
  }
  res.json(updated);
});

app.get('/machines/:machineId/timeseries', async (req, res) => {
  const sensor = req.query.sensor;
  if (typeof sensor !== 'string') {
    res.status(400).json({ error: 'sensor query parameter is required' });
    return;
  }

  const to = Number(req.query.to ?? Date.now());
  const from = Number(req.query.from ?? to - DEFAULT_RANGE_MS);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    res.status(400).json({ error: 'from and to must be epoch milliseconds' });
    return;
  }

  res.json(await timeSeries.range(req.params.machineId, sensor as SensorType, from, to));
});

app.get('/workorders', async (req, res) => {
  res.json(await workOrders.list(limitFrom(req.query.limit)));
});

const server = app.listen(PORT, () => console.log(`api listening on ${PORT}`));

onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);
