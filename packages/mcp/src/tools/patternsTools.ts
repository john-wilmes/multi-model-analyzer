import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getFlagInventory, computeFlagImpact, getConfigInventory, getConfigModel, getIntegratorConfigMap } from "@mma/query";
import { validateConfiguration, generateCoveringArray, computeInteractionStrength } from "@mma/model-config";
import { validateConfig } from "@mma/constraints";
import type { ConstraintSet } from "@mma/constraints";
import type { CrossRepoGraph } from "@mma/correlation";
import { computeCrossRepoImpact } from "@mma/correlation";
import { z } from "zod";
import { jsonResult, deserializeGraph } from "./helpers.js";
import type { Stores } from "./helpers.js";

async function getSettingsConstraintSet(
  kvStore: Stores["kvStore"],
  repo: string,
): Promise<ConstraintSet | null> {
  const raw = await kvStore.get(`constraints:settings:integrator:${repo}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Validate shape before casting: must be an object with integratorType (string)
    // and fields (array). Corrupt payloads are discarded.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).integratorType !== "string" ||
      !Array.isArray((parsed as Record<string, unknown>).fields)
    ) {
      return null;
    }
    return parsed as ConstraintSet;
  } catch {
    return null;
  }
}

async function getConstraintSets(
  kvStore: Stores["kvStore"],
  repo: string,
): Promise<ConstraintSet[] | null> {
  const raw = await kvStore.get(`constraints:${repo}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Validate shape before casting: must be an array of objects each with
    // integratorType (string) and fields (array). Corrupt payloads are discarded.
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).integratorType === "string" &&
          Array.isArray((item as Record<string, unknown>).fields),
      )
    ) {
      return null;
    }
    return parsed as ConstraintSet[];
  } catch {
    return null;
  }
}

