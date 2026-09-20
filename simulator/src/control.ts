import mqtt from 'mqtt';
import { FAULTS, isFaultType } from './plant.js';

const BROKER = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const [target, fault] = process.argv.slice(2);

if (!target) {
  console.log(`usage: node dist/control.js <machine|line> [${FAULTS.join('|')}]`);
  process.exit(1);
}

if (fault !== undefined && !isFaultType(fault)) {
  console.log(`unknown fault ${fault}, use one of ${FAULTS.join(', ')}`);
  process.exit(1);
}

const client = mqtt.connect(BROKER);
client.on('connect', () => {
  const payload = JSON.stringify({ target, fault: fault ?? null });
  client.publish('linesentry/control', payload, () => {
    console.log(`${fault ? `fault ${fault}` : 'clear'} -> ${target}`);
    client.end();
  });
});
