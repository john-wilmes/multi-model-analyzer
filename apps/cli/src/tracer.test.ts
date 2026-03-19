import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineTracer } from "./tracer.js";

describe("PipelineTracer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a single phase with timing", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Phase 1");
    vi.advanceTimersByTime(100);
    tracer.endPhase();

    const trace = tracer.finalize();
    expect(trace.phases).toHaveLength(1);
    expect(trace.phases[0]!.name).toBe("Phase 1");
    expect(trace.phases[0]!.durationMs).toBe(100);
  });

  it("records metrics within a phase", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Parse");
    tracer.record("files", 42);
    tracer.record("symbols", 128);
    tracer.record("repo", "novu-api");
    vi.advanceTimersByTime(50);
    tracer.endPhase();

    const trace = tracer.finalize();
    expect(trace.phases[0]!.metrics).toEqual({
      files: 42,
      symbols: 128,
      repo: "novu-api",
    });
  });

  it("records repo association", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Phase 5", "novu-api");
    vi.advanceTimersByTime(10);
    tracer.endPhase();

    const trace = tracer.finalize();
    expect(trace.phases[0]!.repo).toBe("novu-api");
  });

  it("auto-ends previous phase when starting new one", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Phase 1");
    vi.advanceTimersByTime(50);
    tracer.startPhase("Phase 2");
    vi.advanceTimersByTime(30);
    tracer.endPhase();

    const trace = tracer.finalize();
    expect(trace.phases).toHaveLength(2);
    expect(trace.phases[0]!.name).toBe("Phase 1");
    expect(trace.phases[0]!.durationMs).toBe(50);
    expect(trace.phases[1]!.name).toBe("Phase 2");
    expect(trace.phases[1]!.durationMs).toBe(30);
  });

  it("finalize auto-ends active phase", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Phase 1");
    vi.advanceTimersByTime(100);

    const trace = tracer.finalize();
    expect(trace.phases).toHaveLength(1);
    expect(trace.phases[0]!.durationMs).toBe(100);
  });

  it("computes total duration", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Phase 1");
    vi.advanceTimersByTime(100);
    tracer.endPhase();
    vi.advanceTimersByTime(50); // gap between phases
    tracer.startPhase("Phase 2");
    vi.advanceTimersByTime(200);
    tracer.endPhase();

    const trace = tracer.finalize();
    expect(trace.totalDurationMs).toBe(350);
  });

  it("records error on phase", () => {
    const tracer = new PipelineTracer();
    tracer.startPhase("Parse");
    vi.advanceTimersByTime(10);
    tracer.endPhase("WASM init failed");

    const trace = tracer.finalize();
    expect(trace.phases[0]!.error).toBe("WASM init failed");
  });

  it("returns undefined when ending with no active phase", () => {
    const tracer = new PipelineTracer();
    expect(tracer.endPhase()).toBeUndefined();
  });

  it("records timestamps in ISO format", () => {
    const tracer = new PipelineTracer();
    vi.advanceTimersByTime(100);
    const trace = tracer.finalize();

    expect(trace.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(trace.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("formatSummary produces readable output", () => {
    const tracer = new PipelineTracer();

    tracer.startPhase("Ingestion", "repo-a");
    tracer.record("files", 100);
    vi.advanceTimersByTime(200);
    tracer.endPhase();

    tracer.startPhase("Parsing", "repo-a");
    tracer.record("symbols", 500);
    vi.advanceTimersByTime(300);
    tracer.endPhase();

    const trace = tracer.finalize();
    const summary = PipelineTracer.formatSummary(trace);

    expect(summary).toContain("Pipeline completed in");
    expect(summary).toContain("Ingestion");
    expect(summary).toContain("Parsing");
    expect(summary).toContain("files=100");
    expect(summary).toContain("symbols=500");
    expect(summary).toContain("repo-a");
  });

  it("formatSummary aggregates by phase name", () => {
    const tracer = new PipelineTracer();

    tracer.startPhase("Parse", "repo-a");
    vi.advanceTimersByTime(100);
    tracer.endPhase();

    tracer.startPhase("Parse", "repo-b");
    vi.advanceTimersByTime(150);
    tracer.endPhase();

    const trace = tracer.finalize();
    const summary = PipelineTracer.formatSummary(trace);

    expect(summary).toContain("Aggregated by phase:");
    expect(summary).toContain("250ms");
  });

  it("ignores record() when no phase is active", () => {
    const tracer = new PipelineTracer();
    tracer.record("orphan", 42); // should not throw
    const trace = tracer.finalize();
    expect(trace.phases).toHaveLength(0);
  });
});
