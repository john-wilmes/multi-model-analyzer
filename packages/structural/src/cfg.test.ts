import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import { buildControlFlowGraph, createCfgIdCounter, traceBackward } from "./cfg.js";
import type Parser from "web-tree-sitter";

// Helper: parse code and extract the first function body node
function getFunctionNode(tree: Parser.Tree): Parser.SyntaxNode {
  function find(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "arrow_function"
    ) {
      return node;
    }
    for (const child of node.namedChildren) {
      const result = find(child);
      if (result) return result;
    }
    return null;
  }
  const fn = find(tree.rootNode);
  if (!fn) throw new Error("No function found in code");
  return fn;
}

describe("buildControlFlowGraph", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("creates entry and exit nodes for a simple function", () => {
    const code = `function foo() { const x = 1; }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "foo", "repo", "mod.ts", counter);
    tree.delete();

    expect(cfg.functionId).toBe("foo");
    const entry = cfg.nodes.find((n) => n.kind === "entry");
    const exit = cfg.nodes.find((n) => n.kind === "exit");
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    // entry -> statement -> exit
    expect(cfg.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("handles if/else branching", () => {
    const code = `function check(x: number) {
      if (x > 0) {
        console.log("positive");
      } else {
        console.log("non-positive");
      }
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "check", "repo", "mod.ts", counter);
    tree.delete();

    const branches = cfg.nodes.filter((n) => n.kind === "branch");
    expect(branches.length).toBe(1);
    // Branch node should have at least 2 outgoing edges (then + else)
    const branchEdges = cfg.edges.filter((e) => e.from === branches[0]!.id);
    expect(branchEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("handles loops with back edges", () => {
    const code = `function loop() {
      for (let i = 0; i < 10; i++) {
        doWork(i);
      }
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "loop", "repo", "mod.ts", counter);
    tree.delete();

    const loops = cfg.nodes.filter((n) => n.kind === "loop");
    expect(loops.length).toBe(1);
    // Back edge: some edge points back to the loop node
    const backEdges = cfg.edges.filter((e) => e.to === loops[0]!.id);
    expect(backEdges.length).toBeGreaterThanOrEqual(2); // entry + back edge
  });

  it("handles early return", () => {
    const code = `function guard(x: number) {
      if (x < 0) {
        return -1;
      }
      return x;
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "guard", "repo", "mod.ts", counter);
    tree.delete();

    const returns = cfg.nodes.filter((n) => n.kind === "return");
    expect(returns.length).toBe(2);
    const exit = cfg.nodes.find((n) => n.kind === "exit");
    // Both return nodes should have edges to exit
    for (const ret of returns) {
      const toExit = cfg.edges.some((e) => e.from === ret.id && e.to === exit!.id);
      expect(toExit).toBe(true);
    }
  });

  it("handles try/catch", () => {
    const code = `function risky() {
      try {
        dangerousOp();
      } catch (e) {
        console.error(e);
      }
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "risky", "repo", "mod.ts", counter);
    tree.delete();

    const tryNodes = cfg.nodes.filter((n) => n.kind === "try");
    const catchNodes = cfg.nodes.filter((n) => n.kind === "catch");
    expect(tryNodes.length).toBe(1);
    expect(catchNodes.length).toBe(1);
    // Exception edge from try to catch
    const exceptionEdge = cfg.edges.find(
      (e) => e.from === tryNodes[0]!.id && e.to === catchNodes[0]!.id,
    );
    expect(exceptionEdge).toBeDefined();
    expect(exceptionEdge!.condition).toBe("exception");
  });

  it("handles while loop", () => {
    const code = `function wait() {
      while (isRunning()) {
        poll();
      }
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "wait", "repo", "mod.ts", counter);
    tree.delete();

    const loops = cfg.nodes.filter((n) => n.kind === "loop");
    expect(loops.length).toBe(1);
  });

  it("handles throw statement", () => {
    const code = `function fail() {
      throw new Error("boom");
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "fail", "repo", "mod.ts", counter);
    tree.delete();

    const throws = cfg.nodes.filter((n) => n.kind === "throw");
    expect(throws.length).toBe(1);
  });
});

describe("traceBackward", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("traces from exit back to entry", () => {
    const code = `function simple() { const x = 1; }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "simple", "repo", "mod.ts", counter);
    tree.delete();

    const exit = cfg.nodes.find((n) => n.kind === "exit")!;
    const entry = cfg.nodes.find((n) => n.kind === "entry")!;
    const path = traceBackward(cfg, exit.id);
    expect(path).toContain(exit.id);
    expect(path).toContain(entry.id);
  });

  it("traces through branches", () => {
    const code = `function branching(x: boolean) {
      if (x) { doA(); } else { doB(); }
    }`;
    const tree = parseSource(code, "test.ts");
    const fn = getFunctionNode(tree);
    const counter = createCfgIdCounter();
    const cfg = buildControlFlowGraph(fn, "branching", "repo", "mod.ts", counter);
    tree.delete();

    const exit = cfg.nodes.find((n) => n.kind === "exit")!;
    const path = traceBackward(cfg, exit.id);
    // Should reach entry through both branches
    const entry = cfg.nodes.find((n) => n.kind === "entry")!;
    expect(path).toContain(entry.id);
    // Should visit at least entry + branch + 2 statements + exit = 5 nodes
    expect(path.length).toBeGreaterThanOrEqual(4);
  });
});
