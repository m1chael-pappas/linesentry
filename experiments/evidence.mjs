#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const variants = process.argv.slice(2);
if (variants.length === 0) variants.push('baseline');

/** Run order in the written table, so it does not follow directory order. */
const RUN_ORDER = ['baseline', 'ramp', 'burst', 'overload', 'scale', 'scale-in', 'failure'];

/**
 * Every run summary under evidence/<variant>/, in run order, each with `dir`
 * set to its directory name, which carries the `RUN_TAG` suffix when present.
 */
function summaries(variant) {
  const root = join('evidence', variant);
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((dir) => existsSync(join(root, dir, 'summary.json')))
    .map((dir) => ({ ...JSON.parse(readFileSync(join(root, dir, 'summary.json'), 'utf8')), dir }))
    .sort((a, b) => RUN_ORDER.indexOf(a.run) - RUN_ORDER.indexOf(b.run) || a.dir.localeCompare(b.dir, 'en', { numeric: true }));
}

function cell(value) {
  return value === null || value === undefined ? '-' : String(value);
}

function row(summary) {
  const m = summary.measured;
  const latency = m.latency_ms?.window_stored;
  const depth = m.detection_queue_depth;

  const aggDepth = m.aggregation_queue_depth;

  return [
    summary.dir,
    cell(latency?.p50),
    cell(latency?.p95),
    cell(aggDepth?.max),
    cell(depth?.max),
    `${cell(m.aggregation_tasks?.min)} to ${cell(m.aggregation_tasks?.max)}`,
    `${cell(m.detection_tasks?.min)} to ${cell(m.detection_tasks?.max)}`,
    cell(m.windows_stored),
  ].join(' | ');
}

function verdicts(summary) {
  const missed = Object.entries(summary.against_targets ?? {})
    .filter(([, verdict]) => verdict === 'MISSED')
    .map(([name]) => name);
  return missed.length === 0 ? 'all targets met' : `MISSED: ${missed.join(', ')}`;
}

let document = `# Evidence

Measured results, written by the experiment harness. Each run's raw samples, summary and plot are in \`evidence/<variant>/<run>/\`.

Targets come from the project brief. A missed target is reported as missed rather than adjusted.

| Target | Value |
|---|---|
| Edge output, steady | at most 80 msg/s |
| End to end p95 | under 5000 ms |
| Steady queue depth | under 100, draining within 60s of a burst ending |
| Detection tasks | scale from 1 upward and back |
`;

for (const variant of variants) {
  const runs = summaries(variant);
  if (runs.length === 0) continue;

  document += `\n## ${variant}\n\n`;
  document += '| Run | p50 ms | p95 ms | Agg depth max | Det depth max | Agg tasks | Det tasks | Windows |\n';
  document += '|---|---|---|---|---|---|---|---|\n';
  for (const summary of runs) document += `| ${row(summary)} |\n`;

  document += '\n| Run | Against targets |\n|---|---|\n';
  for (const summary of runs) document += `| ${summary.dir} | ${verdicts(summary)} |\n`;
}

if (variants.length === 2) {
  const [left, right] = variants.map(summaries);
  if (left.length && right.length) {
    document += `\n## ${variants[0]} against ${variants[1]}\n\n`;
    document += `| Run | ${variants[0]} p95 ms | ${variants[1]} p95 ms | ${variants[0]} edge msg/s | ${variants[1]} edge msg/s |\n`;
    document += '|---|---|---|---|---|\n';

    for (const run of RUN_ORDER) {
      const a = left.find((s) => s.run === run);
      const b = right.find((s) => s.run === run);
      if (!a || !b) continue;
      document += `| ${run} | ${cell(a.measured.latency_ms?.window_stored?.p95)} | ${cell(b.measured.latency_ms?.window_stored?.p95)} | ${cell(a.measured.edge_output_msg_per_second)} | ${cell(b.measured.edge_output_msg_per_second)} |\n`;
    }
  }
}

/**
 * One row per variant's `scale` run: the same seeded plant through each arm's
 * filter, published at plant scale, so only the filter differs between rows.
 */
