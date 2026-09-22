#!/usr/bin/env node
// Replays the seeded plant through the edge chain and the detection rules for
// every error bound and heartbeat, with no AWS account.
//
//   node experiments/sweep.mjs steady
//   node experiments/sweep.mjs faults
//   MACHINES=50 LINES=4 SECONDS=900 node experiments/sweep.mjs faults
//
// Writes evidence/sweep/<scenario>/sweep.json and sweep.csv, or
// evidence/sweep/<scenario>-<seed>/ when SEED is not the default.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_SD,
  DEADBAND,
  SENSOR_TYPES,
  WINDOW_MS,
  alertKey,
  createEwmaSmoother,
  createMemoryAlertStateStore,
  createWindowAggregator,
  detectionRegistry,
  edgeFilterRegistry,
  machineMetadata,
} from '../packages/core/dist/index.js';
import { buildPlant, FAULT_SENSORS, SENSORS, UNITS } from '../simulator/dist/plant.js';
import { buildEvent, eventRank } from '../services/detection/dist/events.js';
import { reconstructWindows } from '../services/detection/dist/strategies/dual-prediction.js';
import '../services/detection/dist/strategies/baseline.js';
import '../services/detection/dist/strategies/dual-prediction.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCENARIO = process.argv[2] ?? 'steady';
const MACHINES_PER_LINE = Number(process.env.MACHINES ?? 50);
const LINES = Number(process.env.LINES ?? 4);
const SECONDS = Number(process.env.SECONDS ?? 900);
const SEED = process.env.SEED ?? 'linesentry';
const SITE_ID = process.env.SITE_ID ?? 'plant-01';
const START = 1789000000000;

/** Error bounds swept, in standard deviations of the smoothed window value. */
const BOUNDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Heartbeat intervals swept, in milliseconds. */
const HEARTBEATS = [60000, 150000, 300000, 600000];

/** Detection tuning, matching the detection service's defaults. */
const DETECTION = { zScoreSigma: 3, historyWindows: 6, rulHorizonMs: 300000 };

/** Alert episode length, matching `ALERT_EPISODE_MS`. */
const EPISODE_MS = 600000;

/**
 * Messages one detection task sustains while saturated, measured on AWS at
 * 6,000 machines on the deadband arm over 12 backlogged minutes.
 *
 * Used to derive machines supported per task, so the offline curve and the
 * plant-scale table divide by the same capacity.
 */
const MESSAGES_PER_TASK_SECOND = 101.3;

/** Faults injected in the `faults` scenario, one per machine. */
function faultSchedule(machines) {
  if (SCENARIO !== 'faults') return [];

  const types = ['bearing', 'overheat', 'overload', 'dropout'];
  const schedule = [];

  for (let i = 0; i < 16 && i < machines.length; i++) {
    const machine = machines[Math.floor((i * machines.length) / 16)];
    schedule.push({
      machine_id: machine.id,
      fault: types[i % types.length],
      at: 120 + i * 30,
      cleared_at: 120 + i * 30 + 240,
    });
  }

  return schedule;
}

/** Percentile of an already sorted array. */
function at(sorted, percentile) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

/**
 * Percentiles, mean and extremes of `values`.
 *
 * Sorts one copy rather than per percentile, and folds for the extremes, since
 * a run holds hundreds of thousands of samples and spreading one into
 * `Math.max` exceeds the call stack.
 */
function distribution(values, dp) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    samples: sorted.length,
    p50: round(at(sorted, 50), dp),
    p95: round(at(sorted, 95), dp),
    max: round(sorted[sorted.length - 1], dp),
    mean: round(total / sorted.length, dp),
  };
}

function round(value, dp) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Builds one arm: an edge filter, a detection strategy, and the counters the
 * sweep reports for it.
 *
 * `clock` is read by the alert store so episodes run on simulated time.
 */
