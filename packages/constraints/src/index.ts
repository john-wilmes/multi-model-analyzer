// config-schema-extractor.ts — tree-sitter-based ISC configuration field extractor
export { extractConfigSchemas } from "./config-schema-extractor.js";
// credential-access-extractor.ts — tree-sitter-based ISC credential access extractor
export { extractCredentialAccesses } from "./credential-access-extractor.js";
// constraint-builder.ts — merges ConfigSchema + CredentialAccess into ConstraintSet per integrator type
export { buildConstraintSets } from "./constraint-builder.js";
// config-validator.ts — validates a runtime config document against a ConstraintSet
export { validateConfig } from "./config-validator.js";
// types.ts — core domain types (ConfigField, ConfigSchema, ConfigSchemaExtractionResult, CredentialAccess, ...)
export type { ConfigField, ConfigSchema, ConfigSchemaExtractionResult } from "./types.js";
export type {
  AccessKind,
  GuardCondition,
  CredentialAccess,
  CredentialPattern,
  CredentialAccessResult,
} from "./types.js";
export type {
  RequirementLevel,
  FieldConstraint,
  ConstraintSet,
  ConstraintSetResult,
} from "./types.js";
export type { ViolationKind, Violation, SuggestedChange, ValidationResult } from "./types.js";