export function registerPatternsTools(server: McpServer, stores: Stores): void {
  const { graphStore, kvStore } = stores;

  // 13. Feature flag inventory
  server.registerTool("get_flag_inventory", {
    description: "List and search feature flags detected across indexed repositories. Supports filtering by repo, substring search, and pagination. Call before get_flag_impact to find exact flag names. Use unregistered:true to surface dead-flag candidates. Cross-reference with MongoDB users.featureFlags to check which accounts have a flag enabled.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      search: z.string().optional().describe("Substring to filter flag names by (case-insensitive)"),
      limit: z.number().optional().describe("Max results to return (default 50)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
      registry_only: z.boolean().optional().describe("Only show flags from the canonical registry"),
      unregistered: z.boolean().optional().describe("Only show flags not in the canonical registry"),
    },
  }, async ({ repo, search, limit, offset, registry_only, unregistered }) => {
    const result = await getFlagInventory(kvStore, { repo, search, limit, offset, registryOnly: registry_only, unregistered });
    const flagHints = result && typeof result === "object" && "total" in result && (result as { total: number }).total > 0
      ? ["Call get_flag_impact with a flag name and repo to trace its blast radius."]
      : undefined;
    return jsonResult(result, undefined, flagHints);
  });

  // 14. Feature flag impact analysis
  server.registerTool("get_flag_impact", {
    description: "Trace the impact of a feature flag: reverse BFS from flag locations through import/call graph to find affected files and services, with optional cross-repo expansion. Use after get_flag_inventory to trace a flag's blast radius. Set crossRepo:true after confirming downstream repos via get_cross_repo_graph.",
    inputSchema: {
      flag: z.string().describe("Feature flag name (exact match tried first, then substring)"),
      repo: z.string().describe("Repository the flag belongs to"),
      maxDepth: z.number().optional().describe("Max traversal depth (default 5)"),
      includeCallGraph: z.boolean().optional().describe("Include call graph edges in traversal (default true)"),
      crossRepo: z.boolean().optional().describe("Expand impact to downstream repos via cross-repo correlation (default false)"),
    },
  }, async ({ flag, repo, maxDepth, includeCallGraph, crossRepo }) => {
    const intraResult = await computeFlagImpact(flag, repo, kvStore, graphStore, {
      maxDepth, includeCallGraph,
    });

    const flagImpactHints = (intraResult.affectedFiles?.length ?? 0) > 0
      ? ["Call get_blast_radius on impacted files for full dependency analysis."]
      : undefined;

    if (!crossRepo) {
      return jsonResult(intraResult, undefined, flagImpactHints);
    }

    // Cross-repo expansion using correlation graph
    const raw = await kvStore.get("correlation:graph");
    if (!raw) {
      return jsonResult({ ...intraResult, crossRepo: { error: "No correlation data available." } }, undefined, flagImpactHints);
    }
    const parsed = JSON.parse(raw) as {
      edges: CrossRepoGraph["edges"];
      repoPairs: string[];
      downstreamMap: [string, string[]][];
      upstreamMap: [string, string[]][];
    };
    const graph = deserializeGraph(parsed);
    const allAffectedFiles = [
      ...intraResult.flagLocations,
      ...intraResult.affectedFiles.map((f) => f.path),
    ];
    const crossImpact = await computeCrossRepoImpact(allAffectedFiles, repo, graphStore, graph);
    return jsonResult({
      ...intraResult,
      crossRepo: {
        reposReached: crossImpact.reposReached,
        affectedAcrossRepos: Object.fromEntries(crossImpact.affectedAcrossRepos),
      },
    }, undefined, flagImpactHints);
  });

  // 23. Design pattern detection results
  server.registerTool("get_patterns", {
    description: "Get detected design patterns (adapter, facade, observer, factory, singleton, repository, middleware, decorator) across indexed repositories. Use alongside get_architecture for architectural understanding.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      pattern: z.string().optional().describe("Filter by pattern type name (case-insensitive substring match)"),
    },
  }, async ({ repo, pattern }) => {
    if (repo) {
      const json = await kvStore.get(`patterns:${repo}`);
      if (!json) {
        return jsonResult({ repo, patterns: {}, note: `No pattern data for "${repo}". Run 'mma index' first.` });
      }
      try {
        const data = JSON.parse(json) as Record<string, unknown>;
        if (pattern) {
          const lower = pattern.toLowerCase();
          const filtered: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(data)) {
            if (key.toLowerCase().includes(lower)) {
              filtered[key] = value;
            }
          }
          const hasPatterns = Object.keys(filtered).length > 0;
          return jsonResult({ repo, patterns: filtered }, undefined, hasPatterns ? ["Call get_architecture for cross-repo structural context."] : undefined);
        }
        return jsonResult({ repo, patterns: data }, undefined, Object.keys(data).length > 0 ? ["Call get_architecture for cross-repo structural context."] : undefined);
      } catch {
        return jsonResult({ repo, patterns: {}, error: "Could not parse pattern data" });
      }
    }

    // All repos
    const keys = await kvStore.keys("patterns:");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const keyRepo = key.slice("patterns:".length);
      const json = await kvStore.get(key);
      if (json) {
        try {
          const data = JSON.parse(json) as Record<string, unknown>;
          if (pattern) {
            const lower = pattern.toLowerCase();
            const filtered: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(data)) {
              if (k.toLowerCase().includes(lower)) {
                filtered[k] = v;
              }
            }
            if (Object.keys(filtered).length > 0) {
              result[keyRepo] = filtered;
            }
          } else {
            result[keyRepo] = data;
          }
        } catch { /* skip malformed */ }
      }
    }

    if (Object.keys(result).length === 0) {
      return jsonResult({
        patterns: {},
        note: "No pattern data available. Run 'mma index' first.",
      });
    }

    return jsonResult({ repos: result }, undefined, ["Call get_architecture for cross-repo structural context."]);
  });

  // Config inventory: settings, credentials, and flags unified view
  server.registerTool("get_config_inventory", {
    description: "List configuration parameters (settings, credentials, flags) detected across indexed repositories. Filter by repo, kind, or substring search. Call before get_config_model and validate_config. Compare with runtime config from MongoDB to identify drift between code expectations and actual deployment.",
    inputSchema: {
      repo: z.string().optional().describe("Filter to a specific repository name"),
      search: z.string().optional().describe("Substring to filter parameter names by (case-insensitive)"),
      kind: z.enum(["setting", "credential", "flag"]).optional().describe("Filter by parameter kind"),
      limit: z.number().optional().describe("Max results to return (default 50)"),
      offset: z.number().optional().describe("Number of results to skip for pagination (default 0)"),
    },
  }, async ({ repo, search, kind, limit, offset }) => {
    const result = await getConfigInventory(kvStore, { repo, search, kind, limit, offset });
    if (result.total === 0) {
      return jsonResult({
        ...result,
        note: "No config parameters found. Run 'mma index' with settings scanner options configured in the repo config.",
      });
    }
    return jsonResult(result, undefined, ["Call get_config_model to see constraint relationships between these settings."]);
  });

  // Config model: constraint graph for a repository
  server.registerTool("get_config_model", {
    description: "Get the constraint model for a repository — shows inferred relationships between flags, settings, and credentials (requires, mutex, enum, conditional constraints). Use before validate_config and get_test_configurations.",
    inputSchema: {
      repo: z.string().describe("Repository name to get the config model for"),
    },
  }, async ({ repo }) => {
    const model = await getConfigModel(kvStore, repo);
    if (!model) {
      return jsonResult({
        error: `No config model found for "${repo}". Run 'mma index' first. The config model is built when both flag inventory and config inventory are present.`,
      });
    }

    // Summarize the model for readability
    const constraintsByKind: Record<string, number> = {};
    for (const c of model.constraints) {
      constraintsByKind[c.kind] = (constraintsByKind[c.kind] ?? 0) + 1;
    }

    return jsonResult({
      repo,
      flagCount: model.flags.length,
      parameterCount: model.parameters?.length ?? 0,
      constraintCount: model.constraints.length,
      constraintsByKind,
      constraints: model.constraints,
      parameters: model.parameters,
    }, undefined, model.constraints.length > 0 ? [
      "Call validate_config with a config object to check compliance.",
      "Call get_test_configurations for a minimal covering test plan.",
    ] : undefined);
  });

  // Validate a partial configuration against constraints
  server.registerTool("validate_config", {
    description: "Check a partial configuration against the constraint model for a repository. Returns validation issues (missing dependencies, conflicts, invalid values). Issues list missing, conflict, and invalid kinds — address conflicts first as they are always-invalid combinations.",
    inputSchema: {
      repo: z.string().describe("Repository name to validate against"),
      config: z.record(z.unknown()).describe("Partial configuration to validate — keys are parameter names, values are their settings"),
    },
  }, async ({ repo, config }) => {
    const model = await getConfigModel(kvStore, repo);
    if (!model) {
      return jsonResult({
        error: `No config model found for "${repo}". Run 'mma index' first.`,
      });
    }

    const result = validateConfiguration(model, config);
    const validateHints = result.issues.length > 0
      ? ["Fix conflict issues first — they represent always-invalid combinations."]
      : ["Config is valid. Call get_test_configurations to generate a covering test plan."];
    return jsonResult({
      repo,
      valid: result.valid,
      issueCount: result.issues.length,
      issues: result.issues,
    }, undefined, validateHints);
  });

  // ISC constraint sets: required/conditional/never fields per integrator type
  server.registerTool("get_config_constraints", {
    description: "List constraint sets for a repository — shows required, conditional, and never fields derived from static analysis. Use domain='credentials' (default) for per-integrator-type credential constraints, or domain='integrator-settings' for global integrator settings constraints. Call before validate_config_constraints to understand the constraint model.",
    inputSchema: {
      repo: z.string().describe("Repository name to get constraint sets for"),
      integratorType: z.string().optional().describe("Filter to a specific integrator type (case-insensitive substring match). Only applies to credentials domain."),
      domain: z.enum(["credentials", "integrator-settings"]).optional().describe("Constraint domain: 'credentials' (default) for per-integrator-type credential constraints, 'integrator-settings' for global integrator settings constraints"),
    },
  }, async ({ repo, integratorType, domain }) => {
    const effectiveDomain = domain ?? "credentials";

    if (effectiveDomain === "integrator-settings") {
      const set = await getSettingsConstraintSet(kvStore, repo);
      if (!set) {
        return jsonResult({
          error: `No integrator settings constraints found for "${repo}". Run 'mma index' first. Settings constraints are built when integrator settings access patterns are detected.`,
        });
      }
      const summary = {
        integratorType: set.integratorType,
        fieldCount: set.fields.length,
        alwaysRequired: set.fields.filter(f => f.required === 'always').map(f => f.field),
        conditional: set.fields.filter(f => f.required === 'conditional').map(f => f.field),
        never: set.fields.filter(f => f.required === 'never').map(f => f.field),
        dynamicAccessCount: set.dynamicAccesses.length,
        coverage: set.coverage,
      };
      return jsonResult({ repo, domain: effectiveDomain, total: 1, returned: 1, constraintSets: [summary] }, undefined,
        ["Call validate_config_constraints with domain='integrator-settings' to check a runtime config."]);
    }

    // credentials domain (default)
    const sets = await getConstraintSets(kvStore, repo);
    if (!sets) {
      return jsonResult({
        error: `No constraint sets found for "${repo}". Run 'mma index' first. Constraint sets are built when ISC configuration files are present.`,
      });
    }

    let filtered = sets;
    if (integratorType) {
      const lower = integratorType.toLowerCase();
      filtered = sets.filter(s => s.integratorType.toLowerCase().includes(lower));
    }

    const summary = filtered.map(s => ({
      integratorType: s.integratorType,
      fieldCount: s.fields.length,
      alwaysRequired: s.fields.filter(f => f.required === 'always').map(f => f.field),
      conditional: s.fields.filter(f => f.required === 'conditional').map(f => f.field),
      never: s.fields.filter(f => f.required === 'never').map(f => f.field),
      dynamicAccessCount: s.dynamicAccesses.length,
      coverage: s.coverage,
    }));

    const hints = filtered.length > 0
      ? ["Call validate_config_constraints with a runtime config object to check for violations."]
      : undefined;

    return jsonResult({ repo, domain: effectiveDomain, total: sets.length, returned: filtered.length, constraintSets: summary }, undefined, hints);
  });

  // Validate a runtime config against ISC constraint sets
  server.registerTool("validate_config_constraints", {
    description: "Validate a runtime config object against constraint sets for a repository. Returns violations (missing required fields, unexpected types, unknown fields) and a nearest-valid suggestion. Use domain='credentials' (default) for per-integrator-type credential validation, or domain='integrator-settings' for global integrator settings validation. Different from validate_config which checks the feature model.",
    inputSchema: {
      repo: z.string().describe("Repository name to validate against"),
      integratorType: z.string().optional().describe("Integrator type to validate against (must match a constraint set exactly). Required for credentials domain, ignored for integrator-settings."),
      config: z.record(z.unknown()).describe("Runtime config object to validate — keys are credential/config field names, values are their settings"),
      domain: z.enum(["credentials", "integrator-settings"]).optional().describe("Constraint domain: 'credentials' (default) for per-integrator-type credential validation, 'integrator-settings' for global integrator settings validation"),
    },
  }, async ({ repo, integratorType, config, domain }) => {
    const effectiveDomain = domain ?? "credentials";

    if (effectiveDomain === "integrator-settings") {
      const constraintSet = await getSettingsConstraintSet(kvStore, repo);
      if (!constraintSet) {
        return jsonResult({
          error: `No integrator settings constraints found for "${repo}". Run 'mma index' first.`,
        });
      }
      const result = validateConfig(config, constraintSet);
      const hints = result.violations.length > 0
        ? ["Fix missing-required violations first.", "Call get_config_constraints with domain='integrator-settings' to see full field requirements."]
        : ["Config satisfies all integrator settings constraints."];
      return jsonResult({
        repo,
        domain: effectiveDomain,
        integratorType: constraintSet.integratorType,
        valid: result.valid,
        violationCount: result.violations.length,
        violations: result.violations,
        nearestValid: result.nearestValid,
        coverage: result.coverage,
      }, undefined, hints);
    }

    // credentials domain (default)
    if (!integratorType) {
      return jsonResult({
        error: "integratorType is required for credentials domain validation.",
      });
    }

    const sets = await getConstraintSets(kvStore, repo);
    if (!sets) {
      return jsonResult({
        error: `No constraint sets found for "${repo}". Run 'mma index' first.`,
      });
    }

    const constraintSet = sets.find(s => s.integratorType.toLowerCase() === integratorType.toLowerCase());
    if (!constraintSet) {
      const available = sets.map(s => s.integratorType);
      return jsonResult({
        error: `No constraint set for integrator type "${integratorType}".`,
        availableTypes: available,
      });
    }

    const result = validateConfig(config, constraintSet);
    const hints = result.violations.length > 0
      ? ["Fix missing-required violations first — they represent always-needed credentials.", "Call get_config_constraints to see full field requirements for this integrator type."]
      : ["Config satisfies all ISC constraints. Call validate_config to also check feature model constraints."];

    return jsonResult({
      repo,
      domain: effectiveDomain,
      integratorType,
      valid: result.valid,
      violationCount: result.violations.length,
      violations: result.violations,
      nearestValid: result.nearestValid,
      coverage: result.coverage,
    }, undefined, hints);
  });

  // Generate minimal test configurations (covering array)
  server.registerTool("get_test_configurations", {
    description: "Generate a minimal set of test configurations covering all pairwise (or t-way) parameter interactions for a repository's config space. Use get_interaction_strength first to identify high-coupling parameters that may warrant strength:3.",
    inputSchema: {
      repo: z.string().describe("Repository name to generate test configs for"),
      strength: z.number().optional().describe("Interaction strength (2=pairwise, up to 6). Default: 2"),
      constraintAware: z.boolean().optional().describe("Skip configurations that violate model constraints (default true)"),
    },
  }, async ({ repo, strength, constraintAware }) => {
    const model = await getConfigModel(kvStore, repo);
    if (!model) {
      return jsonResult({ error: `No config model found for "${repo}". Run 'mma index' first.` });
    }
    const result = generateCoveringArray(model, {
      strength,
      constraintAware: constraintAware ?? true,
    });
    const testConfigsHints = (result.configurations?.length ?? 0) > 0
      ? ["Use get_interaction_strength on specific parameters to decide if higher strength is needed."]
      : undefined;
    return jsonResult({ repo, ...result }, undefined, testConfigsHints);
  });

  // Interaction strength for a specific parameter
  server.registerTool("get_interaction_strength", {
    description: "Analyze how many other parameters interact with a given configuration parameter based on inferred constraints. Use before get_test_configurations to decide whether pairwise (strength:2) is sufficient.",
    inputSchema: {
      repo: z.string().describe("Repository name"),
      parameter: z.string().describe("Parameter name to analyze"),
    },
  }, async ({ repo, parameter }) => {
    const model = await getConfigModel(kvStore, repo);
    if (!model) {
      return jsonResult({ error: `No config model found for "${repo}". Run 'mma index' first.` });
    }
    const result = computeInteractionStrength(model, parameter);
    return jsonResult({ repo, ...result }, undefined, ["Call get_test_configurations with appropriate strength based on this coupling analysis."]);
  });

  server.registerTool("get_integrator_config_map", {
    description: "Derive per-integrator credential and setting requirements from static analysis of client code. Groups config parameters by integrator type (extracted from module paths). Use to audit credential requirements or generate mapping files. Compare results against MongoDB integrators collection to validate that deployed integrators have all required credentials. Conditional requirements (runtime logic) cannot be derived statically.",
    inputSchema: {
      repo: z.string().optional().describe("Repository to analyze (default: integrator-service-clients)"),
      type: z.string().optional().describe("Filter to integrator types matching this substring (case-insensitive)"),
      search: z.string().optional().describe("Filter by type name or parameter name substring (case-insensitive). If the type name matches, all its parameters are included; otherwise only matching parameters are returned."),
    },
  }, async ({ repo, type, search }) => {
    const result = await getIntegratorConfigMap(kvStore, { repo, type, search });
    const hints = result.returned > 0
      ? [
          "Use 'type' filter to drill into a specific integrator.",
          "Cross-reference credentials with runtime org config to detect missing fields.",
          "Call get_config_model to see constraint relationships between parameters.",
        ]
      : ["No integrator types found. Ensure integrator-service-clients is indexed."];
    return jsonResult(result, undefined, hints);
  });
}
