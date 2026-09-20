import {
  eventId,
  type DetectionEvent,
  type DetectionFinding,
  type EventType,
  type ForwardedWindow,
  type Severity,
} from '@linesentry/core';

const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

/**
 * Event types in the order they take precedence.
 *
 * A safety threshold breach outranks the others because it is the one the
 * alerting service turns into a shutdown rather than a beacon.
 */
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
 * Folds every finding about one window into the single event that window gets.
 *
 * One window produces at most one event, because the event id is derived from
 * the machine, the sensor and the window start and nothing else. Several rules
 * firing on the same window is normal rather than exceptional, since an
 * overheating machine breaches its safety limit and looks statistically odd at
 * the same time, and that has to read as one fault needing one technician.
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
 * How serious an event is, as one number.
 *
 * Used to decide whether an event escalates a running alert episode or is
 * another report of a fault already being handled. Type dominates severity, so
 * a threshold breach always outranks an anomaly however severe the anomaly
 * looked, because the breach is what stops the machine.
 */
export function eventRank(event: DetectionEvent): number {
  return TYPE_RANK[event.type] * 10 + SEVERITY_ORDER[event.severity];
}
