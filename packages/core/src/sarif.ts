/**
 * SARIF v2.1.0 type definitions for diagnostic output.
 *
 * Subset of the full SARIF spec covering what we emit:
 * - Logical and physical locations (artifactLocation + optional region)
 * - Code flows with logical location steps for fault tree traces
 * - Statistics in properties bag
 * - Redaction support via redactionTokens
 */

export interface SarifLog {
  readonly $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";
  readonly version: "2.1.0";
  readonly runs: readonly SarifRun[];
}

export interface SarifRun {
  readonly tool: SarifTool;
  readonly results: readonly SarifResult[];
  readonly logicalLocations?: readonly SarifLogicalLocation[];
  readonly redactionTokens?: readonly string[];
  readonly properties?: SarifRunProperties;
}

export interface SarifTool {
  readonly driver: SarifToolComponent;
}

export interface SarifToolComponent {
  readonly name: string;
  readonly version: string;
  readonly informationUri?: string;
  readonly rules: readonly SarifReportingDescriptor[];
}

export interface SarifReportingDescriptor {
  readonly id: string;
  readonly name?: string;
  readonly shortDescription: SarifMultiformatMessage;
  readonly fullDescription?: SarifMultiformatMessage;
  readonly defaultConfiguration?: SarifReportingConfiguration;
  readonly properties?: Record<string, unknown>;
}

export interface SarifReportingConfiguration {
  readonly level: SarifLevel;
  readonly enabled: boolean;
}

export type SarifLevel = "error" | "warning" | "note" | "none";

export interface SarifMultiformatMessage {
  readonly text: string;
  readonly markdown?: string;
}

export type SarifBaselineState = "new" | "unchanged" | "updated" | "absent";

export interface SarifResult {
  readonly ruleId: string;
  readonly ruleIndex?: number;
  readonly level: SarifLevel;
  readonly baselineState?: SarifBaselineState;
  readonly message: SarifMultiformatMessage;
  readonly locations?: readonly SarifLocation[];
  readonly codeFlows?: readonly SarifCodeFlow[];
  readonly relatedLocations?: readonly SarifLocation[];
  readonly fingerprints?: Record<string, string>;
  readonly properties?: Record<string, unknown>;
}

export interface SarifPhysicalLocation {
  readonly artifactLocation: { readonly uri: string };
  readonly region?: {
    readonly startLine: number;
    readonly startColumn?: number;
    readonly endLine?: number;
  };
}

export interface SarifLocation {
  readonly logicalLocations?: readonly SarifLogicalLocation[];
  readonly physicalLocation?: SarifPhysicalLocation;
}

export interface SarifLogicalLocation {
  readonly name?: string;
  readonly fullyQualifiedName?: string;
  readonly kind?: string;
  readonly decoratedName?: string;
  readonly properties?: Record<string, unknown>;
}

export interface SarifCodeFlow {
  readonly message?: SarifMultiformatMessage;
  readonly threadFlows: readonly SarifThreadFlow[];
}

export interface SarifThreadFlow {
  readonly locations: readonly SarifThreadFlowLocation[];
}

export interface SarifThreadFlowLocation {
  readonly location: SarifLocation;
  readonly nestingLevel?: number;
  readonly executionOrder?: number;
  readonly message?: SarifMultiformatMessage;
}

export interface SarifRunProperties {
  readonly statistics?: SarifStatistics;
  readonly [key: string]: unknown;
}

export interface SarifStatistics {
  readonly totalResults: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly noteCount: number;
  readonly rulesTriggered: number;
  readonly analysisTimestamp: string;
  readonly [key: string]: unknown;
}

// -- Factory helpers --

/**
 * Simple djb2 string hash — returns a compact hex string suitable for use
 * as a SARIF fingerprint value.  Not cryptographic; used for change detection.
 */
function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep as 32-bit unsigned
  }
  return h.toString(16).padStart(8, "0");
}

export function createSarifLog(runs: readonly SarifRun[]): SarifLog {
  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs,
  };
}

export function createSarifRun(
  toolName: string,
  toolVersion: string,
  rules: readonly SarifReportingDescriptor[],
  results: readonly SarifResult[],
  options?: {
    logicalLocations?: readonly SarifLogicalLocation[];
    redactionTokens?: readonly string[];
    properties?: SarifRunProperties;
  },
): SarifRun {
  return {
    tool: {
      driver: {
        name: toolName,
        version: toolVersion,
        rules,
      },
    },
    results,
    ...options,
  };
}

export function createSarifResult(
  ruleId: string,
  level: SarifLevel,
  messageText: string,
  options?: {
    ruleIndex?: number;
    locations?: readonly SarifLocation[];
    codeFlows?: readonly SarifCodeFlow[];
    relatedLocations?: readonly SarifLocation[];
    properties?: Record<string, unknown>;
  },
): SarifResult {
  // Compute a fingerprint from ruleId + first logical location FQN (if any),
  // falling back to the physical location URI when the FQN is absent.
  // Mirrors the fingerprint() logic in @mma/diagnostics/baseline.ts but uses
  // only the first location to keep the value stable across minor location changes.
  const firstLocation = options?.locations?.[0];
  const firstFqn =
    firstLocation?.logicalLocations?.[0]?.fullyQualifiedName ??
    firstLocation?.physicalLocation?.artifactLocation?.uri ??
    "";
  const fingerprintValue = djb2Hash(`${ruleId}::${firstFqn}`);

  return {
    ruleId,
    level,
    message: { text: messageText },
    ...options,
    fingerprints: { "primaryLocationLineHash/v1": fingerprintValue },
  };
}

export function createLogicalLocation(
  repo: string,
  module: string,
  fullyQualifiedName?: string,
  kind?: string,
): SarifLogicalLocation {
  return {
    name: module,
    fullyQualifiedName:
      fullyQualifiedName ?? `${repo}/${module}`,
    kind: kind ?? "module",
    properties: { repo },
  };
}
