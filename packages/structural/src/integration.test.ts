/**
 * Integration tests using real tree-sitter WASM parsing.
 *
 * Verifies that tree-sitter output feeds correctly into dependency
 * graph extraction and CFG construction.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource, extractSymbolsFromTree } from "@mma/parsing";
import { extractDependencyGraph, buildControlFlowGraph, traceBackward, createCfgIdCounter, isBarrelFile, tagBarrelMediatedCycles, getBarrelPaths } from "../src/index.js";
import type { TreeSitterTree } from "@mma/parsing";

beforeAll(async () => {
  await initTreeSitter();
}, 15_000);

describe("tree-sitter -> symbol extraction", () => {
  it("extracts function and class symbols from TypeScript", () => {
    const source = `
export function greet(name: string): string {
  return "hello " + name;
}

export class Greeter {
  private name: string;
  constructor(name: string) {
    this.name = name;
  }
  greet(): string {
    return "hello " + this.name;
  }
}

const helper = (x: number) => x * 2;
`;
    const tree = parseSource(source, "greet.ts");
    expect(tree.rootNode.type).toBe("program");

    const { symbols, errors } = extractSymbolsFromTree(tree, "greet.ts", "test-repo");
    expect(errors).toHaveLength(0);

    const names = symbols.map((s) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");

    const greetSym = symbols.find((s) => s.name === "greet" && s.kind === "function");
    expect(greetSym).toBeDefined();
    expect(greetSym!.exported).toBe(true);

    const classSym = symbols.find((s) => s.name === "Greeter");
    expect(classSym).toBeDefined();
    expect(classSym!.kind).toBe("class");
    expect(classSym!.exported).toBe(true);
  });

  it("extracts interface and type alias symbols", () => {
    const source = `
export interface Config {
  host: string;
  port: number;
}

export type Mode = "dev" | "prod";
`;
    const tree = parseSource(source, "types.ts");
    const { symbols } = extractSymbolsFromTree(tree, "types.ts", "test-repo");

    const iface = symbols.find((s) => s.name === "Config");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");

    const alias = symbols.find((s) => s.name === "Mode");
    expect(alias).toBeDefined();
    expect(alias!.kind).toBe("type");
  });
});

describe("tree-sitter -> dependency graph", () => {
  it("extracts import edges from parsed trees", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/app.ts", parseSource(`
import { Greeter } from "./greeter";
import { Config } from "./config";

const g = new Greeter("world");
`, "src/app.ts"));

    files.set("src/greeter.ts", parseSource(`
import { Logger } from "./logger";

export class Greeter {
  greet(name: string) { Logger.info("greeting " + name); }
}
`, "src/greeter.ts"));

    files.set("src/config.ts", parseSource(`
export interface Config { host: string; }
`, "src/config.ts"));

    const graph = extractDependencyGraph(files, "test-repo");

    // Exact edge counts: app imports 2, greeter imports 1, config imports 0
    const appEdges = graph.edges.filter((e) => e.source === "test-repo:src/app.ts");
    expect(appEdges).toHaveLength(2);
    // Import specifiers are resolved to file paths when matches exist
    expect(appEdges.map((e) => e.target).sort()).toEqual(["test-repo:src/config.ts", "test-repo:src/greeter.ts"]);

    const greeterEdges = graph.edges.filter((e) => e.source === "test-repo:src/greeter.ts");
    expect(greeterEdges).toHaveLength(1);
    // "./logger" has no matching file, falls back to raw specifier
    expect(greeterEdges[0]!.target).toBe("./logger");

    const configEdges = graph.edges.filter((e) => e.source === "test-repo:src/config.ts");
    expect(configEdges).toHaveLength(0);

    expect(graph.edges).toHaveLength(3);
  });

  it("extracts re-export edges from barrel files", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/index.ts", parseSource(`
export * from "./service";
export { Config } from "./config";
`, "src/index.ts"));

    files.set("src/service.ts", parseSource(`
export class MyService {}
`, "src/service.ts"));

    files.set("src/config.ts", parseSource(`
export interface Config { port: number; }
`, "src/config.ts"));

    const graph = extractDependencyGraph(files, "test-repo");

    const barrelEdges = graph.edges.filter((e) => e.source === "test-repo:src/index.ts");
    expect(barrelEdges).toHaveLength(2);
    expect(barrelEdges.map((e) => e.target).sort()).toEqual([
      "test-repo:src/config.ts",
      "test-repo:src/service.ts",
    ]);

    // Exported classes without 'from' clause should NOT produce edges
    const serviceEdges = graph.edges.filter((e) => e.source === "test-repo:src/service.ts");
    expect(serviceEdges).toHaveLength(0);
  });

  it("detects circular dependencies", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("a.ts", parseSource(`import { b } from "./b";`, "a.ts"));
    files.set("b.ts", parseSource(`import { a } from "./a";`, "b.ts"));

    const graph = extractDependencyGraph(files, "test-repo", { detectCircular: true });

    expect(graph.edges).toHaveLength(2);
    // Import specifiers are now resolved to file paths
    expect(graph.edges.find((e) => e.source === "test-repo:a.ts" && e.target === "test-repo:b.ts")).toBeDefined();
    expect(graph.edges.find((e) => e.source === "test-repo:b.ts" && e.target === "test-repo:a.ts")).toBeDefined();
    // With resolved paths, circular dependencies are detected
    expect(graph.circularDependencies.length).toBeGreaterThan(0);
  });
});

describe("tree-sitter -> CFG construction", () => {
  it("builds CFG for a function with if/else", () => {
    const source = `
function check(x: number): string {
  if (x > 0) {
    return "positive";
  } else {
    return "non-positive";
  }
}
`;
    const tree = parseSource(source, "check.ts");
    const fnNode = tree.rootNode.namedChildren.find(
      (c) => c.type === "function_declaration",
    );
    expect(fnNode).toBeDefined();

    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fnNode!, "check.ts#check", "test-repo", "check.ts", counter);

    expect(cfg.functionId).toBe("check.ts#check");
    expect(cfg.nodes.length).toBeGreaterThanOrEqual(4); // entry, exit, if, branches

    const entry = cfg.nodes.find((n) => n.kind === "entry");
    const exit = cfg.nodes.find((n) => n.kind === "exit");
    const branch = cfg.nodes.find((n) => n.kind === "branch");
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(branch).toBeDefined();

    // Branch should have line number populated
    expect(branch!.line).toBeGreaterThan(0);
  });

  it("builds CFG for a function with try/catch", () => {
    const source = `
function risky(): void {
  try {
    doSomething();
  } catch (e) {
    console.error("failed", e);
  }
}
`;
    const tree = parseSource(source, "risky.ts");
    const fnNode = tree.rootNode.namedChildren.find(
      (c) => c.type === "function_declaration",
    );
    expect(fnNode).toBeDefined();

    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fnNode!, "risky.ts#risky", "test-repo", "risky.ts", counter);

    const tryNode = cfg.nodes.find((n) => n.kind === "try");
    const catchNode = cfg.nodes.find((n) => n.kind === "catch");
    expect(tryNode).toBeDefined();
    expect(catchNode).toBeDefined();

    // Exception edge from try to catch
    const exceptionEdge = cfg.edges.find(
      (e) => e.from === tryNode!.id && e.condition === "exception",
    );
    expect(exceptionEdge).toBeDefined();
  });

  it("supports backward tracing from a statement", () => {
    const source = `
function process(data: any): void {
  const validated = validate(data);
  if (!validated) {
    console.error("validation failed");
    return;
  }
  save(data);
}
`;
    const tree = parseSource(source, "process.ts");
    const fnNode = tree.rootNode.namedChildren.find(
      (c) => c.type === "function_declaration",
    );
    expect(fnNode).toBeDefined();

    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fnNode!, "process.ts#process", "test-repo", "process.ts", counter);

    // Find the error log node
    const errorNode = cfg.nodes.find(
      (n) => n.kind === "statement" && n.label.includes("console.error"),
    );
    expect(errorNode).toBeDefined();

    // Trace backward from the error
    const path = traceBackward(cfg, errorNode!.id);
    expect(path.length).toBeGreaterThanOrEqual(2); // at least the error node and entry
    expect(path).toContain(errorNode!.id);

    // Should reach back to entry
    const entryNode = cfg.nodes.find((n) => n.kind === "entry");
    expect(path).toContain(entryNode!.id);
  });
});

describe("tree-sitter -> CFG throw statement", () => {
  it("produces exactly one throw node (no duplicate)", () => {
    const source = `
function bail(): never {
  throw new Error("fatal");
}
`;
    const tree = parseSource(source, "bail.ts");
    const fnNode = tree.rootNode.namedChildren.find(
      (c) => c.type === "function_declaration",
    )!;

    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fnNode, "bail.ts#bail", "test-repo", "bail.ts", counter);

    const throwNodes = cfg.nodes.filter((n) => n.kind === "throw");
    expect(throwNodes).toHaveLength(1);
  });
});

describe("tree-sitter -> CFG single-statement bodies", () => {
  it("handles if with single-statement body (no braces)", () => {
    const source = `
function check(x: number): string {
  if (x > 0) return "positive";
  return "non-positive";
}
`;
    const tree = parseSource(source, "check2.ts");
    const fnNode = tree.rootNode.namedChildren.find(
      (c) => c.type === "function_declaration",
    )!;

    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fnNode, "check2.ts#check", "test-repo", "check2.ts", counter);

    // Should have a return node inside the if branch
    const returnNodes = cfg.nodes.filter((n) => n.kind === "return");
    expect(returnNodes.length).toBeGreaterThanOrEqual(1);

    // Branch should exist
    const branchNodes = cfg.nodes.filter((n) => n.kind === "branch");
    expect(branchNodes).toHaveLength(1);
  });

  it("handles while loop with single-statement body", () => {
    const source = `
function spin(n: number): void {
  while (n > 0) n--;
}
`;
    const tree = parseSource(source, "spin.ts");
    const fnNode = tree.rootNode.namedChildren.find(
      (c) => c.type === "function_declaration",
    )!;

    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fnNode, "spin.ts#spin", "test-repo", "spin.ts", counter);

    // Should have the loop node and a statement node for the body
    const loopNodes = cfg.nodes.filter((n) => n.kind === "loop");
    expect(loopNodes).toHaveLength(1);

    // The body statement should be connected to the loop node
    const loopId = loopNodes[0]!.id;
    const bodyEdges = cfg.edges.filter((e) => e.from === loopId && e.to !== loopId);
    expect(bodyEdges.length).toBeGreaterThanOrEqual(1);
  });
});

describe("tree-sitter -> CFG counter isolation", () => {
  it("produces unique IDs with separate counters per repo", () => {
    const source = `function a(): void { return; }`;

    const tree1 = parseSource(source, "a.ts");
    const tree2 = parseSource(source, "b.ts");
    const fn1 = tree1.rootNode.namedChildren.find((c) => c.type === "function_declaration")!;
    const fn2 = tree2.rootNode.namedChildren.find((c) => c.type === "function_declaration")!;

    const counter1 = createCfgIdCounter();
    const counter2 = createCfgIdCounter();

    const cfg1 = buildControlFlowGraph(fn1, "a.ts#a", "repo1", "a.ts", counter1);
    const cfg2 = buildControlFlowGraph(fn2, "b.ts#a", "repo2", "b.ts", counter2);

    // Both start from cfg_0 since counters are independent
    const ids1 = cfg1.nodes.map((n) => n.id);
    const ids2 = cfg2.nodes.map((n) => n.id);
    expect(ids1[0]).toBe("cfg_0");
    expect(ids2[0]).toBe("cfg_0");

    // All IDs within a CFG are unique
    expect(new Set(ids1).size).toBe(ids1.length);
    expect(new Set(ids2).size).toBe(ids2.length);
  });
});

describe("loader prefix stripping in dependency extraction", () => {
  it("strips directcss: prefix and resolves the underlying path", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/app.ts", parseSource(`
import "./utils";
import "directcss:./styles.css";
`, "src/app.ts"));

    files.set("src/utils.ts", parseSource(`export const x = 1;`, "src/utils.ts"));
    files.set("src/styles.css", parseSource(``, "src/styles.css"));

    const graph = extractDependencyGraph(files, "test-repo");
    const appEdges = graph.edges.filter((e) => e.source === "test-repo:src/app.ts");

    // Should have 2 edges: one to utils.ts, one to styles.css (with prefix stripped)
    expect(appEdges).toHaveLength(2);
    const targets = appEdges.map((e) => e.target).sort();
    expect(targets).toEqual(["test-repo:src/styles.css", "test-repo:src/utils.ts"]);
  });

  it("strips various loader prefixes (raw:, url:, inline:, asset:, worker:)", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/app.ts", parseSource(`
import "raw:./data.txt";
import "url:./image.png";
import "inline:./template.html";
import "asset:./font.woff";
import "worker:./worker.ts";
`, "src/app.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const appEdges = graph.edges.filter((e) => e.source === "test-repo:src/app.ts");

    // All prefixes stripped — targets are the raw specifiers (no matching files)
    const targets = appEdges.map((e) => e.target).sort();
    expect(targets).toEqual([
      "./data.txt",
      "./font.woff",
      "./image.png",
      "./template.html",
      "./worker.ts",
    ]);
  });

  it("strips webpack-style loader prefixes (raw-loader!, url-loader!, file-loader!)", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/app.ts", parseSource(`
import "raw-loader!./data.csv";
import "url-loader!./icon.svg";
import "file-loader!./document.pdf";
`, "src/app.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const appEdges = graph.edges.filter((e) => e.source === "test-repo:src/app.ts");

    const targets = appEdges.map((e) => e.target).sort();
    expect(targets).toEqual(["./data.csv", "./document.pdf", "./icon.svg"]);
  });

  it("does not strip prefixes that are not loader prefixes", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/app.ts", parseSource(`
import "node:fs";
import "@scope/pkg";
`, "src/app.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const appEdges = graph.edges.filter((e) => e.source === "test-repo:src/app.ts");

    const targets = appEdges.map((e) => e.target).sort();
    expect(targets).toEqual(["@scope/pkg", "node:fs"]);
  });

  it("strips loader prefix from bare require() calls", () => {
    const files = new Map<string, TreeSitterTree>();

    // Bare require() as expression statement (not assigned to a variable)
    files.set("src/app.ts", parseSource(`
require("directcss:./styles.css");
`, "src/app.ts"));

    files.set("src/styles.css", parseSource(``, "src/styles.css"));

    const graph = extractDependencyGraph(files, "test-repo");
    const appEdges = graph.edges.filter((e) => e.source === "test-repo:src/app.ts");

    expect(appEdges).toHaveLength(1);
    expect(appEdges[0]!.target).toBe("test-repo:src/styles.css");
  });

  it("strips loader prefix from re-export statements", () => {
    const files = new Map<string, TreeSitterTree>();

    files.set("src/index.ts", parseSource(`
export * from "raw:./data";
`, "src/index.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edges = graph.edges.filter((e) => e.source === "test-repo:src/index.ts");

    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe("./data");
  });
});

describe("isBarrelFile", () => {
  it("returns true for a pure re-export barrel (export * from)", () => {
    const tree = parseSource(
      `export * from "./a";\nexport * from "./b";`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(true);
  });

  it("returns true for a named re-export barrel (export { X } from)", () => {
    const tree = parseSource(
      `export { Foo } from "./foo";\nexport { Bar } from "./bar";`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(true);
  });

  it("returns false when a re-export lacks a from clause", () => {
    const tree = parseSource(
      `import type { Baz } from "./baz";\nexport * from "./a";\nexport { Baz };`,
      "index.ts",
    );
    // "export { Baz }" has no source/from clause — disqualifies as barrel
    expect(isBarrelFile(tree)).toBe(false);
  });

  it("returns true for barrel with only type re-exports", () => {
    const tree = parseSource(
      `export type { Foo } from "./foo";`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(true);
  });

  it("returns false for a file that exports a local class", () => {
    const tree = parseSource(
      `export class Foo {}\nexport * from "./shared";`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(false);
  });

  it("returns false for a file that exports a local function", () => {
    const tree = parseSource(
      `export function bar(): void {}\n`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(false);
  });

  it("returns false for an empty file (no re-exports)", () => {
    const tree = parseSource(``, "index.ts");
    expect(isBarrelFile(tree)).toBe(false);
  });

  it("returns false for a file with only import statements", () => {
    const tree = parseSource(
      `import { foo } from "./foo";\nimport { bar } from "./bar";`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(false);
  });

  it("returns false for a file with a top-level variable declaration", () => {
    const tree = parseSource(
      `export * from "./a";\nconst x = 1;`,
      "index.ts",
    );
    expect(isBarrelFile(tree)).toBe(false);
  });
});

describe("tagBarrelMediatedCycles", () => {
  it("tags a cycle that passes through a barrel index.ts", () => {
    const files = new Map<string, TreeSitterTree>();
    // barrel: index.ts re-exports from service.ts
    files.set("src/index.ts", parseSource(`export * from "./service";`, "src/index.ts"));
    // service imports from index (forming a cycle through the barrel)
    files.set("src/service.ts", parseSource(`import { x } from "./index";`, "src/service.ts"));

    const cycles: string[][] = [
      ["test-repo:src/index.ts", "test-repo:src/service.ts"],
    ];

    const annotated = tagBarrelMediatedCycles(cycles, files, "test-repo");
    expect(annotated).toHaveLength(1);
    expect(annotated[0]!.barrelMediated).toBe(true);
    expect(annotated[0]!.cycle).toEqual(cycles[0]);
  });

  it("does not tag a cycle with no barrel files", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/a.ts", parseSource(`export class A {};\nimport { B } from "./b";`, "src/a.ts"));
    files.set("src/b.ts", parseSource(`export class B {};\nimport { A } from "./a";`, "src/b.ts"));

    const cycles: string[][] = [
      ["test-repo:src/a.ts", "test-repo:src/b.ts"],
    ];

    const annotated = tagBarrelMediatedCycles(cycles, files, "test-repo");
    expect(annotated[0]!.barrelMediated).toBe(false);
  });

  it("does not tag a cycle when index.ts exports local symbols (not a barrel)", () => {
    const files = new Map<string, TreeSitterTree>();
    // This index.ts defines its own symbols — not a pure barrel
    files.set("src/index.ts", parseSource(`export class Root {}\nexport * from "./helper";`, "src/index.ts"));
    files.set("src/helper.ts", parseSource(`import { Root } from "./index";`, "src/helper.ts"));

    const cycles: string[][] = [
      ["test-repo:src/index.ts", "test-repo:src/helper.ts"],
    ];

    const annotated = tagBarrelMediatedCycles(cycles, files, "test-repo");
    expect(annotated[0]!.barrelMediated).toBe(false);
  });

  it("handles an empty cycle list", () => {
    const files = new Map<string, TreeSitterTree>();
    expect(tagBarrelMediatedCycles([], files, "test-repo")).toEqual([]);
  });

  it("only checks index.{ts,tsx,js,jsx} filenames for barrel status", () => {
    const files = new Map<string, TreeSitterTree>();
    // A non-index file that only has re-exports should NOT be treated as a barrel
    files.set("src/barrel.ts", parseSource(`export * from "./a";`, "src/barrel.ts"));
    files.set("src/a.ts", parseSource(`import { x } from "./barrel";`, "src/a.ts"));

    const cycles: string[][] = [
      ["test-repo:src/barrel.ts", "test-repo:src/a.ts"],
    ];

    const annotated = tagBarrelMediatedCycles(cycles, files, "test-repo");
    expect(annotated[0]!.barrelMediated).toBe(false);
  });
});

describe("extractDependencyGraph with suppressBarrelCycles", () => {
  it("suppresses a cycle that passes through a barrel index.ts", () => {
    // a.ts imports index.ts (barrel), index.ts re-exports from a.ts → barrel-mediated cycle
    const files = new Map<string, TreeSitterTree>();
    files.set("src/index.ts", parseSource(`export * from "./a";`, "src/index.ts"));
    files.set("src/a.ts", parseSource(`import { x } from "./index";`, "src/a.ts"));

    const graph = extractDependencyGraph(files, "test-repo", {
      detectCircular: true,
      suppressBarrelCycles: true,
    });

    // The edges still exist (import graph is unchanged)
    expect(graph.edges.length).toBeGreaterThan(0);
    // But the barrel-mediated cycle is suppressed from circularDependencies
    expect(graph.circularDependencies).toHaveLength(0);
  });

  it("does NOT suppress a real cycle with no barrel files", () => {
    // a.ts <-> b.ts — a genuine circular dependency, no barrel
    const files = new Map<string, TreeSitterTree>();
    files.set("src/a.ts", parseSource(`export class A {}\nimport { B } from "./b";`, "src/a.ts"));
    files.set("src/b.ts", parseSource(`export class B {}\nimport { A } from "./a";`, "src/b.ts"));

    const graph = extractDependencyGraph(files, "test-repo", {
      detectCircular: true,
      suppressBarrelCycles: true,
    });

    // The real cycle must still be reported
    expect(graph.circularDependencies.length).toBeGreaterThan(0);
    const hasCycle = graph.circularDependencies.some(
      (c) => c.some((n) => n.includes("a.ts")) && c.some((n) => n.includes("b.ts")),
    );
    expect(hasCycle).toBe(true);
  });

  it("suppresses barrel-mediated cycles but keeps real cycles in the same graph", () => {
    // real cycle: a.ts <-> b.ts
    // barrel-mediated cycle: c.ts -> index.ts (re-exports c.ts)
    const files = new Map<string, TreeSitterTree>();
    files.set("src/a.ts", parseSource(`export class A {}\nimport { B } from "./b";`, "src/a.ts"));
    files.set("src/b.ts", parseSource(`export class B {}\nimport { A } from "./a";`, "src/b.ts"));
    files.set("src/index.ts", parseSource(`export * from "./c";`, "src/index.ts"));
    files.set("src/c.ts", parseSource(`import { x } from "./index";`, "src/c.ts"));

    const graph = extractDependencyGraph(files, "test-repo", {
      detectCircular: true,
      suppressBarrelCycles: true,
    });

    // Real cycle survives
    const hasRealCycle = graph.circularDependencies.some(
      (c) => c.some((n) => n.includes("a.ts")) && c.some((n) => n.includes("b.ts")),
    );
    expect(hasRealCycle).toBe(true);

    // Barrel-mediated cycle is gone
    const hasBarrelCycle = graph.circularDependencies.some(
      (c) => c.some((n) => n.includes("index.ts")),
    );
    expect(hasBarrelCycle).toBe(false);
  });

  it("when suppressBarrelCycles is false (default), barrel-mediated cycles are still reported", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/index.ts", parseSource(`export * from "./a";`, "src/index.ts"));
    files.set("src/a.ts", parseSource(`import { x } from "./index";`, "src/a.ts"));

    const graph = extractDependencyGraph(files, "test-repo", { detectCircular: true });

    // Default behavior: barrel cycles are NOT suppressed
    expect(graph.circularDependencies.length).toBeGreaterThan(0);
  });
});

describe("importedNames metadata on dependency edges", () => {
  it("records named imports in edge metadata", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/app.ts", parseSource(
      `import { foo, bar } from "./module";`,
      "src/app.ts",
    ));
    files.set("src/module.ts", parseSource(`export const foo = 1; export const bar = 2;`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/app.ts");
    expect(edge).toBeDefined();
    expect(edge!.metadata!.importedNames).toEqual(["foo", "bar"]);
  });

  it("records default import as 'default' in metadata", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/app.ts", parseSource(
      `import foo from "./module";`,
      "src/app.ts",
    ));
    files.set("src/module.ts", parseSource(`export default function foo() {}`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/app.ts");
    expect(edge).toBeDefined();
    expect(edge!.metadata!.importedNames).toEqual(["default"]);
  });

  it("records namespace import as '*' in metadata", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/app.ts", parseSource(
      `import * as ns from "./module";`,
      "src/app.ts",
    ));
    files.set("src/module.ts", parseSource(`export const x = 1;`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/app.ts");
    expect(edge).toBeDefined();
    expect(edge!.metadata!.importedNames).toEqual(["*"]);
  });

  it("records mixed default+named import in metadata", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/app.ts", parseSource(
      `import def, { a, b } from "./module";`,
      "src/app.ts",
    ));
    files.set("src/module.ts", parseSource(`export const a = 1; export const b = 2;`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/app.ts");
    expect(edge).toBeDefined();
    expect(edge!.metadata!.importedNames).toEqual(["default", "a", "b"]);
  });

  it("omits importedNames for side-effect-only imports", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/app.ts", parseSource(
      `import "./module";`,
      "src/app.ts",
    ));
    files.set("src/module.ts", parseSource(`export const x = 1;`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/app.ts");
    expect(edge).toBeDefined();
    // Side-effect import has no imported names — key should be absent
    expect(edge!.metadata!.importedNames).toBeUndefined();
  });

  it("records named re-export names in metadata", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/index.ts", parseSource(
      `export { x } from "./module";`,
      "src/index.ts",
    ));
    files.set("src/module.ts", parseSource(`export const x = 1;`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/index.ts");
    expect(edge).toBeDefined();
    expect(edge!.metadata!.importedNames).toEqual(["x"]);
  });

  it("records '*' for star re-export in metadata", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/index.ts", parseSource(
      `export * from "./module";`,
      "src/index.ts",
    ));
    files.set("src/module.ts", parseSource(`export const x = 1;`, "src/module.ts"));

    const graph = extractDependencyGraph(files, "test-repo");
    const edge = graph.edges.find((e) => e.source === "test-repo:src/index.ts");
    expect(edge).toBeDefined();
    expect(edge!.metadata!.importedNames).toEqual(["*"]);
  });
});

describe("getBarrelPaths", () => {
  it("returns index.ts files that are pure barrel files", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/index.ts", parseSource(
      `export * from "./service";\nexport { Config } from "./config";`,
      "src/index.ts",
    ));
    files.set("src/service.ts", parseSource(`export class Service {}`, "src/service.ts"));
    files.set("src/config.ts", parseSource(`export interface Config { port: number; }`, "src/config.ts"));

    const barrels = getBarrelPaths(files);
    expect(barrels).toContain("src/index.ts");
  });

  it("excludes index.ts with local exports (not a pure barrel)", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/index.ts", parseSource(
      `export * from "./service";\nexport const version = "1.0";`,
      "src/index.ts",
    ));
    files.set("src/service.ts", parseSource(`export class Service {}`, "src/service.ts"));

    const barrels = getBarrelPaths(files);
    expect(barrels).not.toContain("src/index.ts");
  });

  it("excludes non-index files even if they only re-export", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/re-exports.ts", parseSource(
      `export * from "./service";`,
      "src/re-exports.ts",
    ));
    files.set("src/service.ts", parseSource(`export class Service {}`, "src/service.ts"));

    const barrels = getBarrelPaths(files);
    expect(barrels).not.toContain("src/re-exports.ts");
  });

  it("returns empty array when no barrel files exist", () => {
    const files = new Map<string, TreeSitterTree>();
    files.set("src/app.ts", parseSource(`import { x } from "./util";`, "src/app.ts"));
    files.set("src/util.ts", parseSource(`export const x = 1;`, "src/util.ts"));

    const barrels = getBarrelPaths(files);
    expect(barrels).toHaveLength(0);
  });
});
