import { describe, expect, it } from 'vitest';
import { createStrategyRegistry } from './registry.js';

interface Greeter {
  readonly name: string;
  greet(): string;
}

interface GreeterConfig {
  subject: string;
}

function makeRegistry() {
  return createStrategyRegistry<Greeter, GreeterConfig>('greeter');
}

describe('createStrategyRegistry', () => {
  it('builds a registered strategy with the config it is given', () => {
    const registry = makeRegistry();
    registry.register('baseline', (config) => ({
      name: 'baseline',
      greet: () => `hello ${config.subject}`,
    }));

    expect(registry.create('baseline', { subject: 'press-01' }).greet()).toBe('hello press-01');
  });

  it('names the registered strategies when asked for an unknown one', () => {
    const registry = makeRegistry();
    registry.register('baseline', () => ({ name: 'baseline', greet: () => '' }));

    expect(() => registry.create('spectral', { subject: '' })).toThrow(
      'unknown greeter strategy "spectral", registered: baseline',
    );
  });

  it('reports that nothing is registered rather than naming an empty list', () => {
    expect(() => makeRegistry().create('baseline', { subject: '' })).toThrow('registered: none');
  });

  it('refuses to register the same name twice', () => {
    const registry = makeRegistry();
    registry.register('baseline', () => ({ name: 'baseline', greet: () => '' }));

    expect(() => registry.register('baseline', () => ({ name: 'baseline', greet: () => '' }))).toThrow(
      'greeter strategy "baseline" is already registered',
    );
  });

  it('builds a fresh instance per create so gateways do not share filter state', () => {
    const registry = makeRegistry();
    registry.register('baseline', (config) => ({
      name: 'baseline',
      greet: () => config.subject,
    }));

    const first = registry.create('baseline', { subject: 'a' });
    const second = registry.create('baseline', { subject: 'b' });

    expect(first).not.toBe(second);
    expect([first.greet(), second.greet()]).toEqual(['a', 'b']);
  });
});
