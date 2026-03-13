import { describe, it, expect } from "vitest";
import { withinWindow, extractPairs } from "./git-history.js";

describe("withinWindow", () => {
  it("returns true for dates within window", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-01T00:05:00Z");
    expect(withinWindow(a, b, 10 * 60_000)).toBe(true); // 10 min window
  });

  it("returns false for dates outside window", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-01T01:00:00Z");
    expect(withinWindow(a, b, 10 * 60_000)).toBe(false); // 10 min window
  });

  it("is symmetric", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-01T00:05:00Z");
    expect(withinWindow(a, b, 10 * 60_000)).toBe(withinWindow(b, a, 10 * 60_000));
  });

  it("returns false for exact boundary", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-01T00:10:00Z");
    expect(withinWindow(a, b, 10 * 60_000)).toBe(false); // exactly at boundary
  });
});

describe("extractPairs", () => {
  it("extracts all unique pairs from file list", () => {
    const pairs = extractPairs(["a.ts", "b.ts", "c.ts"]);
    expect(pairs).toHaveLength(3); // (a,b), (a,c), (b,c)
    expect(pairs).toContainEqual(["a.ts", "b.ts"]);
    expect(pairs).toContainEqual(["a.ts", "c.ts"]);
    expect(pairs).toContainEqual(["b.ts", "c.ts"]);
  });

  it("does not produce self-pairs", () => {
    const pairs = extractPairs(["a.ts", "b.ts"]);
    for (const [a, b] of pairs) {
      expect(a).not.toBe(b);
    }
  });

  it("returns empty for single-file list", () => {
    expect(extractPairs(["a.ts"])).toHaveLength(0);
  });

  it("returns empty for empty list", () => {
    expect(extractPairs([])).toHaveLength(0);
  });

  it("sorts pairs alphabetically", () => {
    const pairs = extractPairs(["z.ts", "a.ts"]);
    expect(pairs[0]).toEqual(["a.ts", "z.ts"]);
  });
});
