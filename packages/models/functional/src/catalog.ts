/**
 * Service catalog construction from indexes and summaries.
 *
 * Composes a catalog entry for each detected service with:
 * name, purpose, dependencies, API surface, error handling summary.
 */

import type {
  InferredService,
  ServiceCatalogEntry,
  ApiEndpoint,
  Summary,
  LogTemplateIndex,
} from "@mma/core";

export function buildServiceCatalog(
  services: readonly InferredService[],
  summaries: ReadonlyMap<string, Summary>,
  logIndex: LogTemplateIndex,
): ServiceCatalogEntry[] {
  return services.map((service) =>
    buildCatalogEntry(service, summaries, logIndex),
  );
}

function buildCatalogEntry(
  service: InferredService,
  summaries: ReadonlyMap<string, Summary>,
  logIndex: LogTemplateIndex,
): ServiceCatalogEntry {
  const purpose = findServiceSummary(service, summaries);
  const apiSurface = inferApiSurface(service, summaries);
  const errorSummary = summarizeErrorHandling(service, logIndex);

  return {
    name: service.name,
    rootPath: service.rootPath,
    purpose,
    dependencies: [...service.dependencies],
    apiSurface,
    errorHandlingSummary: errorSummary,
  };
}

function findServiceSummary(
  service: InferredService,
  summaries: ReadonlyMap<string, Summary>,
): string {
  // Look for a tier 4 (service-level) summary first.
  // Use a strict path boundary (exact match or trailing "/") to prevent
  // cross-service contamination from sibling paths sharing a common prefix
  // (e.g. "services/auth" must not match "services/auth-v2").
  const root = service.rootPath;
  function isUnderRoot(entityId: string): boolean {
    return entityId === root || entityId.startsWith(root + "/");
  }

  for (const [entityId, summary] of summaries) {
    if (isUnderRoot(entityId) && summary.tier === 4) {
      return summary.description;
    }
  }

  // Fall back to composing from method summaries
  const methodSummaries: string[] = [];
  for (const [entityId, summary] of summaries) {
    if (isUnderRoot(entityId)) {
      methodSummaries.push(summary.description);
    }
  }

  if (methodSummaries.length > 0) {
    return `Service with ${methodSummaries.length} documented methods`;
  }

  return `Service at ${service.rootPath}`;
}

function inferApiSurface(
  service: InferredService,
  summaries: ReadonlyMap<string, Summary>,
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  for (const entryPoint of service.entryPoints) {
    const summary = summaries.get(`${service.rootPath}/${entryPoint}`);
    endpoints.push({
      method: "UNKNOWN",
      path: entryPoint,
      description: summary?.description ?? entryPoint,
    });
  }

  // Infer from exported function names.
  // Use strict path boundary to avoid matching sibling service paths.
  // Skip common false positives: serialization helpers, DTO transformers, etc.
  const FP_PATTERNS = /(?:FromJSON|ToJSON|Response|Request|Schema|Validator|Mock|Test|Spec|Fixture|Factory|Builder|Helper|Util)/i;

  const root = service.rootPath;
  for (const [entityId, summary] of summaries) {
    if (entityId !== root && !entityId.startsWith(root + "/")) continue;

    const name = entityId.split("#").pop() ?? "";
    if (
      name.startsWith("get") ||
      name.startsWith("post") ||
      name.startsWith("put") ||
      name.startsWith("delete") ||
      name.startsWith("patch")
    ) {
      // Skip likely false positives
      if (FP_PATTERNS.test(name)) continue;

      const method = name.match(/^(get|post|put|delete|patch)/i)?.[1]?.toUpperCase() ?? "GET";
      endpoints.push({
        method,
        path: entityId,
        description: summary.description,
      });
    }
  }

  return endpoints;
}

function summarizeErrorHandling(
  service: InferredService,
  logIndex: LogTemplateIndex,
): string {
  const serviceRoot = service.rootPath;
  const serviceTemplates = logIndex.templates.filter((t) =>
    t.locations.some(
      (l) => l.module === serviceRoot || l.module.startsWith(serviceRoot + "/"),
    ),
  );

  const errorCount = serviceTemplates.filter((t) => t.severity === "error").length;
  const warnCount = serviceTemplates.filter((t) => t.severity === "warn").length;

  if (errorCount === 0 && warnCount === 0) {
    return "No error logging detected";
  }

  return `${errorCount} error templates, ${warnCount} warning templates`;
}
