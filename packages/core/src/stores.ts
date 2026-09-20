import type {
  DetectionEvent,
  ForwardedWindow,
  MachineMetadata,
  SensorType,
  WorkOrder,
} from './contracts.js';

/** One stored window of readings. */
export interface TimeSeriesPoint {
  machine_id: string;
  sensor_type: SensorType;
  window_start: number;
  mean: number;
  min: number;
  max: number;
  rms: number;
  smoothed: number;
  count: number;
  unit: string;
}

/** Where aggregated windows are kept for the api's time-series endpoint. */
export interface TimeSeriesStore {
  put(window: ForwardedWindow): Promise<void>;
  range(machineId: string, sensorType: SensorType, from: number, to: number): Promise<TimeSeriesPoint[]>;
}

/**
 * Where detection events are kept.
 *
 * `putIfAbsent` is the idempotency guarantee for the whole pipeline. It
 * returns false when an event with that id already exists, which is how a
 * redelivered window is told apart from a new one. Implementations must do
 * this as one conditional write, not a read followed by a write, because
 * several detection tasks can be judging the same window at the same time.
 */
export interface EventStore {
  putIfAbsent(event: DetectionEvent): Promise<boolean>;
  get(eventId: string): Promise<DetectionEvent | undefined>;
  recent(limit: number): Promise<DetectionEvent[]>;
  acknowledge(eventId: string): Promise<DetectionEvent | undefined>;
}

/** Where maintenance jobs are kept. Idempotent for the same reason as events. */
export interface WorkOrderStore {
  putIfAbsent(workOrder: WorkOrder): Promise<boolean>;
  list(limit: number): Promise<WorkOrder[]>;
}

/** Where per-machine baselines and safety limits are kept. */
export interface MetadataStore {
  get(machineId: string): Promise<MachineMetadata | undefined>;
  put(metadata: MachineMetadata): Promise<void>;
  list(): Promise<MachineMetadata[]>;
}

/** One entry in a time-to-live cache. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Wraps a metadata store with a per-task cache.
 *
 * Every window needs its machine's baseline, so an uncached store would mean
 * one read per window per task. The entries are small and change rarely, and a
 * stale baseline for up to the TTL changes a z-score slightly rather than
 * breaking anything.
 */
export function cacheMetadata(store: MetadataStore, ttlMs: number): MetadataStore {
  const cache = new Map<string, CacheEntry<MachineMetadata | undefined>>();

  return {
    async get(machineId) {
      const now = Date.now();
      const hit = cache.get(machineId);
      if (hit && hit.expiresAt > now) return hit.value;

      const value = await store.get(machineId);
      cache.set(machineId, { value, expiresAt: now + ttlMs });
      return value;
    },

    async put(metadata) {
      await store.put(metadata);
      cache.delete(metadata.machine_id);
    },

    list: () => store.list(),
  };
}

/** The live alert for one machine and sensor, if there is one. */
export interface AlertState {
  alert_key: string;
  rank: number;
  event_id: string;
  expires_at: number;
}

/**
 * Tracks which machine and sensor pairs already have an alert running.
 *
 * A fault lasts many windows, and without this every window of one fault
 * raises its own event and opens its own work order. `claim` returns true only
 * when the caller's event opens a new episode or escalates the running one,
 * which is what keeps a sustained fault to one event per escalation step
 * rather than one per window.
 *
 * Escalation matters more than deduplication here. Suppressing everything
 * after the first event would also suppress the safety threshold breach that
 * stops the machine, so the rank has to be able to rise.
 *
 * Implementations must do this as one conditional write. Several detection
 * tasks judge windows from the same machine at the same time, so a read
 * followed by a write would let two of them both believe they opened the
 * episode.
 *
 * The same event id re-claiming its own episode always succeeds, so a task
 * that claimed and then died before publishing can retry rather than having
 * locked itself out of an event it never delivered.
 */
export interface AlertStateStore {
  claim(key: string, rank: number, eventId: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<AlertState | undefined>;
}

/** The key an alert episode is tracked under. */
export function alertKey(machineId: string, sensorType: string): string {
  return `${machineId}#${sensorType}`;
}

/**
 * The key recording that a whole machine has been ordered to stop.
 *
 * A commanded shutdown looks exactly like a catastrophic rpm collapse in the
 * signal, because it is one, so no rule reading the readings alone can tell
 * the two apart. Only the decision to stop the machine carries that, and this
 * is where that decision is written down for the rest of the pipeline.
 */
export function machineAlertKey(machineId: string): string {
  return `${machineId}#__machine__`;
}