function createArm(label, filterName, config, strategyName, clock) {
  const filter = edgeFilterRegistry.create(filterName, config);
  const strategy = detectionRegistry.create(strategyName, DETECTION);
  const alerts = createMemoryAlertStateStore(() => clock.now);
  const history = new Map();
  const lastForward = new Map();

  const perSensor = Object.fromEntries(
    SENSOR_TYPES.map((sensor) => [sensor, { windows: 0, forwarded: 0 }]),
  );

  return {
    label,
    filterName,
    strategyName,
    errorBoundSigma: config.errorBoundSigma ?? null,
    heartbeatMs: config.heartbeatMs,
    windows: 0,
    forwarded: 0,
    reconstructed: 0,
    gapWindows: 0,
    evaluated: 0,
    reasons: {},
    perSensor,
    errors: [],
    events: [],
    lastForward,

    async consume(pending, truth) {
      this.windows++;
      perSensor[pending.sensor_type].windows++;

      const decision = filter.decide(pending, clock.now);
      if (!decision.forward) return;

      this.forwarded++;
      perSensor[pending.sensor_type].forwarded++;
      lastForward.set(`${pending.machine_id}/${pending.sensor_type}`, pending.window_start);
      this.reasons[decision.reason] = (this.reasons[decision.reason] ?? 0) + 1;

      const window = { ...pending, forward_reason: decision.reason };
      if (decision.ext) window.ext = decision.ext;

      this.evaluated += 1 + Math.min(this.gapAhead(window), DETECTION.historyWindows);

      for (const rebuilt of reconstructWindows(window, Infinity)) {
        const real = truth.get(`${pending.machine_id}/${pending.sensor_type}@${rebuilt.window_start}`);
        this.gapWindows++;
        if (real === undefined) continue;
        this.reconstructed++;
        this.errors.push(Math.abs(real - rebuilt.smoothed) / BASELINE_SD[pending.sensor_type]);
      }

      await this.judge(window);
    },

    /** Windows in the gap this one closes, uncapped. */
    gapAhead(window) {
      return reconstructWindows(window, Infinity).length;
    },

    async judge(window) {
      const key = `${window.machine_id}#${window.sensor_type}`;
      const held = history.get(key) ?? [];
      const kept = [...held.filter((w) => w.window_start !== window.window_start), window]
        .sort((a, b) => a.window_start - b.window_start)
        .slice(-DETECTION.historyWindows);
      history.set(key, kept);

      const metadata = METADATA.get(window.machine_id);
      const findings = strategy.evaluate(window, { metadata, history: kept });
      const event = buildEvent(window, findings, clock.now);
      if (!event) return;

      if (!(await alerts.claim(alertKey(window.machine_id, window.sensor_type), eventRank(event), event.event_id, EPISODE_MS))) {
        return;
      }

      this.events.push(event);
    },
  };
}

const plant = buildPlant(MACHINES_PER_LINE, LINES, SEED);
const machineCount = plant.length;
const METADATA = new Map(
  plant.map((machine) => [machine.id, machineMetadata(machine.id, SITE_ID, machine.lineId, machine.base)]),
);

const schedule = faultSchedule(plant);
const byId = new Map(plant.map((machine) => [machine.id, machine]));
const clock = { now: START };

const arms = [];
for (const heartbeatMs of HEARTBEATS) {
  arms.push(
    createArm(`deadband/hb${heartbeatMs / 1000}`, 'deadband', { deadband: DEADBAND, heartbeatMs }, 'baseline', clock),
  );
}
for (const heartbeatMs of HEARTBEATS) {
  for (const errorBoundSigma of BOUNDS) {
    arms.push(
      createArm(
        `dual-prediction/${errorBoundSigma}sigma/hb${heartbeatMs / 1000}`,
        'dual-prediction',
        { deadband: DEADBAND, heartbeatMs, errorBoundSigma, historyWindows: DETECTION.historyWindows },
        'dual-prediction',
        clock,
      ),
    );
  }
}

console.log(
  `${SCENARIO}: ${machineCount} machines, ${SECONDS}s, ${schedule.length} faults, ${arms.length} arms`,
);

const aggregator = createWindowAggregator();
const smoother = createEwmaSmoother();
const truth = new Map();
const truthByKey = new Map();

let produced = 0;

/** Feeds one closed window to every arm after smoothing it once. */
async function fanOut(summary) {
  const pending = smoother.apply(summary);
  produced++;
  const key = `${pending.machine_id}/${pending.sensor_type}`;
  truth.set(`${key}@${pending.window_start}`, pending.smoothed);
  const starts = truthByKey.get(key);
  if (starts) starts.push(pending.window_start);
  else truthByKey.set(key, [pending.window_start]);
  for (const arm of arms) await arm.consume(pending, truth);
}

const started = Date.now();

