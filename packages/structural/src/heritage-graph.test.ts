/**
 * Tests for heritage graph extraction (extends / implements edges).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import { extractHeritageEdges } from "./heritage-graph.js";
import type { TreeSitterTree } from "@mma/parsing";

beforeAll(async () => {
  await initTreeSitter();
}, 15_000);

function makeTrees(entries: Array<[string, string]>): ReadonlyMap<string, TreeSitterTree> {
  const map = new Map<string, TreeSitterTree>();
  for (const [filePath, source] of entries) {
    map.set(filePath, parseSource(source, filePath));
  }
  return map;
}

describe("extractHeritageEdges", () => {
  it("extracts an extends edge for a simple class", () => {
    const trees = makeTrees([["animal.ts", `class Dog extends Animal {}`]]);
    const edges = extractHeritageEdges(trees, "test-repo");

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:animal.ts#Dog");
    expect(edges[0]!.target).toBe("Animal");
    expect(edges[0]!.kind).toBe("extends");
    expect(edges[0]!.metadata?.["repo"]).toBe("test-repo");
    expect(edges[0]!.metadata?.["file"]).toBe("animal.ts");
  });

  it("extracts an implements edge for a class implementing one interface", () => {
    const trees = makeTrees([
      ["user-service.ts", `class UserService implements IUserService {}`],
    ]);
    const edges = extractHeritageEdges(trees, "test-repo");

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:user-service.ts#UserService");
    expect(edges[0]!.target).toBe("IUserService");
    expect(edges[0]!.kind).toBe("implements");
  });

  it("extracts both extends and implements edges", () => {
    const trees = makeTrees([
      ["foo.ts", `class Foo extends Bar implements Baz {}`],
    ]);
    const edges = extractHeritageEdges(trees, "test-repo");

    expect(edges).toHaveLength(2);

    const extendsEdge = edges.find((e) => e.kind === "extends");
    expect(extendsEdge?.source).toBe("test-repo:foo.ts#Foo");
    expect(extendsEdge?.target).toBe("Bar");

    const implementsEdge = edges.find((e) => e.kind === "implements");
    expect(implementsEdge?.source).toBe("test-repo:foo.ts#Foo");
    expect(implementsEdge?.target).toBe("Baz");
  });

  it("extracts multiple implements edges when a class implements several interfaces", () => {
    const trees = makeTrees([
      ["foo.ts", `class Foo extends Bar implements Baz, Qux {}`],
    ]);
    const edges = extractHeritageEdges(trees, "test-repo");

    const implementsEdges = edges.filter((e) => e.kind === "implements");
    expect(implementsEdges).toHaveLength(2);
    const targets = implementsEdges.map((e) => e.target).sort();
    expect(targets).toEqual(["Baz", "Qux"]);
  });

  it("extracts extends edge from an abstract class", () => {
    const trees = makeTrees([
      ["cmd.ts", `export abstract class BaseCmd extends Command {}`],
    ]);
    const edges = extractHeritageEdges(trees, "test-repo");

    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("test-repo:cmd.ts#BaseCmd");
    expect(edges[0]!.target).toBe("Command");
    expect(edges[0]!.kind).toBe("extends");
  });

  it("produces no edges for a plain class with no heritage", () => {
    const trees = makeTrees([["plain.ts", `class Plain { foo() {} }`]]);
    const edges = extractHeritageEdges(trees, "test-repo");
    expect(edges).toHaveLength(0);
  });

  it("extracts edges from multiple classes in a single file", () => {
    const source = `
class Alpha extends Base {}
class Beta implements IService {}
class Gamma {}
`;
    const trees = makeTrees([["multi.ts", source]]);
    const edges = extractHeritageEdges(trees, "test-repo");

    expect(edges).toHaveLength(2);

    const alpha = edges.find((e) => e.source === "test-repo:multi.ts#Alpha");
    expect(alpha?.kind).toBe("extends");
    expect(alpha?.target).toBe("Base");

    const beta = edges.find((e) => e.source === "test-repo:multi.ts#Beta");
    expect(beta?.kind).toBe("implements");
    expect(beta?.target).toBe("IService");
  });

  it("extracts edges from multiple files", () => {
    const trees = makeTrees([
      ["a.ts", `class A extends B {}`],
      ["c.ts", `class C implements D {}`],
    ]);
    const edges = extractHeritageEdges(trees, "test-repo");

    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.source === "test-repo:a.ts#A")?.kind).toBe("extends");
    expect(edges.find((e) => e.source === "test-repo:c.ts#C")?.kind).toBe("implements");
  });

  it("returns empty for an empty file map", () => {
    const edges = extractHeritageEdges(new Map(), "test-repo");
    expect(edges).toHaveLength(0);
  });

  it("edge source uses repo-prefixed canonical ID matching deleteEdgesForFiles cleanup pattern", () => {
    // deleteEdgesForFiles matches sources starting with `${repo}:${filePath}#`
    // Heritage edge sources must use makeSymbolId(repo, filePath, className)
    // which produces `repo:filePath#className`.
    const trees = makeTrees([["src/service.ts", `class MyService extends BaseService {}`]]);
    const edges = extractHeritageEdges(trees, "my-repo");

    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    // Must start with `my-repo:src/service.ts#` for deleteEdgesForFiles to clean it up
    expect(edge.source).toBe("my-repo:src/service.ts#MyService");
    expect(edge.source.startsWith("my-repo:src/service.ts#")).toBe(true);
  });
});
