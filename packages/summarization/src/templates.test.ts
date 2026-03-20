import { describe, it, expect } from "vitest";
import { tier1Summarize, summarizeFromTemplate } from "./templates.js";
import type { SymbolInfo } from "@mma/core";

function sym(
  name: string,
  kind: SymbolInfo["kind"],
  startLine: number = 1,
  endLine: number = 5,
  containerName?: string,
): SymbolInfo {
  return { name, kind, startLine, endLine, exported: true, containerName };
}

describe("summarizeFromTemplate", () => {
  it("summarizes a function with params and return type", () => {
    const symbol = sym("getUser", "function");
    const source = "function getUser(id: string): Promise<User> {\n  // ...\n}";
    const summary = summarizeFromTemplate(symbol, "src/user.ts", source);

    expect(summary.entityId).toBe("src/user.ts#getUser");
    expect(summary.tier).toBe(1);
    expect(summary.description).toContain("id: string");
    expect(summary.description).toContain("Promise<User>");
    expect(summary.confidence).toBe(0.6);
  });

  it("summarizes a class", () => {
    const symbol = sym("UserService", "class", 1, 50);
    const source = "class UserService {\n}";
    const summary = summarizeFromTemplate(symbol, "src/svc.ts", source);

    expect(summary.description).toContain("Class UserService");
    expect(summary.description).toContain("1-50");
  });

  it("summarizes an interface", () => {
    const symbol = sym("IUser", "interface");
    const source = "interface IUser {}";
    const summary = summarizeFromTemplate(symbol, "src/types.ts", source);

    expect(summary.description).toBe("Interface IUser");
  });

  it("includes containerName in entityId", () => {
    const symbol = sym("fetch", "method", 1, 5, "ApiClient");
    const source = "fetch(url: string): Response {";
    const summary = summarizeFromTemplate(symbol, "src/api.ts", source);

    expect(summary.entityId).toBe("src/api.ts#ApiClient.fetch");
  });

  it("handles multi-line function signature", () => {
    const symbol = sym("processItems", "function");
    const source = [
      "async function processItems(",
      "  items: Item[],",
      "  options: ProcessOptions,",
      "): Promise<Result> {",
      "  // body",
      "}",
    ].join("\n");
    const summary = summarizeFromTemplate(symbol, "src/process.ts", source);

    expect(summary.description).toContain("items: Item[]");
    expect(summary.description).toContain("Promise<Result>");
  });

  it("extracts return type from arrow function without leaking body", () => {
    const symbol = sym("format", "function");
    const source = "const format = (x: number): string => x.toString();";
    const summary = summarizeFromTemplate(symbol, "src/format.ts", source);

    expect(summary.description).toContain("returns string");
    expect(summary.description).not.toContain("=>");
    expect(summary.description).not.toContain("toString");
  });

  it("extracts return type from multi-param arrow function", () => {
    const symbol = sym("add", "function");
    const source = "const add = (a: number, b: number): number => a + b;";
    const summary = summarizeFromTemplate(symbol, "src/math.ts", source);

    expect(summary.description).toContain("returns number");
    expect(summary.description).not.toContain("=>");
  });

  it("handles function with no params gracefully", () => {
    const symbol = sym("init", "function");
    const source = "function init(): void {";
    const summary = summarizeFromTemplate(symbol, "src/init.ts", source);

    expect(summary.description).toContain("returns void");
  });
});

describe("tier1Summarize", () => {
  it("summarizes functions, methods, and classes", () => {
    const symbols: SymbolInfo[] = [
      sym("getUser", "function"),
      sym("User", "class", 5, 20),
      sym("save", "method", 10, 15, "User"),
      sym("IUser", "interface"),      // included
      sym("MAX_RETRIES", "variable"), // skipped
    ];
    const source = [
      "function getUser(id: string): User {",
      "  // ...",
      "}",
      "",
      "class User {",
      "  // ...",
      "  save(): void {",
      "  }",
      "}",
      "// line 10",
      "// ...",
    ].join("\n");

    const summaries = tier1Summarize(symbols, "src/user.ts", source);
    // function + class + method + interface = 4 (skips variable)
    expect(summaries).toHaveLength(4);
    expect(summaries.every((s) => s.tier === 1)).toBe(true);
  });

  it("returns empty for files with no functions/classes", () => {
    const symbols: SymbolInfo[] = [
      sym("Config", "type"),
      sym("API_URL", "variable"),
    ];
    const summaries = tier1Summarize(symbols, "src/config.ts", "");
    expect(summaries).toHaveLength(0);
  });
});
