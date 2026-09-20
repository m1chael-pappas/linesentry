import mqtt from 'mqtt';
import {
  createDynamoClient,
  createDynamoWorkOrderStore,
  createQueueConsumer,
  createSqsClient,
  onShutdown,
  optionalEnv,
  requiredEnv,
  runConsumerLoop,
  workOrderId,
  type ActuatorCommand,
  type DetectionEvent,
  type WorkOrder,
} from '@linesentry/core';

const QUEUE_URL = requiredEnv('ALERTING_QUEUE_URL');
const WORKORDERS_TABLE = requiredEnv('WORKORDERS_TABLE');
const MQTT_URL = requiredEnv('MQTT_URL');
const NOTIFICATION_TOPIC = optionalEnv('NOTIFICATION_TOPIC', 'linesentry/notifications');

const workOrders = createDynamoWorkOrderStore(createDynamoClient(), WORKORDERS_TABLE);
const consumer = createQueueConsumer<DetectionEvent>(createSqsClient(), QUEUE_URL);
const client = mqtt.connect(MQTT_URL, { clientId: `linesentry-alerting-${process.pid}` });

let alerted = 0;
let duplicates = 0;

/**
 * Returns `shutdown` for a `threshold-breach`, `beacon_on` for any other
 * `high` severity event, and null otherwise.
 *
 * Pure. See ../ALERTING.md.
 */
function commandFor(event: DetectionEvent): ActuatorCommand['command'] | null {
  if (event.type === 'threshold-breach') return 'shutdown';
  if (event.severity === 'high') return 'beacon_on';
  return null;
}

function publish(topic: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function buildWorkOrder(event: DetectionEvent, openedAt: number): WorkOrder {
  return {
    work_order_id: workOrderId(event.event_id),
    event_id: event.event_id,
    machine_id: event.machine_id,
    sensor_type: event.sensor_type,
    severity: event.severity,
    status: 'open',
    opened_at: new Date(openedAt).toISOString(),
    reason: event.reason,
  };
}

console.log(`alerting consuming ${QUEUE_URL}, publishing actuator commands to ${MQTT_URL}`);

const loop = runConsumerLoop(consumer, async (message) => {
  const event = message.body;
  const alertTs = Date.now();

  if (!(await workOrders.putIfAbsent(buildWorkOrder(event, alertTs)))) {
    duplicates++;
    return;
  }

  await publish(NOTIFICATION_TOPIC, { ...event, alert_ts: alertTs });

  const command = commandFor(event);
  if (command) {
    const topic = `${event.site_id}/${event.line_id}/${event.machine_id}/actuator`;
    const payload: ActuatorCommand = {
      command,
      event_id: event.event_id,
      issued_at: alertTs,
    };
    await publish(topic, payload);
    console.log(`alert ${event.event_id} -> ${command} on ${event.machine_id}`);
  } else {
    console.log(`alert ${event.event_id} -> notification only on ${event.machine_id}`);
  }

  alerted++;
});

const report = setInterval(() => {
  console.log(`alerting handled ${alerted}, duplicates rejected ${duplicates}`);
  alerted = 0;
  duplicates = 0;
}, 10000);

onShutdown(async () => {
  clearInterval(report);
  await loop.stop();
  client.end();
});
