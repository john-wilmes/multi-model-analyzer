/**
 * SARIF redaction for safe sharing of analysis results.
 *
 * Hashes service names and other identifiable information when
 * results need to be shared without exposing proprietary code structure.
 */

import { createHash } from "node:crypto";
import type { SarifLog, SarifRun, SarifResult, SarifLogicalLocation } from "@mma/core";

export interface RedactionOptions {
  readonly salt: string;
  readonly preserveRuleIds: boolean;
  readonly preserveStatistics: boolean;
  readonly redactFilePaths: boolean;
}

const DEFAULT_OPTIONS: RedactionOptions = {
  salt: "",
  preserveRuleIds: true,
  preserveStatistics: true,
  redactFilePaths: false,
};

export function redactSarifLog(
  log: SarifLog,
  options: Partial<RedactionOptions> = {},
): SarifLog {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tokenMap = new Map<string, string>();

  return {
    ...log,
    runs: log.runs.map((run) => redactRun(run, opts, tokenMap)),
  };
}

function redactRun(
  run: SarifRun,
  options: RedactionOptions,
  tokenMap: Map<string, string>,
): SarifRun {
  const redactionTokens = [...tokenMap.values()];

  return {
    ...run,
    results: run.results.map((r) => redactResult(r, options, tokenMap)),
    logicalLocations: run.logicalLocations?.map((l) =>
      redactLogicalLocation(l, options, tokenMap),
    ),
    redactionTokens: redactionTokens.length > 0 ? redactionTokens : undefined,
    properties: options.preserveStatistics ? run.properties : undefined,
  };
}

function redactResult(
  result: SarifResult,
  options: RedactionOptions,
  tokenMap: Map<string, string>,
): SarifResult {
  return {
    ...result,
    ruleId: options.preserveRuleIds
      ? result.ruleId
      : hashToken(result.ruleId, options.salt, tokenMap),
    message: {
      text: redactText(result.message.text, options, tokenMap),
    },
    locations: result.locations?.map((loc) => ({
      logicalLocations: loc.logicalLocations?.map((l) =>
        redactLogicalLocation(l, options, tokenMap),
      ),
    })),
  };
}

function redactLogicalLocation(
  location: SarifLogicalLocation,
  options: RedactionOptions,
  tokenMap: Map<string, string>,
): SarifLogicalLocation {
  const props = location.properties ? { ...location.properties } : undefined;
  if (props && typeof props["repo"] === "string") {
    props["repo"] = hashToken(props["repo"], options.salt, tokenMap);
  }
  return {
    ...location,
    name: location.name
      ? hashToken(location.name, options.salt, tokenMap)
      : undefined,
    fullyQualifiedName: location.fullyQualifiedName
      ? hashToken(location.fullyQualifiedName, options.salt, tokenMap)
      : undefined,
    properties: props,
  };
}

const FILE_PATH_PATTERN =
  /(?:\.\/|\.\.\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs)\b/g;

function redactText(
  text: string,
  options: RedactionOptions,
  tokenMap: Map<string, string>,
): string {
  // Replace identifiers that look like service/module names
  let result = text.replace(
    /\b[A-Z][a-zA-Z]+(?:Service|Module|Controller|Handler|Manager|Repository|Factory)\b/g,
    (match) => hashToken(match, options.salt, tokenMap),
  );

  // Optionally redact file paths
  if (options.redactFilePaths) {
    result = result.replace(FILE_PATH_PATTERN, (match) =>
      hashToken(match, options.salt, tokenMap),
    );
  }

  return result;
}

export function hashToken(
  value: string,
  salt: string,
  tokenMap: Map<string, string>,
): string {
  const existing = tokenMap.get(value);
  if (existing) return existing;

  const hash = createHash("sha256")
    .update(salt + value)
    .digest("hex")
    .slice(0, 8);

  const token = `[REDACTED:${hash}]`;
  tokenMap.set(value, token);
  return token;
}
