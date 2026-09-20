import readline from 'node:readline';
import mqtt from 'mqtt';
import type { ActuatorCommand, FaultType, RawReading } from '@linesentry/core';
import { FAULTS, SENSORS, UNITS, buildPlant, isFaultType, type Machine } from './plant.js';

const BROKER = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const SITE = process.env.SITE_ID ?? 'plant-01';
const MACHINES = Number.parseInt(process.argv[2] ?? process.env.MACHINES ?? '5', 10);
const LINES = Number.parseInt(process.argv[3] ?? process.env.LINES ?? '1', 10);
const RATE_MS = Number.parseInt(process.env.RATE_MS ?? '1000', 10);
const REPORT_MS = 10000;

const machines = buildPlant(MACHINES, LINES);
const byId = new Map(machines.map((m) => [m.id, m]));

const client = mqtt.connect(BROKER, { clientId: `linesentry-sim-${process.pid}` });
let published = 0;

client.on('connect', () => {
  console.log(`connected to ${BROKER}`);
  console.log(
    `simulating ${machines.length} machines across ${LINES} line(s), ${SENSORS.length} sensors each, ${RATE_MS} ms sample period`,
  );
  client.subscribe('linesentry/control');
  client.subscribe(`${SITE}/+/+/actuator`);
  setInterval(tick, RATE_MS);
  setInterval(report, REPORT_MS);
});

client.on('error', (err: Error) => console.error('mqtt error', err.message));

function tick(): void {
  const now = Date.now();
  for (const m of machines) {
    const r = m.readings(now);
    for (const s of SENSORS) {
      const payload: RawReading = {
        ts: now,
        site_id: SITE,
        line_id: m.lineId,
        machine_id: m.id,
        sensor_type: s,
        value: r[s],
        unit: UNITS[s],
        seq: m.seq,
      };
      client.publish(`${SITE}/${m.lineId}/${m.id}/${s}`, JSON.stringify(payload));
      published++;
    }
    m.seq++;
  }
}

function report(): void {
  const faulted = machines.filter((m) => m.fault).map((m) => `${m.id}:${m.fault}`);
  const down = machines.filter((m) => m.shutdown).map((m) => m.id);
  const rate = (published / (REPORT_MS / 1000)).toFixed(1);
  console.log(
    `[${new Date().toISOString()}] ${rate} msg/s` +
      (faulted.length ? ` | faults ${faulted.join(', ')}` : '') +
      (down.length ? ` | shutdown ${down.join(', ')}` : ''),
  );
  published = 0;
}

function resolveTargets(target: string): Machine[] {
  const machine = byId.get(target);
  return machine ? [machine] : machines.filter((m) => m.lineId === target);
}

function setFault(target: string, fault: FaultType | null): void {
  const list = resolveTargets(target);
  if (!list.length) {
    console.log(`no machine or line called ${target}`);
    return;
  }
  for (const m of list) {
    m.fault = fault;
    m.faultStart = Date.now();
    if (!fault) {
      m.shutdown = false;
      m.beacon = false;
    }
  }
  const what = fault ? `fault ${fault}` : 'cleared';
  console.log(`${what} on ${list.map((m) => m.id).join(', ')}`);
}

function applyActuator(machine: Machine, command: ActuatorCommand['command']): void {
  switch (command) {
    case 'beacon_on':
      machine.beacon = true;
      console.log(`*** ALARM BEACON ON  ${machine.id}`);
      break;
    case 'beacon_off':
      machine.beacon = false;
      console.log(`    alarm beacon off ${machine.id}`);
      break;
    case 'shutdown':
      machine.shutdown = true;
      machine.faultStart = Date.now();
      console.log(`*** SHUTDOWN RELAY   ${machine.id}`);
      break;
    default:
      break;
  }
}

client.on('message', (topic: string, buf: Buffer) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(buf.toString()) as Record<string, unknown>;
  } catch {
    return;
  }

  if (topic === 'linesentry/control') {
    if (msg.fault !== null && !isFaultType(msg.fault)) {
      console.log(`unknown fault ${String(msg.fault)}, use one of ${FAULTS.join(', ')}`);
      return;
    }
    if (typeof msg.target !== 'string') {
      console.log('control message needs a target machine or line');
      return;
    }
    setFault(msg.target, msg.fault as FaultType | null);
    return;
  }

  const machineId = topic.split('/')[2];
  const machine = machineId ? byId.get(machineId) : undefined;
  if (!machine) return;
  applyActuator(machine, msg.command as ActuatorCommand['command']);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(
  'commands: fault <machine|line> <bearing|overheat|overload|dropout>, clear <machine|line>, burst <line> <fault>, status, quit',
);

rl.on('line', (line: string) => {
  const [cmd, target, fault] = line.trim().split(/\s+/);
  switch (cmd) {
    case 'fault':
    case 'burst':
      if (!target) {
        console.log('give a machine or line to fault');
        return;
      }
      if (!isFaultType(fault)) {
        console.log(`use one of ${FAULTS.join(', ')}`);
        return;
      }
      setFault(target, fault);
      return;
    case 'clear':
      if (!target) {
        console.log('give a machine or line to clear');
        return;
      }
      setFault(target, null);
      return;
    case 'status':
      for (const m of machines) {
        console.log(
          `${m.lineId} ${m.id} base=${JSON.stringify(m.base)} fault=${m.fault ?? '-'} shutdown=${m.shutdown}`,
        );
      }
      return;
    case 'quit':
      client.end();
      process.exit(0);
      return;
    default:
      if (cmd) console.log('unknown command');
  }
});
