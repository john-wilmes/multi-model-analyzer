/**
 * Tests for watch mode: interval parsing and the watch loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseWatchInterval, watchLoop } from "./watch.js";
import type { IndexOptions, IndexResult } from "./commands/index-cmd.js";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubOpts(): IndexOptions {
  return {
    repos: [],
    mirrorDir: "/tmp/mirrors",
    kvStore: {} as KVStore,
    graphStore: {} as GraphStore,
    searchStore: {} as SearchStore,
    verbose: false,
    rules: [],
  };
}

function makeResult(hadChanges: boolean): IndexResult {
  return {
    hadChanges,
    repoCount: 1,
    totalFiles: 10,
    totalSarifResults: 0,
    failedRepos: 0,
  };
}

// ---------------------------------------------------------------------------
// parseWatchInterval
// ---------------------------------------------------------------------------

describe("parseWatchInterval", () => {
  it("parses a valid integer string", () => {
    expect(parseWatchInterval("60")).toBe(60_000);
  });

  it("defaults to 30s when undefined", () => {
    expect(parseWatchInterval(undefined)).toBe(30_000);
  });

  it("throws on non-numeric string", () => {
    expect(() => parseWatchInterval("abc")).toThrow("Invalid --watch-interval");
  });

  it("throws on zero", () => {
    expect(() => parseWatchInterval("0")).toThrow("Invalid --watch-interval");
  });

  it("throws on negative number", () => {
    expect(() => parseWatchInterval("-5")).toThrow("Invalid --watch-interval");
  });

  it("parses '1' as 1000ms", () => {
    expect(parseWatchInterval("1")).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// watchLoop
// ---------------------------------------------------------------------------

describe("watchLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one cycle then stops via AbortController", async () => {
    const ac = new AbortController();
    const logs: string[] = [];
    const runIndex = vi.fn<(opts: IndexOptions) => Promise<IndexResult>>()
      .mockImplementation(async () => {
        // Stop after first cycle completes
        ac.abort();
        return makeResult(true);
      });

    const promise = watchLoop({
      indexOpts: makeStubOpts(),
      intervalSeconds: 10,
      runIndex,
      log: (msg) => logs.push(msg),
      signal: ac.signal,
    });

    // Let microtasks resolve
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result.cycles).toBe(1);
    expect(result.cyclesWithChanges).toBe(1);
    expect(runIndex).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatch(/Watching repos/);
    expect(logs.some((l) => l.includes("Re-indexed with changes"))).toBe(true);
    expect(logs[logs.length - 1]).toBe("Watch mode stopped.");
  });

  it("returns immediately if signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const runIndex = vi.fn<(opts: IndexOptions) => Promise<IndexResult>>();

    const result = await watchLoop({
      indexOpts: makeStubOpts(),
      intervalSeconds: 10,
      runIndex,
      log: () => {},
      signal: ac.signal,
    });

    expect(result.cycles).toBe(0);
    expect(runIndex).not.toHaveBeenCalled();
  });

  it("logs 'No changes detected' when hadChanges is false", async () => {
    const ac = new AbortController();
    const logs: string[] = [];
    const runIndex = vi.fn<(opts: IndexOptions) => Promise<IndexResult>>()
      .mockImplementation(async () => {
        ac.abort();
        return makeResult(false);
      });

    const promise = watchLoop({
      indexOpts: makeStubOpts(),
      intervalSeconds: 10,
      runIndex,
      log: (msg) => logs.push(msg),
      signal: ac.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result.cycles).toBe(1);
    expect(result.cyclesWithChanges).toBe(0);
    expect(logs.some((l) => l.includes("No changes detected"))).toBe(true);
  });

  it("runs multiple cycles before stopping", async () => {
    const ac = new AbortController();
    let callCount = 0;
    const runIndex = vi.fn<(opts: IndexOptions) => Promise<IndexResult>>()
      .mockImplementation(async () => {
        callCount++;
        if (callCount >= 3) ac.abort();
        return makeResult(callCount === 2);
      });

    const promise = watchLoop({
      indexOpts: makeStubOpts(),
      intervalSeconds: 5,
      runIndex,
      log: () => {},
      signal: ac.signal,
    });

    // Cycle 1: runIndex completes, then sleeps 5s
    await vi.advanceTimersByTimeAsync(0);
    // Advance past the sleep to trigger cycle 2
    await vi.advanceTimersByTimeAsync(5_000);
    // Cycle 2: runIndex completes, then sleeps 5s
    await vi.advanceTimersByTimeAsync(5_000);
    // Cycle 3: runIndex aborts after call

    const result = await promise;

    expect(result.cycles).toBe(3);
    expect(result.cyclesWithChanges).toBe(1); // only cycle 2
    expect(runIndex).toHaveBeenCalledTimes(3);
  });

  it("abort during sleep exits without extra cycle", async () => {
    const ac = new AbortController();
    const runIndex = vi.fn<(opts: IndexOptions) => Promise<IndexResult>>()
      .mockResolvedValue(makeResult(false));

    const promise = watchLoop({
      indexOpts: makeStubOpts(),
      intervalSeconds: 60,
      runIndex,
      log: () => {},
      signal: ac.signal,
    });

    // Let first cycle complete and enter sleep
    await vi.advanceTimersByTimeAsync(0);
    expect(runIndex).toHaveBeenCalledTimes(1);

    // Abort during the sleep
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.cycles).toBe(1);
    expect(runIndex).toHaveBeenCalledTimes(1); // no extra cycle
  });

  it("throws if intervalSeconds is zero", async () => {
    await expect(
      watchLoop({
        indexOpts: makeStubOpts(),
        intervalSeconds: 0,
        runIndex: vi.fn(),
        log: () => {},
      }),
    ).rejects.toThrow("intervalSeconds must be positive");
  });

  it("throws if intervalSeconds is negative", async () => {
    await expect(
      watchLoop({
        indexOpts: makeStubOpts(),
        intervalSeconds: -1,
        runIndex: vi.fn(),
        log: () => {},
      }),
    ).rejects.toThrow("intervalSeconds must be positive");
  });

  it("passes indexOpts through to runIndex", async () => {
    const ac = new AbortController();
    const opts = makeStubOpts();
    const runIndex = vi.fn<(opts: IndexOptions) => Promise<IndexResult>>()
      .mockImplementation(async (received) => {
        expect(received).toBe(opts);
        ac.abort();
        return makeResult(false);
      });

    const promise = watchLoop({
      indexOpts: opts,
      intervalSeconds: 10,
      runIndex,
      log: () => {},
      signal: ac.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(runIndex).toHaveBeenCalledWith(opts);
  });
});
