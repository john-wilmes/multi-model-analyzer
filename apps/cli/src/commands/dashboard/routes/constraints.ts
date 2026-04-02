/**
 * Route handlers for constraints API endpoints:
 *   GET /api/constraints
 *   GET /api/constraints/:type
 *   GET /api/cross-entity-deps
 *   POST /api/validate-constraints
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { KVStore } from "@mma/storage";
import type { ConstraintSet, CrossEntityDependencyResult } from "@mma/constraints";
import { validateConfig } from "@mma/constraints";
import { sendJson, sendError, type ParsedQuery } from "../http-utils.js";

/** Extract the repo name from query params, falling back to the first constraints: key. */
async function resolveRepo(kvStore: KVStore, query: ParsedQuery): Promise<string | undefined> {
  const repoParam = query.single["repo"];
  if (repoParam) return repoParam;
  const keys = await kvStore.keys("constraints:");
  for (const key of keys) {
    // Only look at credential keys (constraints:{repo}) — not sub-namespaced keys
    const rest = key.slice("constraints:".length);
    if (!rest.includes(":")) return rest;
  }
  return undefined;
}

/** Summarize a ConstraintSet into the list-level shape. */
function summarizeConstraintSet(cs: ConstraintSet): Record<string, unknown> {
  let always = 0;
  let conditional = 0;
  let never = 0;
  for (const fc of cs.fields) {
    if (fc.required === "always") always++;
    else if (fc.required === "conditional") conditional++;
    else never++;
  }
  return {
    integratorType: cs.integratorType,
    fieldCount: cs.fields.length,
    always,
    conditional,
    never,
    coverage: cs.coverage,
  };
}

export async function handleConstraints(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const domain = query.single["domain"] ?? "credentials";
  const integratorTypeFilter = query.single["integratorType"];
  const repo = await resolveRepo(kvStore, query);

  if (!repo) {
    return sendJson(res, { constraintSets: [], total: 0 }, 200, corsOrigin);
  }

  try {
    if (domain === "credentials") {
      const json = await kvStore.get(`constraints:${repo}`);
      if (!json) return sendJson(res, { constraintSets: [], total: 0 }, 200, corsOrigin);
      let sets = JSON.parse(json) as ConstraintSet[];
      if (integratorTypeFilter) {
        sets = sets.filter((s) => s.integratorType === integratorTypeFilter);
      }
      const constraintSets = sets.map(summarizeConstraintSet);
      return sendJson(res, { constraintSets, total: constraintSets.length }, 200, corsOrigin);
    }

    if (domain === "integrator-settings") {
      const json = await kvStore.get(`constraints:settings:integrator:${repo}`);
      if (!json) return sendJson(res, { constraintSets: [], total: 0 }, 200, corsOrigin);
      const cs = JSON.parse(json) as ConstraintSet;
      return sendJson(res, { constraintSets: [summarizeConstraintSet(cs)], total: 1 }, 200, corsOrigin);
    }

    if (domain === "account-settings") {
      const json = await kvStore.get(`constraints:settings:account:${repo}`);
      if (!json) return sendJson(res, { constraintSets: [], total: 0 }, 200, corsOrigin);
      const cs = JSON.parse(json) as ConstraintSet;
      return sendJson(res, { constraintSets: [summarizeConstraintSet(cs)], total: 1 }, 200, corsOrigin);
    }

    return sendError(res, `Unknown domain: ${domain}`, 400, corsOrigin);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
  }
}

