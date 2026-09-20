import type { FaultType, SensorType, Unit } from '@linesentry/core';

/** Sensors fitted to every machine, in publish order. */
export const SENSORS: readonly SensorType[] = ['vibration', 'temperature', 'current', 'rpm'];

/** Unit reported with each sensor's value. */
export const UNITS: Record<SensorType, Unit> = {
  vibration: 'mm/s',
  temperature: 'C',
  current: 'A',
  rpm: 'rpm',
};

/** Faults that can be injected from the keyboard or the control topic. */
export const FAULTS: readonly FaultType[] = ['bearing', 'overheat', 'overload', 'dropout'];

/** Returns true when the value is one of the injectable fault names. */
export function isFaultType(value: unknown): value is FaultType {
  return typeof value === 'string' && (FAULTS as readonly string[]).includes(value);
}

/** One sample from every sensor on a machine. */
export type Readings = Record<SensorType, number>;

/** Returns numbers in [0, 1), deterministic for a given seed. */
export type Random = () => number;

function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Builds the random stream for one machine.
 *
 * Streams are per machine and derived from the run seed and the machine id, so
 * the plant produces the same signal on every run with the same seed and the
 * same machine still behaves the same whether the run has 5 machines or 200.
 * Two arms of an experiment can therefore be compared on identical load.
 */
export function machineRandom(seed: string, machineId: string): Random {
  return mulberry32(hash(`${seed}:${machineId}`));
}

function gauss(random: Random, mean: number, sd: number): number {
  const u = 1 - random();
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * The resting value of each sensor on one machine.
 *
 * Derived from the run seed and the machine id rather than drawn at startup,
 * so the metadata store can be seeded with the same numbers the machine will
 * actually produce. Called by the bootstrap tool as well as by the machine.
 */
export function machineBaseline(seed: string, machineId: string): Readings {
  const random = mulberry32(hash(`${seed}:${machineId}:baseline`));
  return {
    vibration: round(gauss(random, 2.1, 0.3), 2),
    temperature: round(gauss(random, 55, 4), 1),
    current: round(gauss(random, 12, 1.5), 1),
    rpm: Math.round(gauss(random, 1450, 40)),
  };
}

/**
 * A single machine with its own idea of normal.
 *
 * Normal differs machine to machine, which is what makes a per-machine
 * baseline worth storing rather than one plant-wide threshold. Both the
 * baseline and the noise come from a stream seeded by the run seed and the
 * machine id, so a machine behaves identically across runs. See
 * ../SIMULATION.md.
 */
export class Machine {
  readonly lineId: string;
  readonly id: string;
  readonly base: Readings;
  private readonly random: Random;
  load = 1.0;
  fault: FaultType | null = null;
  faultStart = 0;
  shutdown = false;
  beacon = false;
  seq = 0;

  constructor(lineId: string, index: number, seed: string) {
    this.lineId = lineId;
    this.id = `press-${String(index).padStart(2, '0')}`;
    this.base = machineBaseline(seed, this.id);
    this.random = machineRandom(seed, this.id);
  }

  /** Seconds since the current fault or shutdown started. */
  faultAge(now: number): number {
    return this.fault ? (now - this.faultStart) / 1000 : 0;
  }

  /** Samples every sensor at the given instant, applying any active fault. */
  readings(now: number): Readings {
    const random = this.random;
    if (this.shutdown) {
      return {
        vibration: round(gauss(random, 0.1, 0.02), 2),
        temperature: round(Math.max(20, this.base.temperature - this.faultAge(now) * 0.2), 1),
        current: 0,
        rpm: 0,
      };
    }

    this.load += gauss(random, 0, 0.01);
    this.load = Math.min(1.3, Math.max(0.7, this.load));

    const age = this.faultAge(now);
    let vibration = gauss(random, this.base.vibration, 0.15);
    let temperature = this.base.temperature + 2 * Math.sin(now / 60000) + gauss(random, 0, 0.3);
    let current = this.base.current * this.load + gauss(random, 0, 0.2);
    let rpm = gauss(random, this.base.rpm, 8);

    switch (this.fault) {
      case 'bearing':
        vibration += 0.08 * age + (random() < 0.2 ? gauss(random, 1.5, 0.5) : 0);
        temperature += 0.05 * age;
        break;
      case 'overheat':
        temperature += 0.5 * age;
        current += 0.02 * age;
        break;
      case 'overload':
        current *= 1.4;
        rpm -= 120;
        vibration += 0.4;
        break;
      case 'dropout':
        if (random() < 0.3) rpm = gauss(random, 200, 50);
        break;
      default:
        break;
    }

    return {
      vibration: round(Math.max(0, vibration), 2),
      temperature: round(temperature, 1),
      current: round(Math.max(0, current), 1),
      rpm: Math.max(0, Math.round(rpm)),
    };
  }
}

/** Seed used when no run seed is given, so a plain run is still reproducible. */
export const DEFAULT_SEED = 'linesentry';

/** Builds the plant as `lines` production lines of `machinesPerLine` machines. */
export function buildPlant(machinesPerLine: number, lines: number, seed = DEFAULT_SEED): Machine[] {
  const machines: Machine[] = [];
  for (let l = 0; l < lines; l++) {
    const lineId = `line-${String.fromCharCode(65 + l)}`;
    for (let m = 1; m <= machinesPerLine; m++) {
      machines.push(new Machine(lineId, l * machinesPerLine + m, seed));
    }
  }
  return machines;
}
