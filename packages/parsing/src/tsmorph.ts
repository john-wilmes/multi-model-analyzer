/**
 * ts-morph wrapper for TypeScript files needing type resolution.
 *
 * Slower than tree-sitter but provides full TypeScript type information.
 * Used when we need type-resolved call graphs and cross-file references.
 *
 * External dependency: ts-morph
 */

import type { ParsedFile, SymbolInfo } from "@mma/core";
import { hashContent } from "./treesitter.js";

// ts-morph facade -- actual imports added when dep is installed
export interface TsMorphProject {
  addSourceFilesAtPaths(globs: string[]): TsMorphSourceFile[];
  getSourceFiles(): TsMorphSourceFile[];
  getSourceFile(filePath: string): TsMorphSourceFile | undefined;
}

export interface TsMorphSourceFile {
  getFilePath(): string;
  getFunctions(): TsMorphFunction[];
  getClasses(): TsMorphClass[];
  getInterfaces(): TsMorphInterface[];
  getTypeAliases(): TsMorphTypeAlias[];
  getEnums(): TsMorphEnum[];
  getExportedDeclarations(): Map<string, TsMorphDeclaration[]>;
  getFullText(): string;
}

export interface TsMorphFunction {
  getName(): string | undefined;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
  isExported(): boolean;
}

export interface TsMorphClass {
  getName(): string | undefined;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
  isExported(): boolean;
  getMethods(): TsMorphMethod[];
}

export interface TsMorphMethod {
  getName(): string;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
}

export interface TsMorphInterface {
  getName(): string;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
  isExported(): boolean;
}

export interface TsMorphTypeAlias {
  getName(): string;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
  isExported(): boolean;
}

export interface TsMorphEnum {
  getName(): string;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
  isExported(): boolean;
}

export type TsMorphDeclaration =
  | TsMorphFunction
  | TsMorphClass
  | TsMorphInterface
  | TsMorphTypeAlias
  | TsMorphEnum;

export function extractSymbolsFromSourceFile(
  sourceFile: TsMorphSourceFile,
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

  return symbols;
}

export function parseFileWithTsMorph(
  sourceFile: TsMorphSourceFile,
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
