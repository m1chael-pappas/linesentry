/** Sensors fitted to every simulated machine. */
export type SensorType = 'vibration' | 'temperature' | 'current' | 'rpm';

/** Unit of measure reported alongside each sensor value. */
export type Unit = 'mm/s' | 'C' | 'A' | 'rpm';

/** Faults the simulator can inject, per machine or per line. */
export type FaultType = 'bearing' | 'overheat' | 'overload' | 'dropout';

/**
 * Why the edge gateway chose to forward a window rather than drop it.
 *
 * `changed` is emitted by the deadband filter. `divergence` and `safety` are
 * emitted by the dual prediction filter. No filter emits both `changed` and
 * `divergence`.
 */
export type ForwardReason = 'first' | 'changed' | 'divergence' | 'safety' | 'heartbeat';

/** One sensor sample, published on `<site>/<line>/<machine>/<sensor>`. */
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
 * Open extension map on `ForwardedWindow`.
 *
 * Unset by the baseline pipeline and ignored by every baseline consumer. See
 * ../STRATEGIES.md.
 */
export interface WindowExtension {
  [field: string]: unknown;
}

/**
 * A 10 second aggregate published by the edge gateway.
 *
 * `edge_ts` is stamped at window close by the gateway. `ingest_ts` is stamped
 * by the IoT Core topic rule, or by the ingest bridge locally, and is absent
 * until then.
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
  ingest_ts?: number | undefined;
  ext?: WindowExtension | undefined;
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
 * `event_id` comes from `eventId(machine_id, sensor_type, window_start)`.
 * `edge_ts` and `ingest_ts` are carried from the window it was derived from.
 * `alert_ts` is stamped by the alerting service and absent until then. See
 * ../QUEUES.md.
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
  ingest_ts?: number | undefined;
  detected_ts: number;
  alert_ts?: number | undefined;
}

/** Commands the simulator's actuators accept. */
export type ActuatorCommandName = 'beacon_on' | 'beacon_off' | 'shutdown';

/**
 * A command published to `<site>/<line>/<machine>/actuator`.
 *
 * Only `command` changes machine state. `event_id` and `issued_at` are
 * carried for traceability and ignored by the simulator.
 */
export interface ActuatorCommand {
  command: ActuatorCommandName;
  event_id?: string | undefined;
  issued_at?: number | undefined;
}

/** Progress of the maintenance job opened for an event. */
export type WorkOrderStatus = 'open' | 'in-progress' | 'closed';

/** A maintenance job. `work_order_id` comes from `workOrderId(event_id)`. */
export interface WorkOrder {
  work_order_id: string;
  event_id: string;
  machine_id: string;
  sensor_type: SensorType;
  severity: Severity;
  status: WorkOrderStatus;
  opened_at: string;
  closed_at?: string | undefined;
  reason: string;
}

/** Per-sensor statistics describing what normal looks like for one machine. */
export interface SensorBaseline {
  mean: number;
  sd: number;
}

/**
 * Baselines and safety limits for one machine.
 *
 * Both maps are partial. A sensor absent from `baseline` is not z-scored, and
 * one absent from `thresholds` has no threshold or trend rule applied.
 */
export interface MachineMetadata {
  machine_id: string;
  site_id: string;
  line_id: string;
  baseline: Partial<Record<SensorType, SensorBaseline>>;
  thresholds: Partial<Record<SensorType, number>>;
}
