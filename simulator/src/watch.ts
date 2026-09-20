import mqtt from 'mqtt';

const BROKER = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const REPORT_MS = 10000;
const topic = process.argv[2] ?? 'plant-01/#';

const client = mqtt.connect(BROKER, { clientId: `linesentry-watch-${process.pid}` });
let count = 0;

client.on('connect', () => {
  console.log(`watching ${topic} on ${BROKER}`);
  client.subscribe(topic);
  setInterval(() => {
    console.log(`--- ${(count / (REPORT_MS / 1000)).toFixed(1)} msg/s`);
    count = 0;
  }, REPORT_MS);
});

client.on('message', (t: string, m: Buffer) => {
  count++;
  console.log(t, m.toString());
});
