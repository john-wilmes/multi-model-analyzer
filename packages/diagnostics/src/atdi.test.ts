import { describe, it, expect } from "vitest";
import { computeRepoAtdi, computeSystemAtdi } from "./atdi.js";

describe("computeRepoAtdi", () => {
  it("returns 100 for a perfect repo (0 findings, 0 zone modules, 0 distance)", () => {
    const score = computeRepoAtdi("perfect", 10, 0, 0, 0, 0, 0, 0);
    expect(score.score).toBe(100);
    expect(score.components.findingsDensity).toBe(0);
    expect(score.components.zoneRatio).toBe(0);
    expect(score.components.avgDistance).toBe(0);
    expect(score.repo).toBe("perfect");
    expect(score.moduleCount).toBe(10);
  });

  it("returns a low score for an all-error repo", () => {
    // 10 modules, 100 errors → weighted = 1000, per module = 100, density = min(1, 10) = 1
    // zone ratio = 0, avgDistance = 0
    // debtRatio = 1*0.5 + 0*0.3 + 0*0.2 = 0.5 → score = 50
    const score = computeRepoAtdi("bad", 10, 0, 0, 0, 100, 0, 0);
    expect(score.score).toBe(50);
    expect(score.components.findingsDensity).toBe(1);
  });

  it("computes expected weighted score for mixed findings", () => {
    // 10 modules, 1 error + 3 warnings + 6 notes
    // weightedFindings = 1*10 + 3*3 + 6*1 = 10 + 9 + 6 = 25
    // findingsPerModule = 25 / 10 = 2.5
    // findingsDensity = min(1, 2.5/10) = 0.25
    // 2 pain + 1 uselessness = 3 zone modules → zoneRatio = 3/10 = 0.3
    // avgDistance = 0.4
    // debtRatio = 0.25*0.5 + 0.3*0.3 + 0.4*0.2 = 0.125 + 0.09 + 0.08 = 0.295
    // score = round((1 - 0.295) * 100) = round(70.5) = 71
    const score = computeRepoAtdi("mixed", 10, 2, 1, 0.4, 1, 3, 6);
    expect(score.score).toBe(71);
    expect(score.components.findingsDensity).toBeCloseTo(0.25);
    expect(score.components.zoneRatio).toBeCloseTo(0.3);
    expect(score.components.avgDistance).toBeCloseTo(0.4);
    expect(score.findingCounts).toEqual({ error: 1, warning: 3, note: 6 });
  });

  it("normalises correctly for a large repo with many modules", () => {
    // 100 modules, 50 errors → weightedFindings = 500, per module = 5, density = 0.5
    // zone: 10 pain + 10 uselessness = 20 / 100 = 0.2
    // avgDistance = 0.2
    // debtRatio = 0.5*0.5 + 0.2*0.3 + 0.2*0.2 = 0.25 + 0.06 + 0.04 = 0.35
    // score = round(0.65 * 100) = 65
    const score = computeRepoAtdi("large", 100, 10, 10, 0.2, 50, 0, 0);
    expect(score.score).toBe(65);
    expect(score.moduleCount).toBe(100);
  });

  it("handles 0 modules without dividing by zero", () => {
    const score = computeRepoAtdi("empty", 0, 0, 0, 0, 0, 0, 0);
    expect(score.score).toBe(100);
    expect(score.moduleCount).toBe(0);
  });

  it("handles a single module with worst-case inputs", () => {
    // 1 module, 10 errors → weighted = 100, per module = 100, density = 1
    // 1 pain zone → zoneRatio = 1
    // avgDistance = 1
    // debtRatio = 1*0.5 + 1*0.3 + 1*0.2 = 1.0
    // score = round(0) = 0
    const score = computeRepoAtdi("worst", 1, 1, 0, 1, 10, 0, 0);
    expect(score.score).toBe(0);
  });

  it("clamps avgDistance to [0, 1]", () => {
    const score = computeRepoAtdi("clamped", 5, 0, 0, 2.5, 0, 0, 0);
    expect(score.components.avgDistance).toBe(1);
    // debtRatio = 0*0.5 + 0*0.3 + 1*0.2 = 0.2 → score = 80
    expect(score.score).toBe(80);
  });
});

describe("computeSystemAtdi", () => {
  it("returns 100 for an empty repo list", () => {
    const system = computeSystemAtdi([]);
    expect(system.score).toBe(100);
    expect(system.repoScores).toHaveLength(0);
    expect(system.computedAt).toBeTruthy();
  });

  it("returns the single repo score for a one-repo system", () => {
    const r = computeRepoAtdi("solo", 10, 0, 0, 0, 0, 0, 0);
    const system = computeSystemAtdi([r]);
    expect(system.score).toBe(100);
  });

  it("computes weighted average by module count", () => {
    // repo-a: 10 modules, score 80
    // repo-b: 90 modules, score 40
    // weighted avg = (80*10 + 40*90) / (10+90) = (800 + 3600) / 100 = 44
    const a = computeRepoAtdi("repo-a", 10, 0, 0, 0, 0, 10, 0);
    const b = computeRepoAtdi("repo-b", 90, 0, 0, 0, 12, 0, 0);
    // Verify individual scores first
    // repo-a: 0 density, 0 zone, 0 dist → 100? No: warningCount = 10
    // weighted = 0*10 + 10*3 + 0 = 30, per module = 30/10 = 3, density = min(1, 0.3) = 0.3
    // debtRatio = 0.3*0.5 = 0.15, score = round(85) = 85
    expect(a.score).toBe(85);
    // repo-b: 12 errors → weighted = 120, per module = 120/90 ≈ 1.333, density ≈ 0.133
    // debtRatio = 0.1333*0.5 ≈ 0.0667, score = round(93.3) = 93
    expect(b.score).toBe(93);

    const system = computeSystemAtdi([a, b]);
    // weighted avg = (85*10 + 93*90) / 100 = (850 + 8370) / 100 = 9220 / 100 = 92.2 → 92
    expect(system.score).toBe(92);
    expect(system.repoScores).toHaveLength(2);
  });

  it("includes a valid ISO timestamp", () => {
    const system = computeSystemAtdi([]);
    expect(() => new Date(system.computedAt)).not.toThrow();
    expect(new Date(system.computedAt).toISOString()).toBe(system.computedAt);
  });
});
