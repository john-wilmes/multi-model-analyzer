import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { extractLogStatements } from "./logs.js";

function makeFiles(entries: Record<string, string>): Map<string, TreeSitterTree> {
  const map = new Map<string, TreeSitterTree>();
  for (const [path, code] of Object.entries(entries)) {
    map.set(path, parseSource(code, path));
  }
  return map;
}

describe("extractLogStatements", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("extracts console.error calls as error severity", () => {
    const files = makeFiles({
      "src/app.ts": `console.error("Something went wrong");`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates[0]!.severity).toBe("error");
  });

  it("extracts console.warn calls as warn severity", () => {
    const files = makeFiles({
      "src/app.ts": `console.warn("Deprecated API used");`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates[0]!.severity).toBe("warn");
  });

  it("extracts console.info calls as info severity", () => {
    const files = makeFiles({
      "src/app.ts": `console.info("Server started");`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates[0]!.severity).toBe("info");
  });

  it("extracts console.debug calls as debug severity", () => {
    const files = makeFiles({
      "src/app.ts": `console.debug("Debug info");`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates[0]!.severity).toBe("debug");
  });

  it("extracts logger.error calls", () => {
    const files = makeFiles({
      "src/service.ts": `logger.error("Failed to process request");`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates[0]!.severity).toBe("error");
  });

  it("returns empty for code without log calls", () => {
    const files = makeFiles({
      "src/math.ts": `export function add(a: number, b: number) { return a + b; }`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates).toHaveLength(0);
  });

  it("clusters similar log templates into one with wildcard", () => {
    const files = makeFiles({
      "src/app.ts": `
        console.error("Failed to connect to database");
        console.error("Failed to connect to cache");
      `,
    });
    const result = extractLogStatements(files, "repo");
    // Two structurally similar messages should merge into one template
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.template).toContain("<*>");
    expect(result.templates[0]!.frequency).toBe(2);
    expect(result.templates[0]!.severity).toBe("error");
  });

  it("keeps dissimilar log messages as separate clusters", () => {
    const files = makeFiles({
      "src/app.ts": `
        console.error("Failed to connect to database");
        console.info("Server started on port 3000");
      `,
    });
    const result = extractLogStatements(files, "repo");
    // Completely different messages should stay in separate clusters
    expect(result.templates).toHaveLength(2);
  });

  it("tracks locations across clustered messages", () => {
    const files = makeFiles({
      "src/a.ts": `console.warn("Request timed out for service auth");`,
      "src/b.ts": `console.warn("Request timed out for service payments");`,
    });
    const result = extractLogStatements(files, "repo");
    // Same structure across files → one cluster with both locations
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.locations).toHaveLength(2);
    const modules = result.templates[0]!.locations.map((l) => l.module);
    expect(modules).toContain("src/a.ts");
    expect(modules).toContain("src/b.ts");
  });

  it("replaces variable arguments with <*> placeholders", () => {
    const files = makeFiles({
      "src/app.ts": `console.error("Connection failed:", err);`,
    });
    const result = extractLogStatements(files, "repo");
    expect(result.templates).toHaveLength(1);
    // Non-string argument is replaced with <*>
    expect(result.templates[0]!.template).toContain("<*>");
  });

  it("includes repo in result", () => {
    const files = makeFiles({
      "src/app.ts": `console.log("test");`,
    });
    const result = extractLogStatements(files, "my-repo");
    expect(result.repo).toBe("my-repo");
  });
});
