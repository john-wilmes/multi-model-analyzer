/**
 * hardcoded-credential-detector.ts — SARIF rule config/hardcoded-credential-default
 *
 * Detects credential fields in ISC configuration schemas that have non-placeholder
 * string default values. Such defaults may represent real secrets hardcoded in
 * source code, which poses a security risk: any account not overriding the field
 * will silently use the hardcoded value.
 */

import type { ConstraintSet } from "./types.js";
import type { SarifResult, SarifReportingDescriptor } from "@mma/core";
import { createSarifResult } from "@mma/core";

export const HARDCODED_CREDENTIAL_RULES: readonly SarifReportingDescriptor[] = [
  {
    id: "config/hardcoded-credential-default",
    shortDescription: {
      text: "Credential field has a hardcoded default value that appears to be a real secret",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
];

/**
 * Field name substrings (case-insensitive) that indicate a credential-like field.
 * `username` is handled separately (requires longer default values).
 */
const CREDENTIAL_SUBSTRINGS = [
  "password",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "privatekey",
  "private_key",
] as const;

/** Known placeholder values that should NOT trigger the rule (case-insensitive). */
const PLACEHOLDER_VALUES = new Set([
  "",
  "changeme",
  "todo",
  "replace_me",
  "your-api-key",
  "your_api_key",
  "xxx",
  "test",
  "default",
  "placeholder",
  "example",
  "none",
  "null",
  "undefined",
  "n/a",
  "na",
  "tbd",
  "insert_here",
]);

function isCredentialField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return CREDENTIAL_SUBSTRINGS.some((sub) => lower.includes(sub));
}

function isUsernameField(fieldName: string): boolean {
  return fieldName.toLowerCase().includes("username");
}

function isSuspiciousDefault(value: unknown, isUsername: boolean): boolean {
  if (typeof value !== "string") {
    // Booleans, numbers, arrays, objects are not suspicious for credential secrets
    return false;
  }

  const minLength = isUsername ? 4 : 3;
  if (value.length < minLength) {
    return false;
  }

  const lower = value.toLowerCase().trim();
  return !PLACEHOLDER_VALUES.has(lower);
}

/**
 * Scans constraint sets for credential fields with suspicious hardcoded defaults.
 * Returns SARIF results — one per suspicious field per integrator type.
 */
export function detectHardcodedCredentialDefaults(
  constraintSets: readonly ConstraintSet[],
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const cs of constraintSets) {
    for (const field of cs.fields) {
      if (!("defaultValue" in field) || field.defaultValue === undefined) {
        continue;
      }

      const isUsername = isUsernameField(field.field);
      const isCredential = isCredentialField(field.field) || isUsername;
      if (!isCredential) {
        continue;
      }

      if (!isSuspiciousDefault(field.defaultValue, isUsername)) {
        continue;
      }

      const valueLength = (field.defaultValue as string).length;
      const message =
        `Integrator type '${cs.integratorType}' has hardcoded default for credential field '${field.field}'. ` +
        `Accounts not overriding this field will silently use the hardcoded value.`;

      const firstEvidence = field.evidence[0];

      const locations = [
        {
          logicalLocations: [
            {
              fullyQualifiedName: `${cs.integratorType}/${field.field}`,
              kind: "member",
            },
          ],
          ...(firstEvidence
            ? {
                physicalLocation: {
                  artifactLocation: { uri: firstEvidence.file },
                  region: { startLine: firstEvidence.line },
                },
              }
            : {}),
        },
      ];

      const result = createSarifResult(
        "config/hardcoded-credential-default",
        "warning",
        message,
        {
          locations,
          properties: {
            integratorType: cs.integratorType,
            field: field.field,
            defaultValueLength: valueLength,
          },
        },
      );

      results.push(result);
    }
  }

  return results;
}
