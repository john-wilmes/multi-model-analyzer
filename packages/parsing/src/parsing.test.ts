import { describe, it, expect, beforeAll } from "vitest";
import { classifyFileKind, isParseable } from "./classify.js";
import {
  initTreeSitter,
  parseSource,
  extractSymbolsFromTree,
  hashContent,
} from "./treesitter.js";

// ---------------------------------------------------------------------------
// classifyFileKind
// ---------------------------------------------------------------------------

describe("classifyFileKind", () => {
  it.each([
    ["app.ts", "typescript"],
    ["app.tsx", "typescript"],
    ["utils.mts", "typescript"],
    ["utils.cts", "typescript"],
    ["index.js", "javascript"],
    ["App.jsx", "javascript"],
    ["config.mjs", "javascript"],
    ["config.cjs", "javascript"],
    ["data.json", "json"],
    ["config.yml", "yaml"],
    ["config.yaml", "yaml"],
    ["README.md", "markdown"],
    ["docs.mdx", "markdown"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "unknown"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(classifyFileKind(path)).toBe(kind);
  });
});

describe("isParseable", () => {
  it("returns true for typescript and javascript", () => {
    expect(isParseable("typescript")).toBe(true);
    expect(isParseable("javascript")).toBe(true);
  });

  it("returns false for non-code kinds", () => {
    expect(isParseable("json")).toBe(false);
    expect(isParseable("yaml")).toBe(false);
    expect(isParseable("markdown")).toBe(false);
    expect(isParseable("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tree-sitter parsing
// ---------------------------------------------------------------------------

describe("tree-sitter parsing", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("extracts function declarations", () => {
    const code = `export function greet(name: string): string { return "hi " + name; }`;
    const tree = parseSource(code, "test.ts");
    const { symbols, errors } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    expect(errors).toHaveLength(0);
    const fn = symbols.find((s) => s.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.exported).toBe(true);
  });

  it("extracts class with methods", () => {
    const code = `
      export class UserService {
        getUser(id: string) { return null; }
        private save() {}
      }
    `;
    const tree = parseSource(code, "test.ts");
    const { symbols } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    const cls = symbols.find((s) => s.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const methods = symbols.filter((s) => s.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    expect(methods.some((m) => m.name === "getUser")).toBe(true);
    expect(methods.some((m) => m.name === "save")).toBe(true);
  });

  it("extracts abstract class with methods", () => {
    const code = `
      export abstract class BaseCommand {
        abstract execute(): Promise<void>;
        validate() { return true; }
      }
    `;
    const tree = parseSource(code, "test.ts");
    expect(tree.rootNode.hasError).toBe(false);
    const { symbols, errors } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();
    expect(errors).toHaveLength(0);

    const cls = symbols.find((s) => s.name === "BaseCommand");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const methods = symbols.filter((s) => s.kind === "method");
    expect(methods.some((m) => m.name === "execute")).toBe(true);
    expect(methods.some((m) => m.name === "validate")).toBe(true);
  });

  it("extracts interfaces and type aliases", () => {
    const code = `
      export interface Config { key: string; }
      export type ID = string;
    `;
    const tree = parseSource(code, "test.ts");
    const { symbols } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    expect(symbols.some((s) => s.name === "Config" && s.kind === "interface")).toBe(true);
    expect(symbols.some((s) => s.name === "ID" && s.kind === "type")).toBe(true);
  });

  it("extracts enum declarations", () => {
    const code = `export enum Status { Active, Inactive }`;
    const tree = parseSource(code, "test.ts");
    const { symbols } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    expect(symbols.some((s) => s.name === "Status" && s.kind === "enum")).toBe(true);
  });

  it("extracts arrow functions as variables", () => {
    const code = `export const add = (a: number, b: number) => a + b;`;
    const tree = parseSource(code, "test.ts");
    const { symbols } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    const fn = symbols.find((s) => s.name === "add");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.exported).toBe(true);
  });

  it("handles malformed TypeScript gracefully", () => {
    const code = `export function broken( { return }`;
    const tree = parseSource(code, "test.ts");
    const { errors } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    expect(errors.length).toBeGreaterThan(0);
  });

  it("handles empty file", () => {
    const tree = parseSource("", "test.ts");
    const { symbols, errors } = extractSymbolsFromTree(tree, "test.ts", "repo");
    tree.delete();

    expect(symbols).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("parses JavaScript files", () => {
    const code = `function hello() { console.log("hi"); }`;
    const tree = parseSource(code, "test.js");
    const { symbols } = extractSymbolsFromTree(tree, "test.js", "repo");
    tree.delete();

    expect(symbols.some((s) => s.name === "hello" && s.kind === "function")).toBe(true);
  });

  it("parses TSX files", () => {
    const code = `export function App() { return <div>Hello</div>; }`;
    const tree = parseSource(code, "test.tsx");
    const { symbols } = extractSymbolsFromTree(tree, "test.tsx", "repo");
    tree.delete();

    expect(symbols.some((s) => s.name === "App" && s.kind === "function")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("returns a hex string", () => {
    const hash = hashContent("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("is deterministic", () => {
    expect(hashContent("test")).toBe(hashContent("test"));
  });
});
