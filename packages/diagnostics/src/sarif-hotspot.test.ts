import { describe, it, expect } from "vitest";
import { hotspotFindings } from "./sarif-hotspot.js";
import type { HotspotEntry } from "./sarif-hotspot.js";

function entry(filePath: string, churn: number, symbolCount: number, hotspotScore: number): HotspotEntry {
  return { filePath, churn, symbolCount, hotspotScore };
}

describe("hotspotFindings", () => {
  it("returns no findings when all scores are below threshold/2", () => {
    const hotspots = [entry("src/a.ts", 5, 10, 20)];
    const results = hotspotFindings(hotspots, "my-repo", 50);
    expect(results).toHaveLength(0);
  });

  it("emits 'warning' level for scores at or above threshold", () => {
    const hotspots = [entry("src/a.ts", 10, 20, 75)];
    const results = hotspotFindings(hotspots, "my-repo", 50);

    expect(results).toHaveLength(1);
    expect(results[0]!.level).toBe("warning");
    expect(results[0]!.ruleId).toBe("hotspot/high-churn-complexity");
  });

  it("emits 'note' level for scores between threshold/2 and threshold", () => {
    const hotspots = [entry("src/b.ts", 5, 10, 30)]; // 30 >= 25 (50/2) but < 50
    const results = hotspotFindings(hotspots, "my-repo", 50);

    expect(results).toHaveLength(1);
    expect(results[0]!.level).toBe("note");
  });

  it("produces correct SARIF result shape with logicalLocations and repo property", () => {
    const hotspots = [entry("src/core.ts", 8, 15, 80)];
    const results = hotspotFindings(hotspots, "my-repo", 50);

    expect(results).toHaveLength(1);
    const r = results[0]!;

    expect(r.ruleId).toBe("hotspot/high-churn-complexity");
    expect(r.message.text).toContain("8 commits");
    expect(r.message.text).toContain("15 symbols");
    expect(r.message.text).toContain("80/100");

    const loc = r.locations?.[0];
    expect(loc).toBeDefined();
    const ll = loc!.logicalLocations?.[0];
    expect(ll).toBeDefined();
    expect(ll!.fullyQualifiedName).toBe("src/core.ts");
    expect(ll!.kind).toBe("module");
    expect(ll!.properties?.["repo"]).toBe("my-repo");
  });

  it("handles multiple hotspots and applies per-entry threshold", () => {
    const hotspots = [
      entry("src/a.ts", 20, 30, 100), // warning
      entry("src/b.ts", 10, 10, 40),  // note (40 >= 25)
      entry("src/c.ts", 2, 5, 10),    // filtered (10 < 25)
    ];
    const results = hotspotFindings(hotspots, "repo", 50);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.properties?.["hotspotScore"] === 100)?.level).toBe("warning");
    expect(results.find((r) => r.properties?.["hotspotScore"] === 40)?.level).toBe("note");
  });

  it("stores churn, symbolCount, and hotspotScore in properties", () => {
    const hotspots = [entry("src/x.ts", 7, 12, 60)];
    const results = hotspotFindings(hotspots, "repo", 50);

    expect(results[0]!.properties?.["churn"]).toBe(7);
    expect(results[0]!.properties?.["symbolCount"]).toBe(12);
    expect(results[0]!.properties?.["hotspotScore"]).toBe(60);
  });
});