function scaleTable(variantNames) {
  const rows = variantNames
    .map((name) => summaries(name).find((s) => s.dir === 'scale'))
    .filter(Boolean);
  if (rows.length === 0) return '';

  const control = rows.find((s) => !s.measured.detection_work?.windows_reconstructed);
  const capacity = control?.measured.detection_work?.saturated_throughput?.per_task_per_second_p50 ?? null;

  let table = '\n## Plant scale on AWS\n\n';
  table += 'The seeded plant run through each arm\'s filter by `load.mjs plant` and published to the ingest topic. Every arm sees the same plant, so the message rate and the task count differ only by the filter.\n\n';
  table += '| Variant | Machines | Published msg/s | Per machine msg/s | Detection tasks | Det depth max | p95 ms | Messages to detection | Windows judged | Windows rebuilt |\n';
  table += '|---|---|---|---|---|---|---|---|---|---|\n';
  for (const s of rows) {
    const m = s.measured;
    table += `| ${s.variant} | ${cell(m.plant_load?.machines)} | ${cell(m.plant_load?.forwarded_per_second)} | ${cell(m.plant_load?.forwarded_per_machine_second)} | ${cell(m.detection_tasks?.min)} to ${cell(m.detection_tasks?.max)} | ${cell(m.detection_queue_depth?.max)} | ${cell(m.latency_ms?.window_stored?.p95)} | ${cell(m.detection_work?.messages_processed)} | ${cell(m.detection_work?.windows_evaluated)} | ${cell(m.detection_work?.windows_reconstructed)} |\n`;
  }

  table += '\nPer-task capacity is the median messages per second one detection task processed in the minutes its queue never emptied. Machines per task divides the control arm\'s capacity by each arm\'s published rate per machine, so only the filter differs between rows.\n\n';
  table += '| Variant | Per-task msg/s, saturated | Saturated minutes | Tasks needed at control capacity | Machines per task at control capacity | Detection task-minutes |\n';
  table += '|---|---|---|---|---|---|\n';
  for (const s of rows) {
    const m = s.measured;
    const saturated = m.detection_work?.saturated_throughput;
    const rate = m.plant_load?.forwarded_per_second;
    const perMachine = m.plant_load?.forwarded_per_machine_second;
    const needed = capacity && rate ? (rate / capacity).toFixed(2) : null;
    const machines = capacity && perMachine ? Math.round(capacity / perMachine) : null;
    table += `| ${s.variant} | ${cell(saturated?.per_task_per_second_p50)} | ${cell(saturated?.minutes)} | ${cell(needed)} | ${cell(machines)} | ${cell(m.detection_work?.detection_task_minutes)} |\n`;
  }
  return table;
}

/**
 * Every plant-scale run that ran on one detection task throughout, whether
 * pinned there by `DETECTION_MAX_TASKS=1` or never scaled out.
 */
function oneTaskTable(variantNames) {
  const rows = variantNames
    .flatMap(summaries)
    .filter((s) => s.run === 'scale' && s.measured.detection_tasks?.min === 1 && s.measured.detection_tasks?.max === 1);
  if (rows.length === 0) return '';

  let table = '\n## Plant scale on one detection task\n\n';
  table += 'Plant-scale runs that held one detection task from start to finish. A run that kept up drains its queue within seconds of the load stopping; one that fell behind takes minutes, and its backlogged minutes measure one task\'s capacity at that arm\'s traffic. Machines per task divides that capacity by the run\'s published rate per machine. Each deployment runs its own task, so runs under one variant share a task and runs under different variants do not.\n\n';
  table += '| Run | Bound sigma | Machines | Published msg/s | Det depth max | Depth when load stopped | Drained after s | One-task msg/s, backlogged | Backlogged minutes | CPU ms/msg, backlogged | Machines per task | Metadata reads/msg | Alert reads/msg |\n';
  table += '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const s of rows) {
    const m = s.measured;
    const saturated = m.detection_work?.saturated_throughput;
    const capacity = saturated?.one_task_per_second_p50;
    const perMachine = m.plant_load?.forwarded_per_machine_second;
    const machines = capacity && perMachine ? Math.round(capacity / perMachine) : null;
    table += `| ${s.variant}/${s.dir} | ${cell(s.error_bound_sigma)} | ${cell(m.plant_load?.machines)} | ${cell(m.plant_load?.forwarded_per_second)} | ${cell(m.detection_queue_depth?.max)} | ${cell(m.load_end?.detection_depth)} | ${cell(m.load_end?.drained_after_seconds)} | ${cell(capacity)} | ${cell(saturated?.one_task_minutes)} | ${cell(saturated?.cpu_ms_per_message)} | ${cell(machines)} | ${cell(m.detection_work?.metadata_reads_per_message)} | ${cell(m.detection_work?.alert_reads_per_message)} |\n`;
  }
  return table;
}

/** Reads every offline sweep written under evidence/sweep/. */
function sweeps() {
  const root = join('evidence', 'sweep');
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((scenario) => !scenario.includes('-seed-'))
    .map((scenario) => join(root, scenario, 'sweep.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')));
}

/** The faults sweep for every seed, the default seed first. */
function seededSweeps() {
  const root = join('evidence', 'sweep');
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((scenario) => scenario === 'faults' || scenario.startsWith('faults-seed-'))
    .sort()
    .map((scenario) => JSON.parse(readFileSync(join(root, scenario, 'sweep.json'), 'utf8')));
}

/** `mean (min to max)` of `values` to `dp` decimal places. */
function spread(values, dp) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const fixed = (value) => value.toFixed(dp);
  return `${fixed(mean)} (${fixed(Math.min(...values))} to ${fixed(Math.max(...values))})`;
}

