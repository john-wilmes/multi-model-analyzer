import { describe, it, expect } from "vitest";
import { computeHotspots } from "./hotspots.js";
import type { CommitFileChange } from "./hotspots.js";

function change(hash: string, filePath: string): CommitFileChange {
  return { hash, filePath };
}

describe("computeHotspots", () => {
  it("returns empty hotspots for empty input", () => {
    const result = computeHotspots([], new Map());
    expect(result.hotspots).toHaveLength(0);
    expect(result.maxChurn).toBe(0);
    expect(result.maxSymbolCount).toBe(0);
  });

  it("scores a single file with churn and symbols correctly", () => {
    const fileChanges = [
      change("c1", "src/app.ts"),
      change("c2", "src/app.ts"),
      change("c3", "src/app.ts"),
    ];
    const symbolCounts = new Map([["src/app.ts", 10]]);

    const result = computeHotspots(fileChanges, symbolCounts);

    expect(result.hotspots).toHaveLength(1);
    const h = result.hotspots[0]!;
    expect(h.filePath).toBe("src/app.ts");
    expect(h.churn).toBe(3);
    expect(h.symbolCount).toBe(10);
    // Single file = max raw score = 30; normalised = 100
    expect(h.hotspotScore).toBe(100);
  });

  it("normalises scores so the highest is 100 and others are proportional", () => {
    const fileChanges = [
      change("c1", "src/a.ts"),
      change("c2", "src/a.ts"),
      change("c1", "src/b.ts"),
    ];
    // a.ts: churn=2, symbols=10 — maxChurn=2, maxSymbolCount=10
    // b.ts: churn=1, symbols=5
    const symbolCounts = new Map([
      ["src/a.ts", 10],
      ["src/b.ts", 5],
    ]);

    const result = computeHotspots(fileChanges, symbolCounts);

    expect(result.hotspots).toHaveLength(2);
    const a = result.hotspots.find((h) => h.filePath === "src/a.ts")!;
    const b = result.hotspots.find((h) => h.filePath === "src/b.ts")!;

    expect(a.hotspotScore).toBe(100);
    // b: churnScore=(1/2)*100=50, complexityScore=(5/10)*100=50 → average=50
    expect(b.hotspotScore).toBe(50);
  });

  it("filters out files with 0 symbols (non-source files)", () => {
    const fileChanges = [
      change("c1", "package.json"),
      change("c2", "package.json"),
      change("c1", "src/app.ts"),
    ];
    const symbolCounts = new Map([
      ["src/app.ts", 5],
      // package.json intentionally omitted (0 symbols)
    ]);

    const result = computeHotspots(fileChanges, symbolCounts);

    expect(result.hotspots.every((h) => h.filePath !== "package.json")).toBe(true);
    expect(result.hotspots).toHaveLength(1);
  });

  it("respects topN limit", () => {
    const fileChanges: CommitFileChange[] = [];
    const symbolCounts = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const path = `src/file${i}.ts`;
      fileChanges.push(change(`c${i}`, path));
      symbolCounts.set(path, i + 1);
    }

    const result = computeHotspots(fileChanges, symbolCounts, 5);
    expect(result.hotspots).toHaveLength(5);
  });

  it("sorts hotspots by score descending", () => {
    const fileChanges = [
      change("c1", "src/low.ts"),
      change("c1", "src/high.ts"),
      change("c2", "src/high.ts"),
      change("c3", "src/high.ts"),
    ];
    const symbolCounts = new Map([
      ["src/low.ts", 2],
      ["src/high.ts", 20],
    ]);

    const result = computeHotspots(fileChanges, symbolCounts);

    expect(result.hotspots[0]!.filePath).toBe("src/high.ts");
    expect(result.hotspots[result.hotspots.length - 1]!.filePath).toBe("src/low.ts");
  });

  it("single outlier file does not collapse scores of normal files to zero", () => {
    // Regression: under the old churn*symbolCount formula, one machine-generated file
    // with 1000 symbols would make all normal files score near-zero after normalisation.
    const fileChanges = [
      // Outlier: low churn, huge symbol count (machine-generated)
      change("c1", "src/generated.ts"),
      // Normal files: higher churn, moderate symbols
      change("c1", "src/service.ts"),
      change("c2", "src/service.ts"),
      change("c3", "src/service.ts"),
      change("c4", "src/service.ts"),
      change("c5", "src/service.ts"),
      change("c1", "src/controller.ts"),
      change("c2", "src/controller.ts"),
      change("c3", "src/controller.ts"),
    ];
    const symbolCounts = new Map([
      ["src/generated.ts", 1000], // outlier: 1000 symbols, churn=1
      ["src/service.ts", 50], // normal: 50 symbols, churn=5
      ["src/controller.ts", 40], // normal: 40 symbols, churn=3
    ]);

    const result = computeHotspots(fileChanges, symbolCounts);

    const generated = result.hotspots.find(
      (h) => h.filePath === "src/generated.ts",
    )!;
    const service = result.hotspots.find(
      (h) => h.filePath === "src/service.ts",
    )!;
    const controller = result.hotspots.find(
      (h) => h.filePath === "src/controller.ts",
    )!;

    // The outlier has max symbolCount → complexityScore=100, but low churn → churnScore=(1/5)*100=20
    // hotspotScore = round((20 + 100) / 2) = 60
    expect(generated.hotspotScore).toBe(60);

    // service.ts: churnScore=(5/5)*100=100, complexityScore=(50/1000)*100=5 → round(52.5)=53
    expect(service.hotspotScore).toBe(53);

    // controller.ts: churnScore=(3/5)*100=60, complexityScore=(40/1000)*100=4 → round(32)=32
    expect(controller.hotspotScore).toBe(32);

    // Normal files must NOT collapse to 0 — old formula would have given ~0
    expect(service.hotspotScore).toBeGreaterThan(10);
    expect(controller.hotspotScore).toBeGreaterThan(10);
  });

  it("counts distinct commits per file (not raw appearances)", () => {
    // Same commit hash repeated — should count as 1 commit
    const fileChanges = [
      change("c1", "src/app.ts"),
      change("c1", "src/app.ts"), // duplicate hash, same file
      change("c2", "src/app.ts"),
    ];
    const symbolCounts = new Map([["src/app.ts", 5]]);

    const result = computeHotspots(fileChanges, symbolCounts);
    expect(result.hotspots[0]!.churn).toBe(2); // c1 and c2 only
  });
});
