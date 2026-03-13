/**
 * Pipeline tracing — structured timing and metrics per phase.
 *
 * Records phase start/end times, per-phase metrics, and outputs
 * a structured summary that can be stored in KV or logged.
 */

export interface PhaseRecord {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly metrics: Record<string, number | string>;
  readonly repo?: string;
  readonly error?: string;
}

export interface PipelineTrace {
  readonly phases: readonly PhaseRecord[];
  readonly totalDurationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export class PipelineTracer {
  private readonly phases: PhaseRecord[] = [];
  private activePhase: {
    name: string;
    startMs: number;
    metrics: Record<string, number | string>;
    repo?: string;
  } | null = null;
  private readonly pipelineStart: number;
  private readonly startedAt: string;

  constructor() {
    this.pipelineStart = performance.now();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Begin a named phase. Automatically ends the previous phase if still open.
   */
  startPhase(name: string, repo?: string): void {
    if (this.activePhase) {
      this.endPhase();
    }
    this.activePhase = {
      name,
      startMs: performance.now(),
      metrics: {},
      repo,
    };
  }

  /**
   * Record a metric for the current phase.
   */
  record(key: string, value: number | string): void {
    if (this.activePhase) {
      this.activePhase.metrics[key] = value;
    }
  }

  /**
   * End the current phase, recording its duration.
   */
  endPhase(error?: string): PhaseRecord | undefined {
    if (!this.activePhase) return undefined;

    const endMs = performance.now();
    const record: PhaseRecord = {
      name: this.activePhase.name,
      startMs: this.activePhase.startMs - this.pipelineStart,
      endMs: endMs - this.pipelineStart,
      durationMs: Math.round(endMs - this.activePhase.startMs),
      metrics: { ...this.activePhase.metrics },
      repo: this.activePhase.repo,
      error,
    };
    this.phases.push(record);
    this.activePhase = null;
    return record;
  }

  /**
   * Finalize the trace and return the full pipeline summary.
   */
  finalize(): PipelineTrace {
    if (this.activePhase) {
      this.endPhase();
    }
    const totalDurationMs = Math.round(performance.now() - this.pipelineStart);
    return {
      phases: [...this.phases],
      totalDurationMs,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Format the trace as a human-readable summary table.
   */
  static formatSummary(trace: PipelineTrace): string {
    const lines: string[] = [];
    lines.push(`Pipeline completed in ${trace.totalDurationMs}ms`);
    lines.push(`  Started:   ${trace.startedAt}`);
    lines.push(`  Completed: ${trace.completedAt}`);
    lines.push("");
    lines.push("  Phase                           Repo            Duration  Metrics");
    lines.push("  " + "-".repeat(80));

    for (const phase of trace.phases) {
      const repo = phase.repo ?? "(all)";
      const metricsStr = Object.entries(phase.metrics)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      const errorTag = phase.error ? " [ERROR]" : "";
      lines.push(
        `  ${phase.name.padEnd(32)} ${repo.padEnd(16)} ${String(phase.durationMs).padStart(6)}ms  ${metricsStr}${errorTag}`,
      );
    }

    // Aggregate by phase name (across repos)
    const byPhase = new Map<string, number>();
    for (const phase of trace.phases) {
      const base = phase.name.replace(/\s*\[.*\]$/, "");
      byPhase.set(base, (byPhase.get(base) ?? 0) + phase.durationMs);
    }

    if (trace.phases.length > byPhase.size) {
      lines.push("");
      lines.push("  Aggregated by phase:");
      for (const [name, ms] of byPhase) {
        const pct = ((ms / trace.totalDurationMs) * 100).toFixed(1);
        lines.push(`    ${name.padEnd(32)} ${String(ms).padStart(6)}ms  (${pct}%)`);
      }
    }

    return lines.join("\n");
  }
}