for (let second = 0; second < SECONDS; second++) {
  const now = START + second * 1000;
  clock.now = now;

  for (const injection of schedule) {
    const machine = byId.get(injection.machine_id);
    if (second === injection.at) {
      machine.fault = injection.fault;
      machine.faultStart = now;
    }
    if (second === injection.cleared_at) machine.fault = null;
  }

  for (const machine of plant) {
    const readings = machine.readings(now);
    for (const sensor of SENSORS) {
      const closed = aggregator.add(
        {
          ts: now,
          site_id: SITE_ID,
          line_id: machine.lineId,
          machine_id: machine.id,
          sensor_type: sensor,
          value: readings[sensor],
          unit: UNITS[sensor],
          seq: second,
        },
        now,
      );
      if (closed) await fanOut(closed);
    }
  }

  if (second > 0 && second % 300 === 0) {
    console.log(`  t+${second}s, ${produced} windows through ${arms.length} arms`);
  }
}

clock.now = START + SECONDS * 1000 + WINDOW_MS;
for (const closed of aggregator.flush(clock.now)) await fanOut(closed);

/** Matches each injected fault against the first event on a sensor it moves. */
function matchFaults(events) {
  const matched = [];
  const missed = [];

  for (const injection of schedule) {
    const sensors = FAULT_SENSORS[injection.fault];
    const from = START + injection.at * 1000;
    const to = START + injection.cleared_at * 1000;

    const hit = events
      .filter(
        (event) =>
          event.machine_id === injection.machine_id &&
          sensors.includes(event.sensor_type) &&
          event.window_start >= from &&
          event.window_start <= to,
      )
      .sort((a, b) => a.window_start - b.window_start)[0];

    if (!hit) {
      missed.push(injection);
      continue;
    }

    matched.push({
      ...injection,
      event_id: hit.event_id,
      sensor_type: hit.sensor_type,
      type: hit.type,
      delay_windows: Math.round((hit.window_start - from) / WINDOW_MS),
    });
  }

  return { matched, missed };
}

/** Counts `events` by whatever `key` returns. */
function tally(events, key) {
  const counts = {};
  for (const event of events) counts[key(event)] = (counts[key(event)] ?? 0) + 1;
  return counts;
}

/** True when `event` names a machine with no fault active at its window. */
function unfaulted(event) {
  return !schedule.some(
    (injection) =>
      injection.machine_id === event.machine_id &&
      event.window_start >= START + injection.at * 1000 &&
      event.window_start <= START + injection.cleared_at * 1000,
  );
}

/**
 * Windows up to each key's last forward.
 *
 * A gap travels on the message that closes it, so the windows after a key's
 * last forward are not reconstructed yet and are not the arm's to answer for.
 */
function closedWindows(arm) {
  let total = 0;
  for (const [key, starts] of truthByKey) {
    const last = arm.lastForward.get(key);
    if (last === undefined) continue;
    total += starts.filter((start) => start <= last).length;
  }
  return total;
}

function report(arm) {
  const { matched, missed } = matchFaults(arm.events);
  const delays = matched.map((m) => m.delay_windows);
  const perMachineSecond = arm.forwarded / machineCount / SECONDS;
  const closed = closedWindows(arm);

  return {
    arm: arm.label,
    filter: arm.filterName,
    strategy: arm.strategyName,
    error_bound_sigma: arm.errorBoundSigma,
    heartbeat_ms: arm.heartbeatMs,
    windows_produced: arm.windows,
    forwarded: arm.forwarded,
    forwarded_per_second: round(arm.forwarded / SECONDS, 2),
    forwarded_per_machine_second: round(perMachineSecond, 5),
    dropped_pct: round((1 - arm.forwarded / arm.windows) * 100, 1),
    reasons: arm.reasons,
    content_forwards: (arm.reasons.changed ?? 0) + (arm.reasons.divergence ?? 0),
    heartbeat_forwards: arm.reasons.heartbeat ?? 0,
    safety_forwards: arm.reasons.safety ?? 0,
    reconstructed: arm.reconstructed,
    gap_windows: arm.gapWindows,
    windows_in_closed_gaps: closed,
    consumer_coverage_pct: closed > 0 ? round(((arm.forwarded + arm.reconstructed) / closed) * 100, 1) : 0,
    reconstruction_error_sigma: distribution(arm.errors, 4),
    windows_evaluated: arm.evaluated,
    windows_evaluated_per_second: round(arm.evaluated / SECONDS, 2),
    events: arm.events.length,
    faults_injected: schedule.length,
    faults_matched: matched.length,
    faults_missed: missed.length,
    events_on_healthy_machines: arm.events.filter(unfaulted).length,
    healthy_events_by_type: tally(arm.events.filter(unfaulted), (event) => event.type),
    healthy_events_by_sensor: tally(arm.events.filter(unfaulted), (event) => event.sensor_type),
    detection_delay_windows: distribution(delays, 1),
    machines_per_task: perMachineSecond > 0 ? Math.round(MESSAGES_PER_TASK_SECOND / perMachineSecond) : null,
    per_sensor: Object.fromEntries(
      SENSOR_TYPES.map((sensor) => [
        sensor,
        {
          windows: arm.perSensor[sensor].windows,
          forwarded: arm.perSensor[sensor].forwarded,
          dropped_pct: round((1 - arm.perSensor[sensor].forwarded / arm.perSensor[sensor].windows) * 100, 1),
          deadband_sigma: round(DEADBAND[sensor] / BASELINE_SD[sensor], 2),
        },
      ]),
    ),
  };
}

