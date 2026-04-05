/**
 * Tests for tree-sitter based call graph extraction.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import { extractCallEdgesFromTreeSitter, buildImportScopeFromAst } from "../src/index.js";
import type { TsNode, ImportBinding } from "../src/index.js";

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

  it("resolves imported bare function call to exporting file", () => {
    const source = `
import { fetchData } from "./api.ts";
function handler() {
  fetchData();
}
`;
    const tree = parseSource(source, "src/handler.ts");
    const importScope = buildImportScopeFromAst(
      tree.rootNode as unknown as TsNode,
      (specifier) => (specifier === "./api.ts" ? "src/api.ts" : undefined),
    );
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/handler.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:src/handler.ts#handler");
    // Should point to the exporting file, not the calling file
    expect(edges[0]!.target).toBe("test-repo:src/api.ts#fetchData");
  });

  it("resolves imported receiver object method call to exporting file", () => {
    const source = `
import { httpClient } from "./http.ts";
function run() {
  httpClient.get("/api");
}
`;
    const tree = parseSource(source, "src/run.ts");
    const importScope = buildImportScopeFromAst(
      tree.rootNode as unknown as TsNode,
      (specifier) => (specifier === "./http.ts" ? "src/http.ts" : undefined),
    );
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/run.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:src/run.ts#run");
    expect(edges[0]!.target).toBe("test-repo:src/http.ts#httpClient.get");
  });

  it("resolves aliased default import to exporting file", () => {
    const source = `
import axios from "./axios-client.ts";
function fetch() {
  axios.get("/data");
}
`;
    const tree = parseSource(source, "src/fetch.ts");
    const importScope = buildImportScopeFromAst(
      tree.rootNode as unknown as TsNode,
      (specifier) => (specifier === "./axios-client.ts" ? "src/axios-client.ts" : undefined),
    );
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/fetch.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    // Default import canonicalizes to "default" as exportedName
    expect(edges[0]!.target).toBe("test-repo:src/axios-client.ts#default.get");
  });

  it("falls back to current file for unimported bare calls", () => {
    const source = `
function doWork() {
  localHelper();
}
`;
    const tree = parseSource(source, "src/worker.ts");
    const importScope = new Map<string, ImportBinding>();
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/worker.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    // localHelper is not imported — should pin to current file
    expect(edges[0]!.target).toBe("test-repo:src/worker.ts#localHelper");
  });

  it("resolves aliased named import to exported name, not local alias", () => {
    const source = `
import { fetchData as load } from "./api.ts";
function handler() {
  load();
}
`;
    const tree = parseSource(source, "src/handler.ts");
    const importScope = buildImportScopeFromAst(
      tree.rootNode as unknown as TsNode,
      (specifier) => (specifier === "./api.ts" ? "src/api.ts" : undefined),
    );
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/handler.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:src/handler.ts#handler");
    // Must use original export name "fetchData", not the local alias "load"
    expect(edges[0]!.target).toBe("test-repo:src/api.ts#fetchData");
  });

  it("resolves namespace import method call by stripping namespace prefix", () => {
    const source = `
import * as api from "./api.ts";
function handler() {
  api.fetchData();
}
`;
    const tree = parseSource(source, "src/handler.ts");
    const importScope = buildImportScopeFromAst(
      tree.rootNode as unknown as TsNode,
      (specifier) => (specifier === "./api.ts" ? "src/api.ts" : undefined),
    );
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/handler.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:src/handler.ts#handler");
    // Namespace import: strip "api." prefix → target is fetchData, not api.fetchData
    expect(edges[0]!.target).toBe("test-repo:src/api.ts#fetchData");
  });

  it("does not resolve import when identifier is shadowed by a function parameter", () => {
    const source = `
import { client } from "./http.ts";
function f(client) {
  client.get("/api");
}
`;
    const tree = parseSource(source, "src/f.ts");
    const importScope = buildImportScopeFromAst(
      tree.rootNode as unknown as TsNode,
      (specifier) => (specifier === "./http.ts" ? "src/http.ts" : undefined),
    );
    const edges = extractCallEdgesFromTreeSitter(
      tree.rootNode as unknown as TsNode,
      "src/f.ts",
      "test-repo",
      importScope,
    );

    expect(edges).toHaveLength(1);
    // `client` is shadowed by the parameter — should NOT cross-file resolve
    expect(edges[0]!.target).not.toContain("src/http.ts");
    expect(edges[0]!.target).toBe("test-repo:#client.get");
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
