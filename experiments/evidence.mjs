#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const variants = process.argv.slice(2);
if (variants.length === 0) variants.push('baseline');

/** Run order in the written table, so it does not follow directory order. */
const RUN_ORDER = ['baseline', 'ramp', 'burst', 'scale-in', 'failure'];

function summaries(variant) {
  const root = join('evidence', variant);
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .map((run) => join(root, run, 'summary.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')))
    .sort((a, b) => RUN_ORDER.indexOf(a.run) - RUN_ORDER.indexOf(b.run));
}

function cell(value) {
  return value === null || value === undefined ? '-' : String(value);
}

function row(summary) {
  const m = summary.measured;
  const latency = m.latency_ms?.window_stored;
  const depth = m.detection_queue_depth;

  return [
    summary.run,
    cell(m.edge_output_msg_per_second),
    cell(latency?.p50),
    cell(latency?.p95),
    cell(depth?.p95),
    cell(depth?.max),
    `${cell(m.detection_tasks?.min)} to ${cell(m.detection_tasks?.max)}`,
    cell(m.detection_tasks?.final),
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
  document += '| Run | Edge msg/s | p50 ms | p95 ms | Depth p95 | Depth max | Tasks | Final tasks | Windows |\n';
  document += '|---|---|---|---|---|---|---|---|---|\n';
  for (const summary of runs) document += `| ${row(summary)} |\n`;

  document += '\n| Run | Against targets |\n|---|---|\n';
  for (const summary of runs) document += `| ${summary.run} | ${verdicts(summary)} |\n`;
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

writeFileSync(join('evidence', 'EVIDENCE.md'), document);
console.log('wrote evidence/EVIDENCE.md');
