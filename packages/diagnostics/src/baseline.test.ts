import { describe, it, expect } from "vitest";
import { computeBaseline } from "./baseline.js";
import type { SarifResult } from "@mma/core";

function makeResult(
  ruleId: string,
  fqn: string,
  level: "error" | "warning" = "warning",
  text = "violation",
): SarifResult {
  return {
    ruleId,
    level,
    message: { text },
    locations: [{ logicalLocations: [{ fullyQualifiedName: fqn, kind: "module" }] }],
  };
}

describe("computeBaseline", () => {
  it("marks all results as 'new' when baseline is empty", () => {
    const current = [makeResult("r1", "src/a.ts"), makeResult("r2", "src/b.ts")];
    const results = computeBaseline(current, []);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.baselineState === "new")).toBe(true);
  });

  it("marks matching results as 'unchanged'", () => {
    const result = makeResult("r1", "src/a.ts");
    const results = computeBaseline([result], [result]);

    expect(results).toHaveLength(1);
    expect(results[0]!.baselineState).toBe("unchanged");
  });

  it("marks changed level as 'updated'", () => {
    const current = makeResult("r1", "src/a.ts", "error");
    const baseline = makeResult("r1", "src/a.ts", "warning");
    const results = computeBaseline([current], [baseline]);

    expect(results).toHaveLength(1);
    expect(results[0]!.baselineState).toBe("updated");
  });

  it("marks changed message as 'updated'", () => {
    const current = makeResult("r1", "src/a.ts", "warning", "new message");
    const baseline = makeResult("r1", "src/a.ts", "warning", "old message");
    const results = computeBaseline([current], [baseline]);

    expect(results).toHaveLength(1);
    expect(results[0]!.baselineState).toBe("updated");
  });

  it("marks removed results as 'absent'", () => {
    const baseline = [makeResult("r1", "src/a.ts"), makeResult("r2", "src/b.ts")];
    const current = [makeResult("r1", "src/a.ts")];
    const results = computeBaseline(current, baseline);

    expect(results).toHaveLength(2);
    expect(results[0]!.baselineState).toBe("unchanged");
    expect(results[1]!.baselineState).toBe("absent");
    expect(results[1]!.ruleId).toBe("r2");
  });

  it("handles mixed states correctly", () => {
    const baseline = [
      makeResult("r1", "src/a.ts"),           // will be unchanged
      makeResult("r2", "src/b.ts"),           // will be absent
      makeResult("r3", "src/c.ts", "warning"), // will be updated
    ];
    const current = [
      makeResult("r1", "src/a.ts"),           // unchanged
      makeResult("r3", "src/c.ts", "error"),  // updated
      makeResult("r4", "src/d.ts"),           // new
    ];
    const results = computeBaseline(current, baseline);

    expect(results).toHaveLength(4);

    const byRule = new Map(results.map(r => [r.ruleId, r.baselineState]));
    expect(byRule.get("r1")).toBe("unchanged");
    expect(byRule.get("r2")).toBe("absent");
    expect(byRule.get("r3")).toBe("updated");
    expect(byRule.get("r4")).toBe("new");
  });

  it("handles empty current and baseline", () => {
    const results = computeBaseline([], []);
    expect(results).toHaveLength(0);
  });

  it("fingerprints by ruleId + location", () => {
    // Same ruleId, different locations → both "new"
    const current = [makeResult("r1", "src/a.ts"), makeResult("r1", "src/b.ts")];
    const results = computeBaseline(current, []);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.baselineState === "new")).toBe(true);
  });
});
