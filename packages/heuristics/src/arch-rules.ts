/**
 * Architectural rules engine: configurable constraint enforcement.
 *
 * Evaluates layer violations, forbidden imports, and dependency direction rules
 * against the import edge graph. Produces SARIF results for violations.
 */

import type {
  ArchitecturalRule,
  LayerRuleConfig,
  ForbiddenImportConfig,
  DependencyDirectionConfig,
  GraphEdge,
  SarifResult,
} from "@mma/core";

export function evaluateArchRules(
  rules: readonly ArchitecturalRule[],
  importEdges: readonly GraphEdge[],
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const rule of rules) {
    switch (rule.kind) {
      case "layer-violation":
        results.push(...checkLayerViolations(rule, importEdges, repo));
        break;
      case "forbidden-import":
        results.push(...checkForbiddenImports(rule, importEdges, repo));
        break;
      case "dependency-direction":
        results.push(...checkDependencyDirection(rule, importEdges, repo));
        break;
    }
  }

  return results;
}

function checkLayerViolations(
  rule: ArchitecturalRule,
  edges: readonly GraphEdge[],
  repo: string,
): SarifResult[] {
  const config = rule.config as LayerRuleConfig;
  const results: SarifResult[] = [];

  // Build layer membership: file path -> layer name
  const fileToLayer = new Map<string, string>();
  for (const layer of config.layers) {
    for (const edge of edges) {
      if (layer.patterns.some((p) => globMatch(edge.source, p))) {
        fileToLayer.set(edge.source, layer.name);
      }
      if (layer.patterns.some((p) => globMatch(edge.target, p))) {
        fileToLayer.set(edge.target, layer.name);
      }
    }
  }

  // Check each import edge for layer violations
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    const sourceLayer = fileToLayer.get(edge.source);
    const targetLayer = fileToLayer.get(edge.target);

    if (!sourceLayer || !targetLayer || sourceLayer === targetLayer) continue;

    // Find the layer config for the source
    const layerConfig = config.layers.find((l) => l.name === sourceLayer);
    if (!layerConfig) continue;

    // Check if the target layer is allowed
    if (!layerConfig.allowedDependencies.includes(targetLayer)) {
      results.push({
        ruleId: "arch/layer-violation",
        level: rule.severity,
        message: {
          text: `Layer violation: "${edge.source}" (${sourceLayer}) imports "${edge.target}" (${targetLayer}). Allowed dependencies for ${sourceLayer}: [${layerConfig.allowedDependencies.join(", ")}]`,
        },
        locations: [{
          logicalLocations: [{
            fullyQualifiedName: edge.source,
            kind: "module",
            properties: { repo },
          }],
        }],
      });
    }
  }

  return results;
}

function checkForbiddenImports(
  rule: ArchitecturalRule,
  edges: readonly GraphEdge[],
  repo: string,
): SarifResult[] {
  const config = rule.config as ForbiddenImportConfig;
  const results: SarifResult[] = [];

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;

    const sourceMatches = config.from.some((p) => globMatch(edge.source, p));
    const targetForbidden = config.forbidden.some((p) => globMatch(edge.target, p));

    if (sourceMatches && targetForbidden) {
      results.push({
        ruleId: "arch/forbidden-import",
        level: rule.severity,
        message: {
          text: `Forbidden import: "${edge.source}" imports "${edge.target}" which matches forbidden pattern`,
        },
        locations: [{
          logicalLocations: [{
            fullyQualifiedName: edge.source,
            kind: "module",
            properties: { repo },
          }],
        }],
      });
    }
  }

  return results;
}

function checkDependencyDirection(
  rule: ArchitecturalRule,
  edges: readonly GraphEdge[],
  repo: string,
): SarifResult[] {
  const config = rule.config as DependencyDirectionConfig;
  const results: SarifResult[] = [];

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;

    // Check denied pairs
    for (const [fromPattern, toPattern] of config.denied) {
      if (globMatch(edge.source, fromPattern) && globMatch(edge.target, toPattern)) {
        results.push({
          ruleId: "arch/dependency-direction",
          level: rule.severity,
          message: {
            text: `Dependency direction violation: "${edge.source}" -> "${edge.target}" matches denied pair [${fromPattern}, ${toPattern}]`,
          },
          locations: [{
            logicalLocations: [{
              fullyQualifiedName: edge.source,
              kind: "module",
              properties: { repo },
            }],
          }],
        });
      }
    }
  }

  return results;
}

/**
 * Simple glob matching supporting `*` (any non-separator) and `**` (any path).
 * Anchored: pattern must match the entire string.
 *
 * ReDoS safeguards:
 * - Rejects patterns longer than 256 characters.
 * - Rejects patterns with more than 10 wildcard segments (consecutive `**`
 *   separated by literals can trigger catastrophic backtracking).
 * - Caches compiled regexes to avoid repeated compilation.
 */
const globCache = new Map<string, RegExp>();
const MAX_GLOB_LENGTH = 256;
const MAX_WILDCARD_SEGMENTS = 10;

export function globMatch(str: string, pattern: string): boolean {
  if (pattern.length > MAX_GLOB_LENGTH) {
    return false;
  }

  // Count wildcard segments: split on non-wildcard chars and count runs of *
  const wildcardSegments = (pattern.match(/\*+/g) ?? []).length;
  if (wildcardSegments > MAX_WILDCARD_SEGMENTS) {
    return false;
  }

  let re = globCache.get(pattern);
  if (!re) {
    // Replace ** with placeholder, then escape special regex chars, then restore
    const escaped = pattern
      .replace(/\*\*/g, "\0DSTAR\0")
      .replace(/\*/g, "\0STAR\0")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\0DSTAR\0/g, ".*")
      .replace(/\0STAR\0/g, "[^/]*");

    re = new RegExp(`^${escaped}$`);
    globCache.set(pattern, re);
  }

  return re.test(str);
}
