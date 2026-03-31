/**
 * Tests for tree-sitter based call graph extraction.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import { extractCallEdgesFromTreeSitter } from "../src/index.js";
import type { TsNode } from "../src/index.js";

beforeAll(async () => {
  await initTreeSitter();
}, 15_000);

describe("extractCallEdgesFromTreeSitter", () => {
  it("extracts a simple function-to-function call", () => {
    const source = `
function foo() {
  bar();
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:test.ts#foo");
    // Identifier calls now use makeSymbolId with the calling file as best-guess location
    expect(edges[0]!.target).toBe("test-repo:test.ts#bar");
    expect(edges[0]!.kind).toBe("calls");
    expect(edges[0]!.metadata?.["repo"]).toBe("test-repo");
  });

  it("resolves this.method() to ClassName.method", () => {
    const source = `
class MyClass {
  foo() {
    this.bar();
  }
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:test.ts#MyClass.foo");
    expect(edges[0]!.target).toBe("test-repo:test.ts#MyClass.bar");
  });

  it("extracts calls from arrow functions", () => {
    const source = `
const handler = () => {
  doSomething();
};
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:test.ts#handler");
    expect(edges[0]!.target).toBe("test-repo:test.ts#doSomething");
  });

  it("extracts multiple calls from the same function", () => {
    const source = `
function a() {
  b();
  c();
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.target).sort();
    expect(targets).toEqual(["test-repo:test.ts#b", "test-repo:test.ts#c"]);
  });

  it("does not produce edges for new expressions", () => {
    const source = `
function create() {
  const x = new Foo();
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    // new Foo() is a new_expression, not a call_expression
    expect(edges).toHaveLength(0);
  });

  it("resolves member expression calls (obj.method)", () => {
    const source = `
function run() {
  console.log("hello");
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    expect(edges).toHaveLength(1);
    // obj.method() calls use makeSymbolId with empty filePath (receiver file unknown)
    expect(edges[0]!.target).toBe("test-repo:#console.log");
  });

  it("resolves this.client.fetch() chain via resolveMemberChain", () => {
    const source = `
class ApiService {
  fetch() {
    this.client.fetch("/api/data");
  }
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    expect(edges).toHaveLength(1);
    // this.client.fetch() — object is "this" but there's an intermediate
    // member_expression (this.client), so resolveMemberChain is used and the
    // receiver file is unknown → makeSymbolId with empty filePath.
    expect(edges[0]!.target).toBe("test-repo:#this.client.fetch");
    expect(edges[0]!.source).toBe("test-repo:test.ts#ApiService.fetch");
  });

  it("does not attribute nested function calls to the outer function", () => {
    const source = `
function outer() {
  a();
  function inner() {
    b();
  }
}
`;
    const tree = parseSource(source, "test.ts");
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "test.ts",
      "test-repo",
    );

    // outer calls a(), inner calls b() -- each attributed to its own function
    const outerEdges = edges.filter((e) => e.source === "test-repo:test.ts#outer");
    const innerEdges = edges.filter((e) => e.source === "test-repo:test.ts#inner");
    expect(outerEdges).toHaveLength(1);
    expect(outerEdges[0]!.target).toBe("test-repo:test.ts#a");
    expect(innerEdges).toHaveLength(1);
    expect(innerEdges[0]!.target).toBe("test-repo:test.ts#b");
  });
});
