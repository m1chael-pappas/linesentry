#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((arg) => !arg.startsWith('--'));

if (files.length === 0) {
  console.error('usage: summarise-emf.mjs [--json] <file.jsonl>...');
  process.exit(1);
}

/**
 * Metric names reported as a level rather than summed.
 *
 * Every other non-millisecond metric is totalled across flushes. See
 * ../packages/core/METRICS.md.
 */
const GAUGES = new Set(['DlqDepth', 'QueueDepth', 'TaskCount']);

/**
 * Nearest-rank percentile over an ascending array, or null when it is empty.
 *
 * Pure.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

const series = new Map();

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`skipping ${file}: ${error.message}`);
    continue;
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }

    const directive = doc._aws?.CloudWatchMetrics?.[0];
    if (!directive) continue;

    const key = `${doc.service ?? 'unknown'}/${doc.variant ?? 'unknown'}`;
    const entry =
      series.get(key) ??
      { counters: new Map(), samples: new Map(), gauges: new Map(), units: new Map() };
    series.set(key, entry);

    for (const definition of directive.Metrics ?? []) {
      const value = doc[definition.Name];
      if (value === undefined) continue;

      entry.units.set(definition.Name, definition.Unit ?? 'None');
      const values = Array.isArray(value) ? value : [value];

      if (definition.Unit === 'Milliseconds') {
        const held = entry.samples.get(definition.Name) ?? [];
        held.push(...values);
        entry.samples.set(definition.Name, held);
      } else if (GAUGES.has(definition.Name)) {
        const held = entry.gauges.get(definition.Name) ?? [];
        held.push(...values);
        entry.gauges.set(definition.Name, held);
      } else {
        const total = values.reduce((sum, v) => sum + v, 0);
        entry.counters.set(definition.Name, (entry.counters.get(definition.Name) ?? 0) + total);
      }
    }
  }
}

const summary = {};

for (const [key, entry] of [...series].sort()) {
  const latencies = {};
  for (const [name, values] of entry.samples) {
    const sorted = [...values].sort((a, b) => a - b);
    latencies[name] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1],
    };
  }
  const gauges = {};
  for (const [name, values] of entry.gauges) {
    gauges[name] = { samples: values.length, last: values[values.length - 1], max: Math.max(...values) };
  }

  summary[key] = {
    counters: Object.fromEntries([...entry.counters].sort()),
    gauges: Object.fromEntries(Object.entries(gauges).sort()),
    latencies,
  };
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

for (const [key, entry] of Object.entries(summary)) {
  console.log(`\n${key}`);

  const counters = Object.entries(entry.counters);
  if (counters.length) {
    console.log('  counters');
    for (const [name, total] of counters) console.log(`    ${name.padEnd(28)} ${total}`);
  }

  const gauges = Object.entries(entry.gauges);
  if (gauges.length) {
    console.log('  gauges                     last      max');
    for (const [name, stats] of gauges) {
      console.log(`    ${name.padEnd(24)} ${String(stats.last).padStart(8)} ${String(stats.max).padStart(8)}`);
    }
  }

  const latencies = Object.entries(entry.latencies);
  if (latencies.length) {
    console.log('  latency ms            count      p50      p95      max');
    for (const [name, stats] of latencies) {
      console.log(
        `    ${name.padEnd(24)} ${String(stats.count).padStart(4)} ${String(stats.p50).padStart(8)} ${String(stats.p95).padStart(8)} ${String(stats.max).padStart(8)}`,
      );
    }
  }
}
