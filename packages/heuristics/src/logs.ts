/**
 * Log statement classification using Drain log parsing algorithm.
 *
 * Drain: An online log parsing approach with fixed depth tree.
 * Extracts log templates from log statements in source code,
 * classifies by severity, and builds a template index.
 */

import type { LogSeverity, LogTemplate, LogTemplateIndex, LogicalLocation } from "@mma/core";
import type { TreeSitterNode, TreeSitterTree } from "@mma/parsing";

export interface DrainOptions {
  readonly depth: number;
  readonly similarityThreshold: number;
  readonly maxChildren: number;
}

const DEFAULT_DRAIN_OPTIONS: DrainOptions = {
  depth: 4,
  similarityThreshold: 0.5,
  maxChildren: 100,
};

interface DrainCluster {
  id: string;
  template: string[];
  logIds: string[];
}

export function extractLogStatements(
  files: ReadonlyMap<string, TreeSitterTree>,
  repo: string,
): LogTemplateIndex {
  const rawLogs: Array<{
    text: string;
    severity: LogSeverity;
    location: LogicalLocation;
  }> = [];

  for (const [filePath, tree] of files) {
    const logs = findLogCalls(tree.rootNode, filePath, repo);
    rawLogs.push(...logs);
  }

  const clusters = drainParse(
    rawLogs.map((l) => l.text),
    DEFAULT_DRAIN_OPTIONS,
  );

  const templates: LogTemplate[] = clusters.map((cluster, i) => {
    const matchingLogs = cluster.logIds.map(
      (id) => rawLogs[parseInt(id)]!,
    );
    const severity = matchingLogs[0]?.severity ?? "info";
    const locations = matchingLogs.map((l) => l.location);

    return {
      id: `log-template-${i}`,
      template: cluster.template.join(" "),
      severity,
      locations,
      frequency: matchingLogs.length,
    };
  });

  return { repo, templates };
}

function findLogCalls(
  node: TreeSitterNode,
  filePath: string,
  repo: string,
): Array<{ text: string; severity: LogSeverity; location: LogicalLocation }> {
  const results: Array<{
    text: string;
    severity: LogSeverity;
    location: LogicalLocation;
  }> = [];

  visitAll(node, (n) => {
    if (n.type === "call_expression") {
      const callee = n.namedChildren[0];
      if (!callee) return;

      const callText = callee.text;
      const severity = inferSeverity(callText);
      if (severity === null) return;

      const args = n.namedChildren.find((c) => c.type === "arguments");
      const logText = args ? extractLogText(args) : n.text;

      results.push({
        text: logText,
        severity,
        location: {
          repo,
          module: filePath,
          fullyQualifiedName: `${filePath}:${n.startPosition.row + 1}`,
        },
      });
    }
  });

  return results;
}

function inferSeverity(callText: string): LogSeverity | null {
  // Generic patterns cover both console.X and logger.X forms
  if (/\.(error|fatal)\s*$/.test(callText)) return "error";
  if (/\.(warn|warning)\s*$/.test(callText)) return "warn";
  if (/\.(info|log)\s*$/.test(callText)) return "info";
  if (/\.(debug|trace|verbose)\s*$/.test(callText)) return "debug";
  return null;
}

function extractLogText(argsNode: TreeSitterNode): string {
  const parts: string[] = [];
  for (const child of argsNode.namedChildren) {
    if (child.type === "string" || child.type === "template_string") {
      parts.push(child.text.replace(/['"`]/g, ""));
    } else {
      parts.push("<*>");
    }
  }
  return parts.join(" ");
}

/**
 * Simplified Drain log parsing algorithm.
 *
 * Full Drain uses a fixed-depth prefix tree for O(1) cluster lookup.
 * This simplified version uses sequential comparison (sufficient for POC).
 */
function drainParse(
  logMessages: readonly string[],
  options: DrainOptions,
): DrainCluster[] {
  const clusters: DrainCluster[] = [];

  for (let i = 0; i < logMessages.length; i++) {
    const tokens = tokenize(logMessages[i]!);
    let matched = false;

    for (const cluster of clusters) {
      if (cluster.template.length !== tokens.length) continue;
      const similarity = computeSimilarity(cluster.template, tokens);
      if (similarity >= options.similarityThreshold) {
        cluster.template = mergeTemplates(cluster.template, tokens);
        cluster.logIds.push(String(i));
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        id: `cluster-${clusters.length}`,
        template: [...tokens],
        logIds: [String(i)],
      });

      if (clusters.length > options.maxChildren) {
        console.warn(
          `[logs] Drain cluster limit reached (${options.maxChildren}); ${logMessages.length - i - 1} log messages not clustered`,
        );
        break;
      }
    }
  }

  return clusters;
}

function tokenize(message: string): string[] {
  return message.split(/\s+/).filter(Boolean);
}

function computeSimilarity(template: string[], tokens: string[]): number {
  if (template.length !== tokens.length || template.length === 0) return 0;

  let matches = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === tokens[i] || template[i] === "<*>") {
      matches++;
    }
  }
  return matches / template.length;
}

function mergeTemplates(template: string[], tokens: string[]): string[] {
  return template.map((t, i) =>
    t === tokens[i] || t === "<*>" ? (t === "<*>" ? "<*>" : t) : "<*>",
  );
}

function visitAll(
  node: TreeSitterNode,
  visitor: (n: TreeSitterNode) => void,
): void {
  visitor(node);
  for (const child of node.namedChildren) {
    visitAll(child, visitor);
  }
}
