/**
 * Pipeline tracing utilities.
 * Wraps pipeline phases with structured timing and logging.
 */

export interface PhaseResult<T> {
  readonly name: string;
  readonly durationMs: number;
  readonly result: T;
}

/**
 * Trace execution of a synchronous pipeline phase.
 * Returns the result along with timing information.
 */
export function traceSync<T>(name: string, fn: () => T): PhaseResult<T> {
  const startTime = performance.now();
  const result = fn();
  const endTime = performance.now();
  return {
    name,
    durationMs: Math.round((endTime - startTime) * 100) / 100,
    result,
  };
}

/**
 * Trace execution of an async pipeline phase.
 * Returns the result along with timing information.
 */
export async function traceAsync<T>(name: string, fn: () => Promise<T>): Promise<PhaseResult<T>> {
  const startTime = performance.now();
  const result = await fn();
  const endTime = performance.now();
  return {
    name,
    durationMs: Math.round((endTime - startTime) * 100) / 100,
    result,
  };
}

import type { HeuristicMeta, HeuristicResult } from "./types.js";

/**
 * Run a heuristic function with timing and metadata collection.
 * Wraps traceSync internally — no duplication of timing logic.
 */
export function runHeuristic<T>(
  repo: string,
  heuristic: string,
  fn: () => T,
  extractItems: (data: T) => readonly { confidence?: number }[],
): HeuristicResult<T> {
  const phase = traceSync(heuristic, fn);
  const items = extractItems(phase.result);
  const itemCount = items.length;

  let confidenceStats: HeuristicMeta["confidenceStats"];
  if (itemCount > 0) {
    const confidences = items
      .map((item) => item.confidence)
      .filter((c): c is number => c !== undefined);
    if (confidences.length > 0) {
      const min = Math.min(...confidences);
      const max = Math.max(...confidences);
      const mean = Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100;
      confidenceStats = { min, max, mean };
    }
  }

  return {
    data: phase.result,
    meta: {
      repo,
      heuristic,
      durationMs: phase.durationMs,
      itemCount,
      confidenceStats,
    },
  };
}
