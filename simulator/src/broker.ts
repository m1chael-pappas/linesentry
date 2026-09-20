import net from 'node:net';
import { Aedes } from 'aedes';

const PORT = Number.parseInt(process.env.MQTT_PORT ?? '1883', 10);

const broker = await Aedes.createBroker();
broker.on('client', (c) => console.log(`client connected    ${c.id}`));
broker.on('clientDisconnect', (c) => console.log(`client disconnected ${c.id}`));
net
  .createServer(broker.handle)
  .listen(PORT, () => console.log(`mqtt broker listening on ${PORT}`));
