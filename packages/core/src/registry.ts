/** Builds a strategy instance from the configuration read at startup. */
export type StrategyFactory<TStrategy, TConfig> = (config: TConfig) => TStrategy;

/** Named strategy implementations of one kind, selected by config at startup. */
export interface StrategyRegistry<TStrategy, TConfig> {
  register(name: string, factory: StrategyFactory<TStrategy, TConfig>): void;
  create(name: string, config: TConfig): TStrategy;
  names(): readonly string[];
}

/**
 * Creates an empty registry.
 *
 * `kind` appears in the error messages only. `register` throws on a duplicate
 * name. `create` throws on an unknown name, listing the registered names, and
 * returns a fresh instance per call. See ../STRATEGIES.md.
 */
export function createStrategyRegistry<TStrategy, TConfig>(
  kind: string,
): StrategyRegistry<TStrategy, TConfig> {
  const factories = new Map<string, StrategyFactory<TStrategy, TConfig>>();

  return {
    register(name, factory) {
      if (factories.has(name)) {
        throw new Error(`${kind} strategy "${name}" is already registered`);
      }
      factories.set(name, factory);
    },

    create(name, config) {
      const factory = factories.get(name);
      if (!factory) {
        const known = [...factories.keys()].join(', ') || 'none';
        throw new Error(`unknown ${kind} strategy "${name}", registered: ${known}`);
      }
      return factory(config);
    },

    names() {
      return [...factories.keys()];
    },
  };
}
