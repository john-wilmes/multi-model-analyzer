import { describe, it, expect } from "vitest";
import { splitIdentifier, analyzeNaming } from "./naming.js";
import type { SymbolInfo } from "@mma/core";

describe("splitIdentifier", () => {
  it("splits camelCase", () => {
    expect(splitIdentifier("getUserById")).toEqual(["get", "User", "By", "Id"]);
  });

  it("splits PascalCase", () => {
    expect(splitIdentifier("UserService")).toEqual(["User", "Service"]);
  });

  it("splits snake_case", () => {
    expect(splitIdentifier("get_user_by_id")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits kebab-case", () => {
    expect(splitIdentifier("get-user-by-id")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits consecutive uppercase (acronyms)", () => {
    expect(splitIdentifier("parseHTMLDocument")).toEqual(["parse", "HTML", "Document"]);
  });

  it("returns single word as-is", () => {
    expect(splitIdentifier("fetch")).toEqual(["fetch"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitIdentifier("")).toEqual([]);
  });

  it("handles mixed separators", () => {
    expect(splitIdentifier("get_userById")).toEqual(["get", "user", "By", "Id"]);
  });
});

describe("analyzeNaming", () => {
  function sym(name: string, kind: SymbolInfo["kind"] = "function", containerName?: string): SymbolInfo {
    return { name, kind, startLine: 1, endLine: 5, exported: true, containerName };
  }

  it("identifies verb-object pattern", () => {
    const files = new Map<string, readonly SymbolInfo[]>([
      ["src/user.ts", [sym("getUser")]],
    ]);
    const result = analyzeNaming(files, "test-repo");
    expect(result.repo).toBe("test-repo");
    expect(result.methods).toHaveLength(1);
    expect(result.methods[0]!.verb).toBe("get");
    expect(result.methods[0]!.object).toBe("user");
    expect(result.methods[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("identifies predicate pattern (isValid)", () => {
    const files = new Map([["src/check.ts", [sym("isValid")]]]);
    const result = analyzeNaming(files, "repo");
    expect(result.methods).toHaveLength(1);
    // Predicate pattern takes priority over generic ACTION_VERBS
    expect(result.methods[0]!.verb).toBe("check");
    expect(result.methods[0]!.object).toBe("valid");
    expect(result.methods[0]!.purpose).toContain("Checks whether");
  });

  it("identifies event handler pattern (handleClick)", () => {
    const files = new Map([["src/ui.ts", [sym("handleClick")]]]);
    const result = analyzeNaming(files, "repo");
    expect(result.methods).toHaveLength(1);
    // Event handler pattern takes priority over generic ACTION_VERBS
    expect(result.methods[0]!.verb).toBe("handle");
    expect(result.methods[0]!.object).toBe("click event");
  });

  it("identifies event handler pattern (onSubmit)", () => {
    const files = new Map([["src/form.ts", [sym("onSubmit")]]]);
    const result = analyzeNaming(files, "repo");
    expect(result.methods).toHaveLength(1);
    expect(result.methods[0]!.verb).toBe("handle");
    expect(result.methods[0]!.object).toBe("submit event");
  });

  it("skips non-function symbols", () => {
    const files = new Map([
      ["src/model.ts", [sym("User", "class"), sym("getName")]],
    ]);
    const result = analyzeNaming(files, "repo");
    expect(result.methods).toHaveLength(1);
    expect(result.methods[0]!.methodId).toContain("getName");
  });

  it("includes containerName in methodId when present", () => {
    const files = new Map([
      ["src/svc.ts", [sym("fetchData", "method", "ApiService")]],
    ]);
    const result = analyzeNaming(files, "repo");
    expect(result.methods[0]!.methodId).toBe("src/svc.ts#ApiService.fetchData");
  });

  it("returns empty methods for single-word noun identifiers", () => {
    const files = new Map([["src/x.ts", [sym("x")]]]);
    const result = analyzeNaming(files, "repo");
    // Single-word non-verb identifier returns null from inferPurpose
    expect(result.methods).toHaveLength(0);
  });
});
