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
    // a.ts: churn=2, symbols=10, raw=20
    // b.ts: churn=1, symbols=5,  raw=5
    const symbolCounts = new Map([
      ["src/a.ts", 10],
      ["src/b.ts", 5],
    ]);

    const result = computeHotspots(fileChanges, symbolCounts);

    expect(result.hotspots).toHaveLength(2);
    const a = result.hotspots.find((h) => h.filePath === "src/a.ts")!;
    const b = result.hotspots.find((h) => h.filePath === "src/b.ts")!;

    expect(a.hotspotScore).toBe(100);
    // b raw=5, max raw=20 → 5/20 * 100 = 25
    expect(b.hotspotScore).toBe(25);
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
