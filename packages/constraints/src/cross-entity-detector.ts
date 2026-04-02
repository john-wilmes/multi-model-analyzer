import { parseGuardCondition } from "./ast-utils.js";
import type { FieldExtractor } from "./ast-utils.js";
import type {
  ConfigDomain,
  CredentialAccess,
  CrossEntityDependency,
  CrossEntityDependencyResult,
  GuardCondition,
} from "./types.js";

// Reuse the same integrator-type-from-path logic as constraint-builder.ts
function extractIntegratorTypeFromPath(filePath: string): string | undefined {
  const vendorMatch = /(?:^|[/\\])clients[/\\]([^/\\]+)[/\\]vendors[/\\]([^/\\]+)[/\\]/.exec(filePath);
  if (vendorMatch) return vendorMatch[2];
  const baseMatch = /(?:^|[/\\])clients[/\\]([^/\\]+)[/\\]/.exec(filePath);
  if (baseMatch) return baseMatch[1];
  const rootFileMatch = /(?:^|[/\\])clients[/\\]([^/\\]+)\.[jt]sx?$/.exec(filePath);
  if (rootFileMatch) return rootFileMatch[1];
  return undefined;
}

interface DomainExtractor {
  domain: ConfigDomain;
  extractor: FieldExtractor;
}

function tryParseGuardWithDomains(
  text: string,
  negated: boolean,
  otherDomains: readonly DomainExtractor[],
): (GuardCondition & { readonly domain: ConfigDomain }) | null {
  for (const { domain, extractor } of otherDomains) {
    const guard = parseGuardCondition(text, negated, extractor);
    if (guard) {
      return { ...guard, domain };
    }
  }
  return null;
}

function makeDedupKey(dep: Omit<CrossEntityDependency, "evidence">): string {
  return JSON.stringify([
    dep.accessedDomain,
    dep.integratorType,
    dep.accessedField,
    dep.guard.domain,
    dep.guard.field,
    dep.guard.operator,
    dep.guard.value ?? null,
    dep.guard.negated,
  ]);
}

/**
 * Detect cross-entity dependencies by classifying unmatched guard texts
 * from each domain's extractor against the other domains' field recognizers.
 */
export function detectCrossEntityDependencies(
  credentialAccesses: readonly CredentialAccess[],
  settingsAccesses: readonly CredentialAccess[],
  accountSettingsAccesses: readonly CredentialAccess[],
  domainExtractors: {
    credentials: FieldExtractor;
    settings: FieldExtractor;
    accountSettings: FieldExtractor;
  },
): CrossEntityDependencyResult {
  const dedupMap = new Map<string, CrossEntityDependency>();
  let crossEntityAccesses = 0;

  const allDomains: DomainExtractor[] = [
    { domain: "credentials", extractor: domainExtractors.credentials },
    { domain: "integrator-settings", extractor: domainExtractors.settings },
    { domain: "account-settings", extractor: domainExtractors.accountSettings },
  ];

  function processAccesses(
    accesses: readonly CredentialAccess[],
    accessedDomain: ConfigDomain,
    getIntegratorType: (file: string) => string | null,
  ): void {
    const otherDomains = allDomains.filter((d) => d.domain !== accessedDomain);

    for (const access of accesses) {
      if (!access.rawGuardTexts || access.rawGuardTexts.length === 0) continue;

      for (const text of access.rawGuardTexts) {
        const guard = tryParseGuardWithDomains(text, false, otherDomains);
        if (!guard) continue;

        crossEntityAccesses++;
        const integratorType = getIntegratorType(access.file);
        const key = makeDedupKey({
          accessedDomain,
          integratorType,
          accessedField: access.field,
          guard,
        });

        const existing = dedupMap.get(key);
        if (existing) {
          (existing.evidence as { file: string; line: number }[]).push({
            file: access.file,
            line: access.line,
          });
        } else {
          dedupMap.set(key, {
            accessedDomain,
            integratorType,
            accessedField: access.field,
            guard,
            evidence: [{ file: access.file, line: access.line }],
          });
        }
      }
    }
  }

  processAccesses(
    credentialAccesses,
    "credentials",
    (file) => extractIntegratorTypeFromPath(file) ?? null,
  );
  processAccesses(settingsAccesses, "integrator-settings", () => null);
  processAccesses(accountSettingsAccesses, "account-settings", () => null);

  const totalAccesses =
    credentialAccesses.length + settingsAccesses.length + accountSettingsAccesses.length;

  return {
    dependencies: [...dedupMap.values()],
    stats: { totalAccesses, crossEntityAccesses },
  };
}
