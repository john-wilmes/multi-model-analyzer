/**
 * SARIF v2.1.0 type definitions for diagnostic output.
 *
 * Subset of the full SARIF spec covering what we emit:
 * - Logical locations only (no physical locations, no source snippets)
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

export interface SarifResult {
  readonly ruleId: string;
  readonly ruleIndex?: number;
  readonly level: SarifLevel;
  readonly message: SarifMultiformatMessage;
  readonly locations?: readonly SarifLocation[];
  readonly codeFlows?: readonly SarifCodeFlow[];
  readonly relatedLocations?: readonly SarifLocation[];
  readonly properties?: Record<string, unknown>;
}

export interface SarifLocation {
  readonly logicalLocations?: readonly SarifLogicalLocation[];
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
  return {
    ruleId,
    level,
    message: { text: messageText },
    ...options,
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
