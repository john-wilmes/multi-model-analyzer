import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getFlagInventory, computeFlagImpact, getConfigInventory, getConfigModel } from "@mma/query";
import { validateConfiguration, generateCoveringArray, computeInteractionStrength } from "@mma/model-config";
import type { CrossRepoGraph } from "@mma/correlation";
import { computeCrossRepoImpact } from "@mma/correlation";
import { z } from "zod";
import { jsonResult, deserializeGraph } from "./helpers.js";
import type { Stores } from "./helpers.js";

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

}
