import type { KVStore, GraphStore } from "@mma/storage";

// ─── ValidationReporter ────────────────────────────────────

export interface AssertionResult {
  category: string;
  repo: string;
  label: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export interface ValidateOptions {
  kvStore: KVStore;
  graphStore: GraphStore;
  mirrorsDir?: string;
  sampleSize?: number;
  seed?: number;
  format?: "json" | "table" | "markdown";
  output?: string;
}

export interface ValidateResult {
  summary: { pass: number; fail: number; skip: number; total: number };
  checks: Array<{ rule: string; pass: number; fail: number; skip: number }>;
  failures: Array<{ category: string; repo: string; label: string; detail?: string }>;
}

export class ValidationReporter {
  private results: AssertionResult[] = [];

  record(result: AssertionResult): void {
    this.results.push(result);
  }

  pass(category: string, repo: string, label: string): void {
    this.results.push({ category, repo, label, status: "pass" });
  }

  fail(category: string, repo: string, label: string, detail?: string): void {
    this.results.push({ category, repo, label, status: "fail", detail });
  }

  skip(category: string, repo: string, label: string, detail?: string): void {
    this.results.push({ category, repo, label, status: "skip", detail });
  }

  get counts() {
    const pass = this.results.filter((r) => r.status === "pass").length;
    const fail = this.results.filter((r) => r.status === "fail").length;
    const skip = this.results.filter((r) => r.status === "skip").length;
    return { pass, fail, skip, total: this.results.length };
  }

  get failures(): AssertionResult[] {
    return this.results.filter((r) => r.status === "fail");
  }

  /** Group results by category for the per-rule summary. */
  byCategory(): Map<string, { pass: number; fail: number; skip: number }> {
    const cats = new Map<string, { pass: number; fail: number; skip: number }>();
    for (const r of this.results) {
      let c = cats.get(r.category);
      if (!c) { c = { pass: 0, fail: 0, skip: 0 }; cats.set(r.category, c); }
      c[r.status]++;
    }
    return cats;
  }

  toJSON(): ValidateResult {
    const { pass, fail, skip } = this.counts;
    const checks: ValidateResult["checks"] = [];
    for (const [rule, c] of this.byCategory()) {
      checks.push({ rule, ...c });
    }
    return {
      summary: { pass, fail, skip, total: pass + fail + skip },
      checks,
      failures: this.failures.map((f) => ({
        category: f.category,
        repo: f.repo,
        label: f.label,
        detail: f.detail,
      })),
    };
  }
}
