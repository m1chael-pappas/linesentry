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

/**
 * Window storage.
 *
 * `range` returns points for one machine and sensor with `window_start`
 * inclusive of both bounds, ascending.
 */
export interface TimeSeriesStore {
  put(window: ForwardedWindow): Promise<void>;
  range(machineId: string, sensorType: SensorType, from: number, to: number): Promise<TimeSeriesPoint[]>;
}

/**
 * Event storage.
 *
 * `putIfAbsent` returns false when `event_id` already exists and must be a
 * single conditional write rather than a read followed by a write. `recent`
 * returns newest first. `acknowledge` sets `status` to `acked` and returns the
 * updated event, or undefined when the id does not exist. See ../QUEUES.md.
 */
export interface EventStore {
  putIfAbsent(event: DetectionEvent): Promise<boolean>;
  get(eventId: string): Promise<DetectionEvent | undefined>;
  recent(limit: number): Promise<DetectionEvent[]>;
  acknowledge(eventId: string): Promise<DetectionEvent | undefined>;
}

/**
 * Work order storage.
 *
 * `putIfAbsent` returns false when `work_order_id` already exists and must be
 * a single conditional write. See ../QUEUES.md.
 */
export interface WorkOrderStore {
  putIfAbsent(workOrder: WorkOrder): Promise<boolean>;
  list(limit: number): Promise<WorkOrder[]>;
}

/** Per-machine baseline and threshold storage, keyed by `machine_id`. */
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
 * Returns a `MetadataStore` that caches `get` results, including misses, for
 * `ttlMs`.
 *
 * The cache is per process and unbounded. `put` writes through and evicts that
 * machine's entry. `list` is not cached.
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
 * Alert episode storage, keyed by `alertKey` or `machineAlertKey`.
 *
 * `claim` returns true and records `rank`, `eventId` and an expiry of
 * `Date.now() + ttlMs` when any of these hold: no entry exists, the existing
 * entry has expired, `rank` exceeds the stored rank, or `eventId` equals the
 * stored event id. Otherwise it returns false and writes nothing.
 *
 * Must be a single conditional write rather than a read followed by a write.
 * See ../DETECTION.md.
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
 * Returns `<machineId>#__machine__`, the episode key covering a whole machine
 * rather than one of its sensors.
 *
 * Distinct from every `alertKey` value, since `__machine__` is not a
 * `SensorType`. See ../DETECTION.md.
 */
export function machineAlertKey(machineId: string): string {
  return `${machineId}#__machine__`;
}

/**
 * Returns an in-process `AlertStateStore`.
 *
 * `now` supplies the clock, so a replay can drive episodes from simulated
 * time. Unbounded and per process. Grants a claim under the same four
 * conditions as the DynamoDB adapter. See ../DETECTION.md.
 */
export function createMemoryAlertStateStore(now: () => number = Date.now): AlertStateStore {
  const entries = new Map<string, AlertState>();

  return {
    async claim(key, rank, eventId, ttlMs) {
      const at = now();
      const held = entries.get(key);
      const granted =
        held === undefined || held.expires_at < at || held.rank < rank || held.event_id === eventId;

      if (!granted) return false;

      entries.set(key, { alert_key: key, rank, event_id: eventId, expires_at: at + ttlMs });
      return true;
    },

    async get(key) {
      return entries.get(key);
    },
  };
}
