import type {
  EventType,
  ForwardReason,
  ForwardedWindow,
  MachineMetadata,
  SensorType,
  Severity,
  WindowExtension,
} from './contracts.js';
import { createStrategyRegistry } from './registry.js';

/** Whether the gateway sends this window on, and anything it wants to attach. */
export interface EdgeFilterDecision {
  forward: boolean;
  reason?: ForwardReason;
  ext?: WindowExtension;
}

/**
 * Decides which aggregated windows leave the gateway.
 *
 * The baseline registers a deadband with a heartbeat. A variant may drop or
 * rewrite that rule entirely, so implementations hold their own state and are
 * built once per gateway from config.
 */
export interface EdgeFilterStrategy {
  readonly name: string;
  decide(window: ForwardedWindow, now: number): EdgeFilterDecision;
}

/** Deadband widths and heartbeat interval used by the baseline edge filter. */
export interface EdgeFilterConfig {
  deadband: Record<SensorType, number>;
  heartbeatMs: number;
}

/** Everything the detection strategy may read about a window's machine. */
export interface DetectionContext {
  metadata: MachineMetadata;
  history: readonly ForwardedWindow[];
}

/** One reason a window looks wrong, before it becomes an event. */
export interface DetectionFinding {
  type: EventType;
  severity: Severity;
  reason: string;
}

/**
 * Judges a single window against a machine's baseline and recent history.
 *
 * Implementations are pure. The detection service owns event identity,
 * deduplication and persistence, so a strategy never learns whether the window
 * it was handed is a first delivery, a redelivery or a reconstruction.
 */
export interface DetectionStrategy {
  readonly name: string;
  evaluate(window: ForwardedWindow, context: DetectionContext): readonly DetectionFinding[];
}

/** Sigma count, trend sample count and prediction horizon for detection. */
export interface DetectionConfig {
  zScoreSigma: number;
  historyWindows: number;
  rulHorizonMs: number;
}

/** Edge filter implementations, keyed by the name given in gateway config. */
export const edgeFilterRegistry = createStrategyRegistry<EdgeFilterStrategy, EdgeFilterConfig>(
  'edge filter',
);

/** Detection implementations, keyed by the name given in service config. */
export const detectionRegistry = createStrategyRegistry<DetectionStrategy, DetectionConfig>(
  'detection',
);
