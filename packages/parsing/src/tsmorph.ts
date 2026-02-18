/**
 * ts-morph wrapper for TypeScript files needing type resolution.
 *
 * Slower than tree-sitter but provides full TypeScript type information.
 * Used when we need type-resolved call graphs and cross-file references.
 */

import {
  Project,
  ScriptTarget,
  ModuleKind,
} from "ts-morph";
import type {
  SourceFile,
  FunctionDeclaration,
  ClassDeclaration,
  MethodDeclaration,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  EnumDeclaration,
} from "ts-morph";
import type { ParsedFile, SymbolInfo } from "@mma/core";
import { hashContent } from "./treesitter.js";

// Backward-compatible type aliases
export type TsMorphProject = Project;
export type TsMorphSourceFile = SourceFile;
export type TsMorphFunction = FunctionDeclaration;
export type TsMorphClass = ClassDeclaration;
export type TsMorphMethod = MethodDeclaration;
export type TsMorphInterface = InterfaceDeclaration;
export type TsMorphTypeAlias = TypeAliasDeclaration;
export type TsMorphEnum = EnumDeclaration;
export type TsMorphDeclaration =
  | FunctionDeclaration
  | ClassDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | EnumDeclaration;

export interface CreateProjectOptions {
  readonly tsconfigPath?: string;
  readonly skipFileDependencyResolution?: boolean;
}

export function createTsMorphProject(options?: CreateProjectOptions): Project {
  if (options?.tsconfigPath) {
    return new Project({
      tsConfigFilePath: options.tsconfigPath,
      skipFileDependencyResolution: options.skipFileDependencyResolution ?? true,
    });
  }

  return new Project({
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      // JsxEmit.ReactJSX = 4 (not re-exported by ts-morph)
      jsx: 4 as never,
      allowJs: true,
      skipLibCheck: true,
      strict: false,
    },
    skipFileDependencyResolution: options?.skipFileDependencyResolution ?? true,
  });
}

export function extractSymbolsFromSourceFile(
  sourceFile: SourceFile,
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const exported = sourceFile.getExportedDeclarations();
  const exportedNames = new Set<string>();
  for (const [name] of exported) {
    exportedNames.add(name);
  }

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name) {
      symbols.push({
        name,
        kind: "function",
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        exported: exportedNames.has(name),
      });
    }
  }

  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (name) {
      symbols.push({
        name,
        kind: "class",
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        exported: exportedNames.has(name),
      });

      for (const method of cls.getMethods()) {
        symbols.push({
          name: method.getName(),
          kind: "method",
          startLine: method.getStartLineNumber(),
          endLine: method.getEndLineNumber(),
          exported: false,
          containerName: name,
        });
      }
    }
  }

  for (const iface of sourceFile.getInterfaces()) {
    symbols.push({
      name: iface.getName(),
      kind: "interface",
      startLine: iface.getStartLineNumber(),
      endLine: iface.getEndLineNumber(),
      exported: exportedNames.has(iface.getName()),
    });
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    symbols.push({
      name: typeAlias.getName(),
      kind: "type",
      startLine: typeAlias.getStartLineNumber(),
      endLine: typeAlias.getEndLineNumber(),
      exported: exportedNames.has(typeAlias.getName()),
    });
  }

  for (const enumDecl of sourceFile.getEnums()) {
    symbols.push({
      name: enumDecl.getName(),
      kind: "enum",
      startLine: enumDecl.getStartLineNumber(),
      endLine: enumDecl.getEndLineNumber(),
      exported: exportedNames.has(enumDecl.getName()),
    });
  }

  // Variable declarations (const/let/var with initializers)
  for (const varStmt of sourceFile.getVariableStatements()) {
    const isVarExported = varStmt.isExported();
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName();
      const initKind = decl.getInitializer()?.getKindName();
      const kind: SymbolInfo["kind"] =
        initKind === "ArrowFunction" || initKind === "FunctionExpression"
          ? "function"
          : "variable";
      symbols.push({
        name,
        kind,
        startLine: decl.getStartLineNumber(),
        endLine: decl.getEndLineNumber(),
        exported: isVarExported || exportedNames.has(name),
      });
    }
  }

  return symbols;
}

export function parseFileWithTsMorph(
  sourceFile: SourceFile,
  repo: string,
): ParsedFile {
  const content = sourceFile.getFullText();
  const symbols = extractSymbolsFromSourceFile(sourceFile);

  return {
    path: sourceFile.getFilePath(),
    repo,
    kind: "typescript",
    symbols,
    errors: [],
    contentHash: hashContent(content),
  };
}
