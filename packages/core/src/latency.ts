import type { DetectionEvent, ForwardedWindow } from './contracts.js';

/** Names every stage latency is published under. */
export const LATENCY_METRICS = {
  edgeToIngest: 'EdgeToIngestLatency',
  ingestToDetect: 'IngestToDetectLatency',
  detectToAlert: 'DetectToAlertLatency',
  endToEnd: 'EndToEndLatency',
  windowStored: 'WindowStoredLatency',
} as const;

/** Milliseconds spent in each stage, for stages whose stamps are both present. */
export interface StageLatencies {
  edgeToIngest?: number;
  ingestToDetect?: number;
  detectToAlert?: number;
  endToEnd?: number;
}

function since(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const elapsed = to - from;
  return elapsed >= 0 ? elapsed : undefined;
}

/**
 * Stage latencies for a window that has reached the ingest bridge.
 *
 * Pure. Returns only `edgeToIngest`, and omits it when either stamp is absent
 * or the interval is negative. See ../METRICS.md.
 */
export function windowLatencies(window: ForwardedWindow): StageLatencies {
  const edgeToIngest = since(window.edge_ts, window.ingest_ts);
  return edgeToIngest === undefined ? {} : { edgeToIngest };
}

/**
 * Stage latencies for an event, using `alertTs` as the final stamp when the
 * event does not carry one yet.
 *
 * Pure. Each stage is omitted when either of its stamps is absent or the
 * interval is negative, so a clock that has gone backwards produces a missing
 * sample rather than a negative one. See ../METRICS.md.
 */
export function eventLatencies(event: DetectionEvent, alertTs?: number): StageLatencies {
  const alert = event.alert_ts ?? alertTs;
  const latencies: StageLatencies = {};

  const edgeToIngest = since(event.edge_ts, event.ingest_ts);
  if (edgeToIngest !== undefined) latencies.edgeToIngest = edgeToIngest;

  const ingestToDetect = since(event.ingest_ts, event.detected_ts);
  if (ingestToDetect !== undefined) latencies.ingestToDetect = ingestToDetect;

  const detectToAlert = since(event.detected_ts, alert);
  if (detectToAlert !== undefined) latencies.detectToAlert = detectToAlert;

  const endToEnd = since(event.edge_ts, alert);
  if (endToEnd !== undefined) latencies.endToEnd = endToEnd;

  return latencies;
}