export async function handleConstraintDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  type: string,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const domain = query.single["domain"] ?? "credentials";
  const repo = await resolveRepo(kvStore, query);

  if (!repo) {
    return sendError(res, "No indexed repo found", 404, corsOrigin);
  }

  try {
    if (domain === "credentials") {
      const json = await kvStore.get(`constraints:${repo}`);
      if (!json) return sendError(res, "No constraints found", 404, corsOrigin);
      const sets = JSON.parse(json) as ConstraintSet[];
      const cs = sets.find((s) => s.integratorType === type);
      if (!cs) return sendError(res, `No constraint set for type: ${type}`, 404, corsOrigin);
      return sendJson(res, cs, 200, corsOrigin);
    }

    if (domain === "integrator-settings") {
      const json = await kvStore.get(`constraints:settings:integrator:${repo}`);
      if (!json) return sendError(res, "No integrator settings constraints found", 404, corsOrigin);
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    }

    if (domain === "account-settings") {
      const json = await kvStore.get(`constraints:settings:account:${repo}`);
      if (!json) return sendError(res, "No account settings constraints found", 404, corsOrigin);
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    }

    return sendError(res, `Unknown domain: ${domain}`, 400, corsOrigin);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
  }
}

export async function handleCrossEntityDeps(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const repo = await resolveRepo(kvStore, query);
  const accessedDomainFilter = query.single["accessedDomain"];
  const guardDomainFilter = query.single["guardDomain"];

  if (!repo) {
    return sendJson(res, { dependencies: [], stats: { totalAccesses: 0, crossEntityAccesses: 0 } }, 200, corsOrigin);
  }

  try {
    const json = await kvStore.get(`constraints:cross-entity:${repo}`);
    if (!json) {
      return sendJson(res, { dependencies: [], stats: { totalAccesses: 0, crossEntityAccesses: 0 } }, 200, corsOrigin);
    }
    const result = JSON.parse(json) as CrossEntityDependencyResult;
    let deps = result.dependencies;

    if (accessedDomainFilter) {
      deps = deps.filter((d) => d.accessedDomain === accessedDomainFilter);
    }
    if (guardDomainFilter) {
      deps = deps.filter((d) => d.guard.domain === guardDomainFilter);
    }

    return sendJson(res, { dependencies: deps, stats: result.stats }, 200, corsOrigin);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
  }
}

export async function handleValidateConstraints(
  req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  try {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB
    const body = await new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('error', (err) => reject(err));
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => resolve(data));
    });
    const parsed = JSON.parse(body) as {
      repo?: string;
      integratorType?: string;
      domain?: string;
      config?: Record<string, unknown>;
    };

    const { integratorType, domain = "credentials", config } = parsed;

    if (!integratorType || !config) {
      return sendError(res, "Missing required fields: integratorType, config", 400, corsOrigin);
    }

    // Resolve repo — use provided value or fall back to first key
    let repo = parsed.repo;
    if (!repo) {
      const keys = await kvStore.keys("constraints:");
      for (const key of keys) {
        const rest = key.slice("constraints:".length);
        if (!rest.includes(":")) { repo = rest; break; }
      }
    }
    if (!repo) {
      return sendError(res, "No indexed repo found", 404, corsOrigin);
    }

    let cs: ConstraintSet | undefined;

    if (domain === "credentials") {
      const json = await kvStore.get(`constraints:${repo}`);
      if (!json) return sendError(res, "No constraints found", 404, corsOrigin);
      const sets = JSON.parse(json) as ConstraintSet[];
      cs = sets.find((s) => s.integratorType === integratorType);
    } else if (domain === "integrator-settings") {
      const json = await kvStore.get(`constraints:settings:integrator:${repo}`);
      if (json) cs = JSON.parse(json) as ConstraintSet;
    } else if (domain === "account-settings") {
      const json = await kvStore.get(`constraints:settings:account:${repo}`);
      if (json) cs = JSON.parse(json) as ConstraintSet;
    } else {
      return sendError(res, `Unknown domain: ${domain}`, 400, corsOrigin);
    }

    if (!cs) {
      return sendError(res, `No constraint set found for integratorType: ${integratorType}`, 404, corsOrigin);
    }

    const result = validateConfig(config, cs);
    return sendJson(res, result, 200, corsOrigin);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
  }
}
