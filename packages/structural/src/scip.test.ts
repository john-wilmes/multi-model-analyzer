import { describe, it, expect } from "vitest";
import { parseScipSymbolString, generateScipIndex } from "./scip.js";

describe("parseScipSymbolString", () => {
  it("parses a full SCIP symbol", () => {
    const result = parseScipSymbolString("npm @mma/core UserService");
    expect(result.scheme).toBe("npm");
    expect(result.package).toBe("@mma/core");
    expect(result.descriptor).toBe("UserService");
  });

  it("handles descriptor with spaces", () => {
    const result = parseScipSymbolString("npm pkg some.Class method().");
    expect(result.scheme).toBe("npm");
    expect(result.package).toBe("pkg");
    expect(result.descriptor).toBe("some.Class method().");
  });

  it("handles empty string", () => {
    const result = parseScipSymbolString("");
    expect(result.scheme).toBe("");
    expect(result.package).toBe("");
    expect(result.descriptor).toBe("");
  });

  it("handles symbol with only scheme", () => {
    const result = parseScipSymbolString("npm");
    expect(result.scheme).toBe("npm");
    expect(result.package).toBe("");
    expect(result.descriptor).toBe("");
  });
});

describe("generateScipIndex", () => {
  it("returns empty result when scip-typescript is not available", async () => {
    // scip-typescript is not installed in test environment, so this exercises
    // the graceful degradation path
    const result = await generateScipIndex("/nonexistent", "test-repo", "/tmp/test.scip");
    expect(result.repo).toBe("test-repo");
    expect(result.indexPath).toBe("/tmp/test.scip");
    expect(result.symbolCount).toBe(0);
    expect(result.documentCount).toBe(0);
  });
});
