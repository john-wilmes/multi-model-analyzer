/**
 * Tests for pipeline tracing utilities.
 */

import { describe, it, expect } from "vitest";
import { traceSync, traceAsync } from "./tracer.js";

describe("traceSync", () => {
  it("returns the function result", () => {
    const traced = traceSync("test", () => 42);

    expect(traced.result).toBe(42);
    expect(traced.name).toBe("test");
  });

  it("returns durationMs as a number", () => {
    const traced = traceSync("phase", () => "hello");

    expect(typeof traced.durationMs).toBe("number");
    expect(traced.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates thrown errors", () => {
    expect(() =>
      traceSync("fail", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});

describe("traceAsync", () => {
  it("returns the async function result", async () => {
    const traced = await traceAsync("async-test", async () => "done");

    expect(traced.result).toBe("done");
    expect(traced.name).toBe("async-test");
  });

  it("returns durationMs as a number", async () => {
    const traced = await traceAsync("async-phase", async () => 123);

    expect(typeof traced.durationMs).toBe("number");
    expect(traced.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates rejected promises", async () => {
    await expect(
      traceAsync("fail", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
  });
});