/** Headline arms of the faults sweep as a mean and range across seeds. */
function seedTable() {
  const runs = seededSweeps();
  if (runs.length < 2) return '';

  const arms = [
    'deadband/hb60',
    'deadband/hb600',
    'dual-prediction/0.5sigma/hb600',
    'dual-prediction/1sigma/hb600',
    'dual-prediction/2sigma/hb600',
  ];

  let table = `\n## Offline sweep across seeds\n\n`;
  table += `The faults sweep repeated on ${runs.length} seeds (${runs.map((r) => `\`${r.seed}\``).join(', ')}), each a different plant with the same fault schedule. Each cell is the mean with the range across seeds.\n\n`;
  table += '| Arm | msg/s | Consumer coverage % | Worst error sigma | Faults | Events on healthy machines | Fewer messages than deadband/hb60 |\n';
  table += '|---|---|---|---|---|---|---|\n';

  for (const name of arms) {
    const rows = runs.map((run) => run.arms.find((arm) => arm.arm === name)).filter(Boolean);
    if (rows.length !== runs.length) continue;
    const control = runs.map((run) => run.arms.find((arm) => arm.arm === 'deadband/hb60'));
    const errors = rows.map((row) => row.reconstruction_error_sigma?.max);
    const found = [...new Set(rows.map((row) => `${row.faults_matched}/${row.faults_injected}`))].join(', ');
    const ratio = rows.map((row, i) => control[i].forwarded_per_second / row.forwarded_per_second);

    table += `| ${name} | ${spread(rows.map((r) => r.forwarded_per_second), 2)} | ${spread(rows.map((r) => r.consumer_coverage_pct), 1)} | ${errors.every((v) => v === undefined) ? '-' : spread(errors, 2)} | ${found} | ${spread(rows.map((r) => r.events_on_healthy_machines), 0)} | ${spread(ratio, 2)}x |\n`;
  }
  return table;
}

function sweepRow(arm) {
  return [
    arm.arm,
    cell(arm.forwarded_per_second),
    cell(arm.dropped_pct),
    cell(arm.consumer_coverage_pct),
    cell(arm.windows_evaluated_per_second),
    cell(arm.reconstruction_error_sigma?.max),
    `${arm.faults_matched}/${arm.faults_injected}`,
    cell(arm.detection_delay_windows?.p95),
    cell(arm.events_on_healthy_machines),
    cell(arm.machines_per_task),
  ].join(' | ');
}

/** Ratio of the control arm's value to `arm`'s, to one decimal place. */
function against(control, arm, field) {
  if (!control[field] || !arm[field]) return '-';
  return `${(control[field] / arm[field]).toFixed(2)}x`;
}

document += scaleTable(variants);
document += oneTaskTable(variants);
document += seedTable();

for (const sweep of sweeps()) {
  const control = sweep.arms.find((arm) => arm.arm === 'deadband/hb60');
  if (!control) continue;

  document += `\n## Offline sweep, ${sweep.scenario}\n\n`;
  document += `${sweep.machines} machines over ${sweep.seconds}s, seed \`${sweep.seed}\`, ${sweep.faults.length} faults injected, ${sweep.windows_produced} windows produced.\n`;
  document += `Every arm judges the same windows, fanned out from one aggregator and one smoother. Machines per task is derived from ${sweep.machines_per_task_basis}.\n`;
  document += `The full grid is in \`evidence/sweep/${sweep.scenario}/sweep.csv\`, plotted in \`sweep-${sweep.scenario}.png\`.\n\n`;

  const headline = sweep.arms.filter(
    (arm) => arm.arm === 'deadband/hb60' || (arm.heartbeat_ms === 600000 && [0.5, 1, 2].includes(arm.error_bound_sigma)),
  );

  document += '| Arm | msg/s | Fewer messages | Consumer coverage | Faults | FP | Machines per task | More machines |\n';
  document += '|---|---|---|---|---|---|---|---|\n';
  for (const arm of headline) {
    document += `| ${arm.arm} | ${cell(arm.forwarded_per_second)} | ${against(control, arm, 'forwarded_per_second')} | ${cell(arm.consumer_coverage_pct)}% | ${arm.faults_matched}/${arm.faults_injected} | ${cell(arm.events_on_healthy_machines)} | ${cell(arm.machines_per_task)} | ${against(arm, control, 'machines_per_task')} |\n`;
  }

  document += '\n| Arm | msg/s | Dropped % | Coverage % | Evaluated/s | Worst error sigma | Faults | Delay p95 | FP | Machines per task |\n';
  document += '|---|---|---|---|---|---|---|---|---|---|\n';
  for (const arm of sweep.arms) document += `| ${sweepRow(arm)} |\n`;
}

writeFileSync(join('evidence', 'EVIDENCE.md'), document);
console.log('wrote evidence/EVIDENCE.md');
