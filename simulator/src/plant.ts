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

function gauss(mean: number, sd: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * A single machine with its own idea of normal.
 *
 * Baselines are drawn once at construction so that "normal" differs machine to
 * machine, which is what makes a per-machine baseline worth storing rather
 * than a single plant-wide threshold. See ../SIMULATION.md.
 */
export class Machine {
  readonly lineId: string;
  readonly id: string;
  readonly base: Readings;
  load = 1.0;
  fault: FaultType | null = null;
  faultStart = 0;
  shutdown = false;
  beacon = false;
  seq = 0;

  constructor(lineId: string, index: number) {
    this.lineId = lineId;
    this.id = `press-${String(index).padStart(2, '0')}`;
    this.base = {
      vibration: round(gauss(2.1, 0.3), 2),
      temperature: round(gauss(55, 4), 1),
      current: round(gauss(12, 1.5), 1),
      rpm: Math.round(gauss(1450, 40)),
    };
  }

  /** Seconds since the current fault or shutdown started. */
  faultAge(now: number): number {
    return this.fault ? (now - this.faultStart) / 1000 : 0;
  }

  /** Samples every sensor at the given instant, applying any active fault. */
  readings(now: number): Readings {
    if (this.shutdown) {
      return {
        vibration: round(gauss(0.1, 0.02), 2),
        temperature: round(Math.max(20, this.base.temperature - this.faultAge(now) * 0.2), 1),
        current: 0,
        rpm: 0,
      };
    }

    this.load += gauss(0, 0.01);
    this.load = Math.min(1.3, Math.max(0.7, this.load));

    const age = this.faultAge(now);
    let vibration = gauss(this.base.vibration, 0.15);
    let temperature = this.base.temperature + 2 * Math.sin(now / 60000) + gauss(0, 0.3);
    let current = this.base.current * this.load + gauss(0, 0.2);
    let rpm = gauss(this.base.rpm, 8);

    switch (this.fault) {
      case 'bearing':
        vibration += 0.08 * age + (Math.random() < 0.2 ? gauss(1.5, 0.5) : 0);
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
        if (Math.random() < 0.3) rpm = gauss(200, 50);
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

/** Builds the plant as `lines` production lines of `machinesPerLine` machines. */
export function buildPlant(machinesPerLine: number, lines: number): Machine[] {
  const machines: Machine[] = [];
  for (let l = 0; l < lines; l++) {
    const lineId = `line-${String.fromCharCode(65 + l)}`;
    for (let m = 1; m <= machinesPerLine; m++) {
      machines.push(new Machine(lineId, l * machinesPerLine + m));
    }
  }
  return machines;
}
