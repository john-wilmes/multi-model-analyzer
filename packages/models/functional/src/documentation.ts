/**
 * Documentation generation from service catalog and summaries.
 *
 * Produces markdown documentation organized by service, including:
 * - Service overview (tier 4 summary)
 * - API surface
 * - Dependencies
 * - Error handling patterns
 * - Method-level details (tier 1-3 summaries)
 */

import type { ServiceCatalogEntry, Summary, SarifResult, SarifReportingDescriptor } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";

export const FUNCTIONAL_RULES: readonly SarifReportingDescriptor[] = [
  {
    id: "functional/undocumented-service",
    shortDescription: {
      text: "Service with no tier 4 summary available",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "functional/missing-api-description",
    shortDescription: {
      text: "API endpoint with no description",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
];

export function generateDocumentation(
  catalog: readonly ServiceCatalogEntry[],
  summaries: ReadonlyMap<string, Summary>,
): string {
  const sections: string[] = [];

  sections.push("# System Architecture Documentation\n");
  sections.push(`Generated: ${new Date().toISOString()}\n`);
  sections.push(`Services: ${catalog.length}\n`);
  sections.push("---\n");

  for (const entry of catalog) {
    sections.push(generateServiceSection(entry, summaries));
  }

  return sections.join("\n");
}

function generateServiceSection(
  entry: ServiceCatalogEntry,
  _summaries: ReadonlyMap<string, Summary>,
): string {
  const lines: string[] = [];

  lines.push(`## ${entry.name}\n`);
  lines.push(`${entry.purpose}\n`);

  if (entry.dependencies.length > 0) {
    lines.push("### Dependencies\n");
    for (const dep of entry.dependencies) {
      lines.push(`- ${dep}`);
    }
    lines.push("");
  }

  if (entry.apiSurface.length > 0) {
    lines.push("### API Surface\n");
    lines.push("| Method | Path | Description |");
    lines.push("|--------|------|-------------|");
    for (const endpoint of entry.apiSurface) {
      lines.push(
        `| ${endpoint.method} | ${endpoint.path} | ${endpoint.description} |`,
      );
    }
    lines.push("");
  }

  lines.push("### Error Handling\n");
  lines.push(`${entry.errorHandlingSummary}\n`);

  return lines.join("\n");
}

export function findDocumentationGaps(
  catalog: readonly ServiceCatalogEntry[],
  summaries: ReadonlyMap<string, Summary>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const entry of catalog) {
    // Check for services without tier 4 summaries
    const hasTier4 = [...summaries.values()].some(
      (s) => s.tier === 4 && s.entityId.includes(entry.name),
    );

    if (!hasTier4) {
      results.push(
        createSarifResult(
          "functional/undocumented-service",
          "note",
          `Service "${entry.name}" has no tier 4 summary`,
          {
            locations: [{
              logicalLocations: [
                createLogicalLocation(repo, entry.name),
              ],
            }],
          },
        ),
      );
    }

    // Check for endpoints without descriptions
    for (const endpoint of entry.apiSurface) {
      if (endpoint.description === endpoint.path) {
        results.push(
          createSarifResult(
            "functional/missing-api-description",
            "note",
            `API endpoint ${endpoint.method} ${endpoint.path} has no description`,
            {
              locations: [{
                logicalLocations: [
                  createLogicalLocation(repo, entry.name, endpoint.path),
                ],
              }],
            },
          ),
        );
      }
    }
  }

  return results;
}
