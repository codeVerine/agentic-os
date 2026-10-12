import { constants } from "node:os";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/**
 * Runs `cleanup` once when the process exits, including when it is ended by SIGHUP (terminal closed),
 * SIGINT or SIGTERM, which Node would otherwise let kill it without running anything.
 * Returns a function that runs `cleanup` now and detaches the handlers.
 */
export function cleanupOnExit(cleanup: () => void): () => void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    cleanup();
  };
  const handlers = TERMINATION_SIGNALS.map((signal) => {
    const handler = (): void => process.exit(128 + constants.signals[signal]);
    process.once(signal, handler);
    return { signal, handler };
  });
  process.once("exit", run);
  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
    process.off("exit", run);
    run();
  };
}