const rows = arms.map(report);

const summary = {
  scenario: SCENARIO,
  seed: SEED,
  machines: machineCount,
  lines: LINES,
  seconds: SECONDS,
  windows_produced: produced,
  windows_per_second: round(produced / SECONDS, 2),
  machines_per_task_basis: `${MESSAGES_PER_TASK_SECOND} messages/s/task, measured on AWS`,
  faults: schedule,
  arms: rows,
};

const outDir = join(root, 'evidence', 'sweep', SEED === 'linesentry' ? SCENARIO : `${SCENARIO}-${SEED}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sweep.json'), `${JSON.stringify(summary, null, 2)}\n`);

const columns = [
  'arm',
  'filter',
  'error_bound_sigma',
  'heartbeat_ms',
  'forwarded_per_second',
  'forwarded_per_machine_second',
  'dropped_pct',
  'content_forwards',
  'heartbeat_forwards',
  'safety_forwards',
  'consumer_coverage_pct',
  'windows_evaluated_per_second',
  'reconstruction_error_p95',
  'reconstruction_error_max',
  'events',
  'faults_matched',
  'faults_missed',
  'events_on_healthy_machines',
  'detection_delay_p50',
  'detection_delay_p95',
  'machines_per_task',
];

const csv = [columns.join(',')];
for (const row of rows) {
  csv.push(
    [
      row.arm,
      row.filter,
      row.error_bound_sigma ?? '',
      row.heartbeat_ms,
      row.forwarded_per_second,
      row.forwarded_per_machine_second,
      row.dropped_pct,
      row.content_forwards,
      row.heartbeat_forwards,
      row.safety_forwards,
      row.consumer_coverage_pct,
      row.windows_evaluated_per_second,
      row.reconstruction_error_sigma?.p95 ?? '',
      row.reconstruction_error_sigma?.max ?? '',
      row.events,
      row.faults_matched,
      row.faults_missed,
      row.events_on_healthy_machines,
      row.detection_delay_windows?.p50 ?? '',
      row.detection_delay_windows?.p95 ?? '',
      row.machines_per_task ?? '',
    ].join(','),
  );
}
writeFileSync(join(outDir, 'sweep.csv'), `${csv.join('\n')}\n`);

console.log(`\n${produced} windows produced, ${round((Date.now() - started) / 1000, 1)}s\n`);
console.log(
  'arm                                  fwd/s  drop%  content     hb  safety  cover%  err p95  err max  match  delay p95  mach/task',
);
for (const row of rows) {
  console.log(
    [
      row.arm.padEnd(35),
      String(row.forwarded_per_second).padStart(6),
      String(row.dropped_pct).padStart(6),
      String(row.content_forwards).padStart(8),
      String(row.heartbeat_forwards).padStart(6),
      String(row.safety_forwards).padStart(7),
      String(row.consumer_coverage_pct).padStart(7),
      String(row.reconstruction_error_sigma?.p95 ?? '-').padStart(8),
      String(row.reconstruction_error_sigma?.max ?? '-').padStart(8),
      `${row.faults_matched}/${row.faults_injected}`.padStart(6),
      String(row.detection_delay_windows?.p95 ?? '-').padStart(10),
      String(row.machines_per_task ?? '-').padStart(10),
    ].join(' '),
  );
}
console.log(`\nwrote ${join(outDir, 'sweep.json')} and sweep.csv`);
