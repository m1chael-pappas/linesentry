import {
  eventId,
  type DetectionEvent,
  type DetectionFinding,
  type EventType,
  type ForwardedWindow,
  type Severity,
} from '@linesentry/core';

const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

/** Event types in descending precedence order. */
const TYPE_PRECEDENCE: readonly EventType[] = ['threshold-breach', 'predicted-failure', 'anomaly'];

function highestSeverity(findings: readonly DetectionFinding[]): Severity {
  return findings.reduce<Severity>(
    (worst, finding) => (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worst] ? finding.severity : worst),
    'low',
  );
}

function leadingType(findings: readonly DetectionFinding[]): EventType {
  const found = TYPE_PRECEDENCE.find((type) => findings.some((finding) => finding.type === type));
  return found ?? 'anomaly';
}

/**
 * Folds the findings for one window into one event, or null when `findings` is
 * empty.
 *
 * Pure. `type` is the highest-precedence type present, `severity` the highest
 * present, and `reason` the findings' reasons joined by `; `. `status` is
 * always `open`. See ../../packages/core/DETECTION.md.
 */
export function buildEvent(
  window: ForwardedWindow,
  findings: readonly DetectionFinding[],
  detectedTs: number,
): DetectionEvent | null {
  if (findings.length === 0) return null;

  return {
    event_id: eventId(window.machine_id, window.sensor_type, window.window_start),
    site_id: window.site_id,
    line_id: window.line_id,
    machine_id: window.machine_id,
    sensor_type: window.sensor_type,
    type: leadingType(findings),
    severity: highestSeverity(findings),
    detected_at: new Date(detectedTs).toISOString(),
    reason: findings.map((finding) => finding.reason).join('; '),
    status: 'open',
    window_start: window.window_start,
    edge_ts: window.edge_ts,
    ingest_ts: window.ingest_ts,
    detected_ts: detectedTs,
  };
}

const TYPE_RANK: Record<EventType, number> = {
  anomaly: 0,
  'predicted-failure': 1,
  'threshold-breach': 2,
};

/**
 * Returns `typeRank * 10 + severityRank`, so type dominates severity.
 *
 * Pure. Range 0 to 22. See ../../packages/core/DETECTION.md.
 */
export function eventRank(event: DetectionEvent): number {
  return TYPE_RANK[event.type] * 10 + SEVERITY_ORDER[event.severity];
}
