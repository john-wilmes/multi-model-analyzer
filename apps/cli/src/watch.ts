/**
 * Watch mode for the indexing pipeline.
 *
 * Polls `indexCommand()` at a configurable interval, logging results
 * and stopping gracefully on SIGINT/SIGTERM.
 */

import type { IndexOptions, IndexResult } from "./commands/index-cmd.js";

export interface WatchOptions {
  /** Indexing options passed through to indexCommand */
  readonly indexOpts: IndexOptions;
  /** Poll interval in seconds (must be > 0) */
  readonly intervalSeconds: number;
  /** The indexing function to call each cycle */
  readonly runIndex: (opts: IndexOptions) => Promise<IndexResult>;
  /** Logger for output (defaults to console.log) */
  readonly log?: (msg: string) => void;
  /** Logger for errors (defaults to console.error) */
  readonly logError?: (msg: string) => void;
  /** Signal to abort externally (e.g. for testing) */
  readonly signal?: AbortSignal;
}

export interface WatchResult {
  /** Number of completed index cycles */
  readonly cycles: number;
  /** Number of cycles that detected changes */
  readonly cyclesWithChanges: number;
}

/**
 * Validate the watch interval string and return milliseconds.
 * Throws if invalid.
 */
export function parseWatchInterval(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "30", 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid --watch-interval: "${raw}". Must be a positive number of seconds.`,
    );
  }
  return parsed * 1000;
}

/**
 * Run the watch loop. Returns when stopped via signal or SIGINT/SIGTERM.
 */
export async function watchLoop(opts: WatchOptions): Promise<WatchResult> {
  const {
    indexOpts,
    intervalSeconds,
    runIndex,
    log = console.log,
    signal,
  } = opts;

  if (intervalSeconds <= 0) {
    throw new Error("intervalSeconds must be positive");
  }

  const intervalMs = intervalSeconds * 1000;
  let running = true;
  let cycles = 0;
  let cyclesWithChanges = 0;

  const stop = () => {
    running = false;
  };

  // Wire up abort signal
  if (signal) {
    if (signal.aborted) return { cycles: 0, cyclesWithChanges: 0 };
    signal.addEventListener("abort", stop, { once: true });
  }

  // Wire up process signals
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log(`Watching repos (interval: ${intervalSeconds}s). Press Ctrl+C to stop.`);

  try {
    while (running) {
      const result = await runIndex(indexOpts);
      cycles++;
      const ts = new Date().toISOString();
      if (result.hadChanges) {
        cyclesWithChanges++;
        log(`[${ts}] Re-indexed with changes.`);
      } else {
        log(`[${ts}] No changes detected.`);
      }
      if (!running) break;

      // Sleep with early-exit support
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        const onStop = () => {
          clearTimeout(timer);
          running = false;
          resolve();
        };
        if (signal) {
          signal.addEventListener("abort", onStop, { once: true });
        }
        process.once("SIGINT", onStop);
        process.once("SIGTERM", onStop);
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }

  log("Watch mode stopped.");
  return { cycles, cyclesWithChanges };
}
