/** Sensors fitted to every simulated machine. */
export type SensorType = 'vibration' | 'temperature' | 'current' | 'rpm';

/** Unit of measure reported alongside each sensor value. */
export type Unit = 'mm/s' | 'C' | 'A' | 'rpm';

/** Faults the simulator can inject, per machine or per line. */
export type FaultType = 'bearing' | 'overheat' | 'overload' | 'dropout';

/** Why the edge gateway chose to forward a window rather than drop it. */
export type ForwardReason = 'first' | 'changed' | 'heartbeat';

/** A single sensor sample published by the simulator once per second. */
export interface RawReading {
  ts: number;
  site_id: string;
  line_id: string;
  machine_id: string;
  sensor_type: SensorType;
  value: number;
  unit: Unit;
  seq: number;
}

/**
 * Fields a pipeline variant may attach to a forwarded window without the
 * baseline consumer needing to understand them. The baseline never sets this.
 * See ../STRATEGIES.md.
 */
export interface WindowExtension {
  [field: string]: unknown;
}

/**
 * A 10 second aggregate published by the edge gateway to the cloud.
 *
 * The four latency timestamps travel with the window through the whole
 * pipeline: edge_ts is stamped here, ingest_ts by the IoT Core topic rule,
 * and the remaining two are stamped on the event derived from this window.
 */
export interface ForwardedWindow {
  edge_ts: number;
  window_start: number;
  window_end: number;
  window: string;
  site_id: string;
  line_id: string;
  machine_id: string;
  sensor_type: SensorType;
  unit: Unit;
  count: number;
  mean: number;
  min: number;
  max: number;
  rms: number;
  smoothed: number;
  forward_reason: ForwardReason;
  ingest_ts?: number;
  ext?: WindowExtension;
}

/** Classification of a detection event. */
export type EventType = 'anomaly' | 'threshold-breach' | 'predicted-failure';

/** How urgently an event needs a technician. */
export type Severity = 'low' | 'medium' | 'high';

/** Lifecycle of an event from detection to acknowledgement. */
export type EventStatus = 'open' | 'acked' | 'closed';

/**
 * An event raised by the detection service.
 *
 * event_id is derived deterministically from machine_id, sensor_type and
 * window_start so that a redelivered window produces a colliding id rather
 * than a second event. See ../STRATEGIES.md.
 */
export interface DetectionEvent {
  event_id: string;
  site_id: string;
  line_id: string;
  machine_id: string;
  sensor_type: SensorType;
  type: EventType;
  severity: Severity;
  detected_at: string;
  reason: string;
  status: EventStatus;
  window_start: number;
  edge_ts: number;
  ingest_ts?: number;
  detected_ts: number;
  alert_ts?: number;
}

/** Commands the simulator's actuators accept. */
export type ActuatorCommandName = 'beacon_on' | 'beacon_off' | 'shutdown';

/**
 * A command published back to a machine's actuator topic.
 *
 * Only `command` is acted on. The simulator ignores the two traceability
 * fields, which exist so an actuation can be tied back to the event that
 * caused it when reading an experiment run.
 */
export interface ActuatorCommand {
  command: ActuatorCommandName;
  event_id?: string;
  issued_at?: number;
}

/** Progress of the maintenance job opened for an event. */
export type WorkOrderStatus = 'open' | 'in-progress' | 'closed';

/** A maintenance job opened by the alerting service against an event. */
export interface WorkOrder {
  work_order_id: string;
  event_id: string;
  machine_id: string;
  sensor_type: SensorType;
  severity: Severity;
  status: WorkOrderStatus;
  opened_at: string;
  closed_at?: string;
  reason: string;
}

/** Per-sensor statistics describing what normal looks like for one machine. */
export interface SensorBaseline {
  mean: number;
  sd: number;
}

/** Baselines and fixed safety limits for one machine. */
export interface MachineMetadata {
  machine_id: string;
  site_id: string;
  line_id: string;
  baseline: Partial<Record<SensorType, SensorBaseline>>;
  thresholds: Partial<Record<SensorType, number>>;
}
