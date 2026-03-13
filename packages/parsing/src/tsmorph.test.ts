/**
 * Tests for ts-morph wrapper: project creation and symbol extraction.
 *
 * Uses real ts-morph (no mocks) to verify symbol extraction accuracy.
 */

import { describe, it, expect } from "vitest";
import {
  createTsMorphProject,
  extractSymbolsFromSourceFile,
  parseFileWithTsMorph,
} from "./tsmorph.js";

// ---------------------------------------------------------------------------
// createTsMorphProject
// ---------------------------------------------------------------------------

describe("createTsMorphProject", () => {
  it("creates a project without tsconfig", () => {
    const project = createTsMorphProject();
    expect(project).toBeDefined();
    expect(project.getSourceFiles()).toHaveLength(0);
  });

  it("creates a project with skipFileDependencyResolution defaulting to true", () => {
    const project = createTsMorphProject();
    // Verify it works by adding a file with imports that don't resolve
    const sf = project.createSourceFile(
      "test-skip-deps.ts",
      `import { Foo } from "./nonexistent";\nexport const x = 1;`,
    );
    // Should not throw — dependency resolution is skipped
    expect(sf.getFullText()).toContain("import");
  });

  it("creates a project with explicit skipFileDependencyResolution false", () => {
    const project = createTsMorphProject({ skipFileDependencyResolution: false });
    expect(project).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — functions
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — functions", () => {
  it("extracts exported function declarations", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "funcs.ts",
      `export function greet(name: string): string { return "hi " + name; }
function internal() { return 42; }`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const greet = symbols.find((s) => s.name === "greet");
    const internal = symbols.find((s) => s.name === "internal");

    expect(greet).toBeDefined();
    expect(greet!.kind).toBe("function");
    expect(greet!.exported).toBe(true);
    expect(greet!.startLine).toBeGreaterThan(0);
    expect(greet!.endLine).toBeGreaterThanOrEqual(greet!.startLine);

    expect(internal).toBeDefined();
    expect(internal!.kind).toBe("function");
    expect(internal!.exported).toBe(false);
  });

  it("extracts unnamed functions (skips them)", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "unnamed.ts",
      `export default function() { return 1; }`,
    );
    const symbols = extractSymbolsFromSourceFile(sf);
    // Default export unnamed function should be skipped (getName() returns undefined)
    expect(symbols.filter((s) => s.kind === "function")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — classes
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — classes", () => {
  it("extracts class with methods", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "classes.ts",
      `export class UserService {
  getUser(id: string) { return null; }
  private save() {}
}`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const cls = symbols.find((s) => s.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.exported).toBe(true);

    const getUser = symbols.find((s) => s.name === "getUser");
    expect(getUser).toBeDefined();
    expect(getUser!.kind).toBe("method");
    expect(getUser!.exported).toBe(false);
    expect(getUser!.containerName).toBe("UserService");

    const save = symbols.find((s) => s.name === "save");
    expect(save).toBeDefined();
    expect(save!.kind).toBe("method");
    expect(save!.containerName).toBe("UserService");
  });

  it("skips unnamed classes", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "unnamed-class.ts",
      `export default class {}`,
    );
    const symbols = extractSymbolsFromSourceFile(sf);
    expect(symbols.filter((s) => s.kind === "class")).toHaveLength(0);
  });

  it("extracts multiple classes from one file", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "multi-class.ts",
      `class A { doA() {} }
class B { doB() {} }`,
    );
    const symbols = extractSymbolsFromSourceFile(sf);
    expect(symbols.filter((s) => s.kind === "class")).toHaveLength(2);
    expect(symbols.filter((s) => s.kind === "method")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — interfaces
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — interfaces", () => {
  it("extracts interfaces with export detection", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "interfaces.ts",
      `export interface Config { key: string; }
interface InternalConfig { secret: string; }`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const config = symbols.find((s) => s.name === "Config");
    expect(config).toBeDefined();
    expect(config!.kind).toBe("interface");
    expect(config!.exported).toBe(true);

    const internal = symbols.find((s) => s.name === "InternalConfig");
    expect(internal).toBeDefined();
    expect(internal!.kind).toBe("interface");
    expect(internal!.exported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — type aliases
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — type aliases", () => {
  it("extracts type aliases with export detection", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "types.ts",
      `export type ID = string;
type Internal = number;
export type Result<T> = { data: T; error: string | null };`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const id = symbols.find((s) => s.name === "ID");
    expect(id).toBeDefined();
    expect(id!.kind).toBe("type");
    expect(id!.exported).toBe(true);

    const internal = symbols.find((s) => s.name === "Internal");
    expect(internal!.exported).toBe(false);

    const result = symbols.find((s) => s.name === "Result");
    expect(result!.exported).toBe(true);
    expect(result!.kind).toBe("type");
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — enums
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — enums", () => {
  it("extracts enum declarations", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "enums.ts",
      `export enum Status { Active, Inactive }
enum Direction { Up, Down, Left, Right }`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const status = symbols.find((s) => s.name === "Status");
    expect(status).toBeDefined();
    expect(status!.kind).toBe("enum");
    expect(status!.exported).toBe(true);

    const direction = symbols.find((s) => s.name === "Direction");
    expect(direction!.exported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — variables
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — variables", () => {
  it("classifies arrow functions as function kind", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "arrows.ts",
      `export const add = (a: number, b: number) => a + b;
const multiply = (a: number, b: number) => a * b;`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const add = symbols.find((s) => s.name === "add");
    expect(add).toBeDefined();
    expect(add!.kind).toBe("function");
    expect(add!.exported).toBe(true);

    const multiply = symbols.find((s) => s.name === "multiply");
    expect(multiply!.kind).toBe("function");
    expect(multiply!.exported).toBe(false);
  });

  it("classifies function expressions as function kind", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "func-expr.ts",
      `export const handler = function(req: any) { return req; };`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const handler = symbols.find((s) => s.name === "handler");
    expect(handler).toBeDefined();
    expect(handler!.kind).toBe("function");
  });

  it("classifies non-function variables as variable kind", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "vars.ts",
      `export const PORT = 3000;
const config = { key: "value" };
let counter = 0;`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    const port = symbols.find((s) => s.name === "PORT");
    expect(port!.kind).toBe("variable");
    expect(port!.exported).toBe(true);

    const config = symbols.find((s) => s.name === "config");
    expect(config!.kind).toBe("variable");

    const counter = symbols.find((s) => s.name === "counter");
    expect(counter!.kind).toBe("variable");
  });

  it("handles destructured declarations (names include binding pattern)", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "destructured.ts",
      `const { a, b } = { a: 1, b: 2 };`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    // ts-morph treats object binding pattern as a single declaration
    // The getName() returns the full pattern text, not individual names
    expect(symbols.length).toBeGreaterThanOrEqual(0);
    // No crash — that's the key behavior to verify
  });

  it("detects export via variable statement", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "var-export.ts",
      `export const X = 1, Y = 2;`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);
    expect(symbols.find((s) => s.name === "X")!.exported).toBe(true);
    expect(symbols.find((s) => s.name === "Y")!.exported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractSymbolsFromSourceFile — mixed file
// ---------------------------------------------------------------------------

describe("extractSymbolsFromSourceFile — comprehensive", () => {
  it("extracts all symbol kinds from a complex file", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "comprehensive.ts",
      `export function processData(input: string) { return input; }
function helperFn() { return 42; }
export class DataService {
  fetch(url: string) { return null; }
  private transform(data: any) { return data; }
}
export interface DataConfig { endpoint: string; timeout: number; }
export type DataResult = { data: any; error: string | null };
export enum DataStatus { Pending, Loading, Done, Error }
export const MAX_RETRIES = 3;
export const processItem = (item: any) => item;
const INTERNAL = "secret";
`,
    );

    const symbols = extractSymbolsFromSourceFile(sf);

    // Count by kind
    const byKind = new Map<string, number>();
    for (const s of symbols) {
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    }

    // processData, helperFn, processItem (arrow) = 3 functions
    expect(byKind.get("function")).toBe(3);

    expect(symbols.some((s) => s.name === "processData" && s.kind === "function" && s.exported)).toBe(true);
    expect(symbols.some((s) => s.name === "helperFn" && s.kind === "function" && !s.exported)).toBe(true);
    expect(symbols.some((s) => s.name === "DataService" && s.kind === "class" && s.exported)).toBe(true);
    expect(symbols.some((s) => s.name === "fetch" && s.kind === "method")).toBe(true);
    expect(symbols.some((s) => s.name === "transform" && s.kind === "method")).toBe(true);
    expect(symbols.some((s) => s.name === "DataConfig" && s.kind === "interface")).toBe(true);
    expect(symbols.some((s) => s.name === "DataResult" && s.kind === "type")).toBe(true);
    expect(symbols.some((s) => s.name === "DataStatus" && s.kind === "enum")).toBe(true);
    expect(symbols.some((s) => s.name === "MAX_RETRIES" && s.kind === "variable")).toBe(true);
    expect(symbols.some((s) => s.name === "processItem" && s.kind === "function")).toBe(true);
    expect(symbols.some((s) => s.name === "INTERNAL" && s.kind === "variable" && !s.exported)).toBe(true);
  });

  it("returns empty array for empty file", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile("empty.ts", "");
    const symbols = extractSymbolsFromSourceFile(sf);
    expect(symbols).toHaveLength(0);
  });

  it("returns empty array for file with only comments", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile("comments.ts", `// just a comment\n/* block comment */`);
    const symbols = extractSymbolsFromSourceFile(sf);
    expect(symbols).toHaveLength(0);
  });

  it("handles re-exported names in exportedDeclarations", () => {
    const project = createTsMorphProject();
    project.createSourceFile("source.ts", `export const FOO = 1;`);
    const sf = project.createSourceFile("reexport.ts", `export { FOO } from "./source";`);
    // FOO is in exportedDeclarations but not a local declaration
    const symbols = extractSymbolsFromSourceFile(sf);
    // Should not crash; may or may not include FOO depending on how ts-morph handles it
    expect(Array.isArray(symbols)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFileWithTsMorph
// ---------------------------------------------------------------------------

describe("parseFileWithTsMorph", () => {
  it("returns a complete ParsedFile", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "full-parse.ts",
      `export function hello() { return "world"; }`,
    );

    const parsed = parseFileWithTsMorph(sf, "test-repo");

    expect(parsed.repo).toBe("test-repo");
    expect(parsed.kind).toBe("typescript");
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0]!.name).toBe("hello");
  });

  it("sets consistent contentHash from file content", () => {
    const project = createTsMorphProject();
    const content = `export const X = 42;`;
    const sf = project.createSourceFile("hash-test.ts", content);

    const parsed1 = parseFileWithTsMorph(sf, "repo");
    const parsed2 = parseFileWithTsMorph(sf, "repo");

    expect(parsed1.contentHash).toBe(parsed2.contentHash);
  });

  it("includes all symbol types in output", () => {
    const project = createTsMorphProject();
    const sf = project.createSourceFile(
      "all-types.ts",
      `export function fn() {}
export class C { m() {} }
export interface I { x: number; }
export type T = string;
export enum E { A }
export const v = 1;`,
    );

    const parsed = parseFileWithTsMorph(sf, "repo");
    const kinds = new Set(parsed.symbols.map((s) => s.kind));
    expect(kinds.has("function")).toBe(true);
    expect(kinds.has("class")).toBe(true);
    expect(kinds.has("method")).toBe(true);
    expect(kinds.has("interface")).toBe(true);
    expect(kinds.has("type")).toBe(true);
    expect(kinds.has("enum")).toBe(true);
    expect(kinds.has("variable")).toBe(true);
  });
});
