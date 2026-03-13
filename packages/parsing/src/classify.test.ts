/**
 * Tests for file classification by extension and path.
 */

import { describe, it, expect } from "vitest";
import { classifyFileKind, isParseable } from "./classify.js";

describe("classifyFileKind", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["src/app.tsx", "typescript"],
    ["src/app.mts", "typescript"],
    ["src/app.cts", "typescript"],
  ])("classifies %s as %s", (path, expected) => {
    expect(classifyFileKind(path)).toBe(expected);
  });

  it.each([
    ["src/app.js", "javascript"],
    ["src/app.jsx", "javascript"],
    ["src/app.mjs", "javascript"],
    ["src/app.cjs", "javascript"],
  ])("classifies %s as %s", (path, expected) => {
    expect(classifyFileKind(path)).toBe(expected);
  });

  it("classifies JSON files", () => {
    expect(classifyFileKind("package.json")).toBe("json");
  });

  it.each([
    ["config.yml", "yaml"],
    ["config.yaml", "yaml"],
  ])("classifies %s as yaml", (path) => {
    expect(classifyFileKind(path)).toBe("yaml");
  });

  it.each([
    ["README.md", "markdown"],
    ["docs/guide.mdx", "markdown"],
  ])("classifies %s as markdown", (path) => {
    expect(classifyFileKind(path)).toBe("markdown");
  });

  it("classifies Dockerfile", () => {
    expect(classifyFileKind("Dockerfile")).toBe("dockerfile");
    expect(classifyFileKind("apps/api/dockerfile")).toBe("dockerfile");
  });

  it("classifies Kubernetes by path when extension is unknown", () => {
    // Extension-based classification takes priority over path-based
    expect(classifyFileKind("k8s/deployment.yaml")).toBe("yaml");
    // Path-based k8s detection only fires for unrecognized extensions
    expect(classifyFileKind("k8s/configmap")).toBe("kubernetes");
    expect(classifyFileKind("kubernetes/deployment")).toBe("kubernetes");
  });

  it("returns unknown for unrecognized extensions", () => {
    expect(classifyFileKind("image.png")).toBe("unknown");
    expect(classifyFileKind("data.csv")).toBe("unknown");
  });

  it("is case-insensitive for extensions", () => {
    expect(classifyFileKind("App.TS")).toBe("typescript");
    expect(classifyFileKind("CONFIG.JSON")).toBe("json");
  });
});

describe("isParseable", () => {
  it("returns true for typescript and javascript", () => {
    expect(isParseable("typescript")).toBe(true);
    expect(isParseable("javascript")).toBe(true);
  });

  it("returns false for non-parseable kinds", () => {
    expect(isParseable("json")).toBe(false);
    expect(isParseable("yaml")).toBe(false);
    expect(isParseable("markdown")).toBe(false);
    expect(isParseable("unknown")).toBe(false);
  });
});
