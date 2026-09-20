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

/** `reason` and `ext` are set only when `forward` is true. */
export interface EdgeFilterDecision {
  forward: boolean;
  reason?: ForwardReason;
  ext?: WindowExtension;
}

/**
 * Decides which aggregated windows leave the gateway.
 *
 * Stateful. One instance is built per gateway and keeps its state across
 * calls. See ../STRATEGIES.md.
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

/** `history` is ordered by `window_start` ascending and includes the window being judged. */
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
 * Judges one window against a machine's baseline and recent history.
 *
 * `evaluate` is pure: no stored state, no IO, no mutation of its arguments.
 * Returns zero or more findings. See ../STRATEGIES.md.
 */
export interface DetectionStrategy {
  readonly name: string;
  evaluate(window: ForwardedWindow, context: DetectionContext): readonly DetectionFinding[];
}

/** `historyWindows` is both the trend sample count and the minimum required to predict. */
export interface DetectionConfig {
  zScoreSigma: number;
  historyWindows: number;
  rulHorizonMs: number;
}

/** Edge filter registry, keyed by the `EDGE_FILTER_STRATEGY` config value. */
export const edgeFilterRegistry = createStrategyRegistry<EdgeFilterStrategy, EdgeFilterConfig>(
  'edge filter',
);

/** Detection registry, keyed by the `DETECTION_STRATEGY` config value. */
export const detectionRegistry = createStrategyRegistry<DetectionStrategy, DetectionConfig>(
  'detection',
);
