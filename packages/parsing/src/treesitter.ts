/**
 * tree-sitter wrapper for fast incremental parsing.
 *
 * Uses web-tree-sitter (WASM-based) for cross-platform compatibility.
 * Loads TypeScript, TSX, and JavaScript grammars.
 */

import Parser from "web-tree-sitter";
import type { FileKind, ParseError, ParsedFile, SymbolInfo, SymbolKind } from "@mma/core";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Backward-compatible type aliases for @mma/structural
export type TreeSitterTree = Parser.Tree;
export type TreeSitterNode = Parser.SyntaxNode;

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(__dirname, "..", "wasm");

let initialized = false;
let initPromise: Promise<void> | undefined;
let tsGrammar: Parser.Language;
let tsxGrammar: Parser.Language;
let jsGrammar: Parser.Language;

export async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await Parser.init({
      locateFile(scriptName: string) {
        return join(wasmDir, scriptName);
      },
    });

    tsGrammar = await Parser.Language.load(join(wasmDir, "tree-sitter-typescript.wasm"));
    tsxGrammar = await Parser.Language.load(join(wasmDir, "tree-sitter-tsx.wasm"));
    jsGrammar = await Parser.Language.load(join(wasmDir, "tree-sitter-javascript.wasm"));

    initialized = true;
  })();

  return initPromise;
}

export function selectGrammar(filePath: string): Parser.Language {
  if (!initialized) {
    throw new Error("tree-sitter not initialized. Call initTreeSitter() first.");
  }
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "tsx":
    case "jsx":
      return tsxGrammar;
    case "ts":
    case "mts":
    case "cts":
      return tsGrammar;
    case "js":
    case "mjs":
    case "cjs":
      return jsGrammar;
    default:
      return tsGrammar;
  }
}

export function parseSource(content: string, filePath: string): Parser.Tree {
  const grammar = selectGrammar(filePath);
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(content);
  parser.delete();
  return tree;
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
  node: Parser.SyntaxNode,
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

  // Handle variable/const/let declarations specially (may contain arrow functions)
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const exported = isExported(node);
    for (const child of node.namedChildren) {
      if (child.type === "variable_declarator") {
        const name = child.childForFieldName("name")?.text ?? null;
        if (name) {
          const value = child.childForFieldName("value");
          const kind: SymbolKind =
            value?.type === "arrow_function" || value?.type === "function_expression"
              ? "function"
              : "variable";
          symbols.push({
            name,
            kind,
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            exported,
            containerName: container ?? undefined,
          });
        }
      }
    }
  } else {
    const symbolKind = nodeTypeToSymbolKind(node.type);
    if (symbolKind) {
      const name = extractName(node);
      if (name) {
        symbols.push({
          name,
          kind: symbolKind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported(node),
          containerName: container ?? undefined,
        });
      }
    }
  }

  const newContainer =
    node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "interface_declaration"
      ? (extractName(node) ?? container)
      : container;

  for (const child of node.namedChildren) {
    visitNode(child, newContainer, symbols, errors, filePath);
  }
}

function nodeTypeToSymbolKind(nodeType: string): SymbolKind | null {
  switch (nodeType) {
    case "function_declaration":
      return "function";
    case "class_declaration":
    case "abstract_class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "method_definition":
    case "abstract_method_signature":
      return "method";
    default:
      return null;
  }
}

function extractName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text ?? null;
}

function isExported(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === "export_statement" || false;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createParsedFile(
  filePath: string,
  repo: string,
  content: string,
  kind: FileKind,
  symbols: SymbolInfo[],
  errors: ParseError[],
): ParsedFile {
  return {
    path: filePath,
    repo,
    kind,
    symbols,
    errors,
    contentHash: hashContent(content),
  };
}
