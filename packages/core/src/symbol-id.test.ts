import { describe, it, expect } from "vitest";
import {
  makeSymbolId,
  makeFileId,
  parseSymbolId,
  extractRepo,
  canonicalize,
} from "./symbol-id.js";

describe("makeSymbolId", () => {
  it("creates a canonical symbol-level ID", () => {
    expect(makeSymbolId("nestjs-core", "src/auth.ts", "AuthService.validate"))
      .toBe("nestjs-core:src/auth.ts#AuthService.validate");
  });

  it("creates a file-level ID when symbolName is omitted", () => {
    expect(makeSymbolId("my-app", "src/index.ts"))
      .toBe("my-app:src/index.ts");
  });

  it("handles repos with special characters", () => {
    expect(makeSymbolId("@org/auth", "src/index.ts", "login"))
      .toBe("@org/auth:src/index.ts#login");
  });
});

describe("makeFileId", () => {
  it("creates a canonical file-level ID", () => {
    expect(makeFileId("my-app", "src/utils.ts"))
      .toBe("my-app:src/utils.ts");
  });
});

describe("parseSymbolId", () => {
  it("parses a canonical symbol-level ID", () => {
    const result = parseSymbolId("nestjs-core:src/auth.ts#AuthService.validate");
    expect(result).toEqual({
      repo: "nestjs-core",
      filePath: "src/auth.ts",
      symbolName: "AuthService.validate",
      isCanonical: true,
    });
  });

  it("parses a canonical file-level ID", () => {
    const result = parseSymbolId("my-app:src/index.ts");
    expect(result).toEqual({
      repo: "my-app",
      filePath: "src/index.ts",
      symbolName: undefined,
      isCanonical: true,
    });
  });

  it("parses an old-format symbol ID (no repo)", () => {
    const result = parseSymbolId("src/auth.ts#AuthService.validate");
    expect(result).toEqual({
      repo: undefined,
      filePath: "src/auth.ts",
      symbolName: "AuthService.validate",
      isCanonical: false,
    });
  });

  it("parses an old-format file ID (no repo)", () => {
    const result = parseSymbolId("src/index.ts");
    expect(result).toEqual({
      repo: undefined,
      filePath: "src/index.ts",
      symbolName: undefined,
      isCanonical: false,
    });
  });

  it("parses an external specifier (no colon)", () => {
    const result = parseSymbolId("@org/auth");
    expect(result).toEqual({
      repo: undefined,
      filePath: "@org/auth",
      symbolName: undefined,
      isCanonical: false,
    });
  });

  it("handles scoped repo names with colon", () => {
    const result = parseSymbolId("@org/auth:src/index.ts#login");
    expect(result).toEqual({
      repo: "@org/auth",
      filePath: "src/index.ts",
      symbolName: "login",
      isCanonical: true,
    });
  });
});

describe("extractRepo", () => {
  it("extracts repo from canonical ID", () => {
    expect(extractRepo("nestjs-core:src/auth.ts#AuthService")).toBe("nestjs-core");
  });

  it("returns undefined for non-canonical ID", () => {
    expect(extractRepo("src/auth.ts#AuthService")).toBeUndefined();
  });

  it("returns undefined for external specifier", () => {
    expect(extractRepo("@org/auth")).toBeUndefined();
  });

  it("extracts scoped repo name", () => {
    expect(extractRepo("@org/auth:src/index.ts")).toBe("@org/auth");
  });
});

describe("canonicalize", () => {
  it("converts old-format to canonical", () => {
    expect(canonicalize("src/auth.ts#AuthService", "nestjs-core"))
      .toBe("nestjs-core:src/auth.ts#AuthService");
  });

  it("leaves canonical IDs unchanged", () => {
    expect(canonicalize("nestjs-core:src/auth.ts#AuthService", "other-repo"))
      .toBe("nestjs-core:src/auth.ts#AuthService");
  });

  it("converts file-level old-format", () => {
    expect(canonicalize("src/index.ts", "my-app"))
      .toBe("my-app:src/index.ts");
  });
});
