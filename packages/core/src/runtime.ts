/** Returns the variable, throwing when it is unset or empty. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

/** Returns the variable, or `fallback` when it is unset or empty. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Returns the variable as a number, or `fallback` when unset or empty. Throws when set but not finite. */
export function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`environment variable ${name} must be a number, got "${value}"`);
  }
  return parsed;
}

/**
 * Registers SIGTERM and SIGINT handlers that run `handler` once, then exit.
 *
 * Subsequent signals are ignored while shutting down. Exits 0 once `handler`
 * resolves, or 1 when it rejects.
 */
export function onShutdown(handler: () => Promise<void> | void): void {
  let shuttingDown = false;

  const stop = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    void Promise.resolve(handler())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('shutdown failed', err);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
