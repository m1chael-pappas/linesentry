/** Reads a required environment variable, failing at startup when it is absent. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

/** Reads an environment variable, falling back to the given default. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Reads a numeric environment variable, failing when it is set but unparsable. */
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
 * Runs the handler once on SIGTERM or SIGINT, then exits.
 *
 * Fargate sends SIGTERM before stopping a task, so a consumer uses this to
 * finish the message it holds rather than letting the visibility timeout
 * redeliver work it had already done.
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
