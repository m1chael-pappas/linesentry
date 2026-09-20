import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { METRICS_NAMESPACE, createMetrics } from './metrics.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linesentry-emf-'));
  file = join(dir, 'metrics.jsonl');
  process.env.EMF_FILE = file;
  process.env.VARIANT = 'baseline';
});

afterEach(() => {
  delete process.env.EMF_FILE;
  delete process.env.VARIANT;
  rmSync(dir, { recursive: true, force: true });
});

function lines(): Record<string, never>[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, never>);
  } catch {
    return [];
  }
}

describe('createMetrics', () => {
  it('writes nothing when nothing was recorded', () => {
    createMetrics('detection').flush();
    expect(lines()).toHaveLength(0);
  });

  it('writes one document per flush', () => {
    const metrics = createMetrics('detection');
    metrics.count('MessagesProcessed');
    metrics.flush();
    metrics.count('MessagesProcessed');
    metrics.flush();
    expect(lines()).toHaveLength(2);
  });

  it('dimensions every document by service and variant', () => {
    const metrics = createMetrics('alerting');
    metrics.count('EventsWritten');
    metrics.flush();

    const doc = lines()[0]! as Record<string, unknown>;
    expect(doc.service).toBe('alerting');
    expect(doc.variant).toBe('baseline');

    const directive = (doc._aws as { CloudWatchMetrics: Record<string, unknown>[] })
      .CloudWatchMetrics[0]!;
    expect(directive.Namespace).toBe(METRICS_NAMESPACE);
    expect(directive.Dimensions).toEqual([['service', 'variant']]);
  });

  it('sums counters rather than listing every increment', () => {
    const metrics = createMetrics('detection');
    metrics.count('MessagesProcessed');
    metrics.count('MessagesProcessed', 4);
    metrics.flush();
    expect((lines()[0] as Record<string, unknown>).MessagesProcessed).toBe(5);
  });

  it('emits a single latency sample as a number', () => {
    const metrics = createMetrics('detection');
    metrics.record('EndToEndLatency', 120);
    metrics.flush();
    expect((lines()[0] as Record<string, unknown>).EndToEndLatency).toBe(120);
  });

  it('emits several latency samples as an array, so percentiles see the distribution', () => {
    const metrics = createMetrics('detection');
    metrics.record('EndToEndLatency', 100);
    metrics.record('EndToEndLatency', 200);
    metrics.flush();
    expect((lines()[0] as Record<string, unknown>).EndToEndLatency).toEqual([100, 200]);
  });

  it('caps a metric at the 100 sample limit embedded metric format allows', () => {
    const metrics = createMetrics('detection');
    for (let i = 0; i < 150; i++) metrics.record('EndToEndLatency', i);
    metrics.flush();
    expect((lines()[0] as Record<string, unknown>).EndToEndLatency).toHaveLength(100);
  });

  it('carries the unit for each metric', () => {
    const metrics = createMetrics('detection');
    metrics.record('EndToEndLatency', 10);
    metrics.count('MessagesProcessed');
    metrics.flush();

    const directive = ((lines()[0] as Record<string, unknown>)._aws as {
      CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
    }).CloudWatchMetrics[0]!;
    const byName = Object.fromEntries(directive.Metrics.map((m) => [m.Name, m.Unit]));
    expect(byName).toEqual({ EndToEndLatency: 'Milliseconds', MessagesProcessed: 'Count' });
  });

  it('clears what it recorded so a metric does not repeat across flushes', () => {
    const metrics = createMetrics('detection');
    metrics.record('EndToEndLatency', 10);
    metrics.flush();
    metrics.count('MessagesProcessed');
    metrics.flush();
    expect((lines()[1] as Record<string, unknown>).EndToEndLatency).toBeUndefined();
  });
});
