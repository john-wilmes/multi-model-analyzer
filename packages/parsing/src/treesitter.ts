/**
 * tree-sitter wrapper for fast incremental parsing.
 *
 * tree-sitter provides sub-5ms reparse on changed ranges.
 * This module wraps the tree-sitter API to produce our ParsedFile type.
 *
 * External dependency: tree-sitter + tree-sitter-typescript
 * These will be installed when we wire up the POC.
 */

import type { ParseError, ParsedFile, SymbolInfo, SymbolKind } from "@mma/core";
import { createHash } from "node:crypto";

// tree-sitter types (will be replaced with actual imports when deps installed)
export interface TreeSitterTree {
  readonly rootNode: TreeSitterNode;
}

export interface TreeSitterNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly childCount: number;
  readonly children: readonly TreeSitterNode[];
  readonly namedChildren: readonly TreeSitterNode[];
  readonly isNamed: boolean;
  readonly hasError: boolean;
}

export interface TreeSitterParser {
  parse(input: string, oldTree?: TreeSitterTree): TreeSitterTree;
  setLanguage(language: unknown): void;
}

export function extractSymbolsFromTree(
  tree: TreeSitterTree,
  filePath: string,
  _repo: string,
): { symbols: SymbolInfo[]; errors: ParseError[] } {
  const symbols: SymbolInfo[] = [];
  const errors: ParseError[] = [];

  visitNode(tree.rootNode, null, symbols, errors, filePath);

  return { symbols, errors };
}

function visitNode(
  node: TreeSitterNode,
  container: string | null,
  symbols: SymbolInfo[],
  errors: ParseError[],
  filePath: string,
): void {
  if (node.hasError && node.type === "ERROR") {
    errors.push({
      message: `Syntax error at ${node.startPosition.row}:${node.startPosition.column}`,
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      filePath,
    });
  }

  const symbolKind = nodeTypeToSymbolKind(node.type);
  if (symbolKind) {
    const name = extractName(node);
    if (name) {
      const exported = isExported(node);
      symbols.push({
        name,
        kind: symbolKind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        exported,
        containerName: container ?? undefined,
      });
    }
  }

  const newContainer = symbolKind ? extractName(node) ?? container : container;
  for (const child of node.namedChildren) {
    visitNode(child, newContainer, symbols, errors, filePath);
  }
}

function nodeTypeToSymbolKind(nodeType: string): SymbolKind | null {
  switch (nodeType) {
    case "function_declaration":
    case "arrow_function":
      return "function";
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "method_definition":
      return "method";
    case "lexical_declaration":
    case "variable_declaration":
      return "variable";
    default:
      return null;
  }
}

function extractName(node: TreeSitterNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "type_identifier") {
      return child.text;
    }
  }
  return null;
}

function isExported(_node: TreeSitterNode): boolean {
  // In tree-sitter-typescript, exported declarations are wrapped in
  // export_statement nodes
  return false; // simplified -- full impl checks parent node
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createParsedFile(
  filePath: string,
  repo: string,
  content: string,
  symbols: SymbolInfo[],
  errors: ParseError[],
): ParsedFile {
  return {
    path: filePath,
    repo,
    kind: filePath.endsWith(".ts") || filePath.endsWith(".tsx")
      ? "typescript"
      : "javascript",
    symbols,
    errors,
    contentHash: hashContent(content),
  };
}
