/**
 * Heritage graph extraction — extends and implements edges.
 *
 * Walks tree-sitter ASTs to find class declarations and extract
 * the classes/interfaces they extend or implement.
 */

import type { GraphEdge } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

/**
 * Extract extends/implements edges from a set of tree-sitter trees.
 *
 * For each file, walks the AST looking for class_declaration and
 * abstract_class_declaration nodes. Emits one "extends" edge per
 * extends_clause and one "implements" edge per name in the
 * implements_clause.
 *
 * Edge source: `${filePath}:${className}`
 * Edge target: the raw name being extended/implemented (may be unqualified)
 */
export function extractHeritageEdges(
  trees: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const [filePath, tree] of trees) {
    extractFromNode(tree.rootNode, filePath, repo, edges);
  }

  return edges;
}

function extractFromNode(
  rootNode: TreeSitterNode,
  filePath: string,
  repo: string,
  edges: GraphEdge[],
): void {
  function walk(node: TreeSitterNode): void {
    if (
      node.type === "class_declaration" ||
      node.type === "abstract_class_declaration"
    ) {
      const nameNode = node.namedChildren.find(
        (c) => c.type === "type_identifier" || c.type === "identifier",
      );
      if (nameNode) {
        const className = nameNode.text;
        const source = `${filePath}:${className}`;

        // extends_clause and implements_clause are nested under class_heritage
        const heritage = node.namedChildren.find(
          (c) => c.type === "class_heritage",
        );
        const clauseParent = heritage ?? node;

        for (const child of clauseParent.namedChildren) {
          if (child.type === "extends_clause") {
            // extends_clause contains identifier or type_identifier for the base class
            for (const typeNode of child.namedChildren) {
              if (
                typeNode.type === "type_identifier" ||
                typeNode.type === "identifier"
              ) {
                edges.push({
                  source,
                  target: typeNode.text,
                  kind: "extends",
                  repo,
                  metadata: { repo, file: filePath },
                });
                // Only one base class per extends clause
                break;
              }
            }
          } else if (child.type === "implements_clause") {
            // implements_clause can list multiple type_identifier names
            for (const typeNode of child.namedChildren) {
              if (
                typeNode.type === "type_identifier" ||
                typeNode.type === "identifier"
              ) {
                edges.push({
                  source,
                  target: typeNode.text,
                  kind: "implements",
                  repo,
                  metadata: { repo, file: filePath },
                });
              }
            }
          }
        }
      }
    }

    // Recurse into all named children so nested class declarations are found
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(rootNode);
}
