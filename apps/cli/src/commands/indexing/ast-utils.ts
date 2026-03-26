/**
 * AST utility functions used by phase-models (fault tree construction).
 */

import type { TreeSitterNode } from "@mma/parsing";
import type { ControlFlowGraph, SarifResult } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";

export interface FunctionNodeInfo {
  readonly name: string;
  readonly node: TreeSitterNode;
}

export function findFunctionNodes(rootNode: TreeSitterNode): FunctionNodeInfo[] {
  const results: FunctionNodeInfo[] = [];

  function walk(node: TreeSitterNode): void {
    if (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "method_definition"
    ) {
      const nameNode = node.namedChildren.find(
        (c) => c.type === "identifier" || c.type === "property_identifier",
      );
      const name = nameNode?.text ?? `anon_${node.startPosition.row}`;
      results.push({ name, node });
    } else if (node.type === "public_field_definition") {
      // Class arrow property: handler = async (req) => {}
      const arrowChild = node.namedChildren.find((c) => c.type === "arrow_function");
      if (arrowChild) {
        const nameNode = node.namedChildren.find(
          (c) => c.type === "property_identifier" || c.type === "identifier",
        );
        const name = nameNode?.text ?? `anon_${node.startPosition.row}`;
        results.push({ name, node: arrowChild });
      }
    } else if (node.type === "arrow_function") {
      // Arrow function names live in the parent variable_declarator, not the arrow_function itself
      let name = `anon_${node.startPosition.row}`;
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        const varName = parent.childForFieldName("name");
        if (varName) name = varName.text;
      } else if (parent?.type === "pair") {
        // Object property: { handler: (e) => ... }
        const key = parent.namedChildren.find((c) => c.type === "property_identifier" || c.type === "string");
        if (key) name = key.text;
      } else if (parent?.type === "export_statement") {
        // Exported default arrow: export default (req) => {}
        name = "default_export";
      }
      results.push({ name, node });
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(rootNode);
  return results;
}

export function detectMissingErrorBoundaries(
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const [functionId, cfg] of cfgs) {
    const hasAwait = cfg.nodes.some(n => n.kind === "statement" && /\bawait\b/.test(n.label));
    if (!hasAwait) continue;

    const hasTryCatch = cfg.nodes.some(n => n.kind === "catch" || n.kind === "try");
    if (hasTryCatch) continue;

    results.push(
      createSarifResult(
        "fault/missing-error-boundary",
        "warning",
        `Async function ${functionId} uses await but has no try/catch error boundary`,
        {
          locations: [{
            logicalLocations: [
              createLogicalLocation(repo, functionId.split("#")[0] ?? "", functionId),
            ],
          }],
        },
      ),
    );
  }

  return results;
}
