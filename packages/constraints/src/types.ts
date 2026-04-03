/** A field in an integrator's configuration schema */
export interface ConfigField {
  /** Field name (dotted path for nested: "internalLoginService.mode") */
  readonly name: string;
  /** Inferred type from the type constructor or default value */
  readonly inferredType: "string" | "number" | "boolean" | "array" | "object" | "unknown";
  /** Whether the field has a default value */
  readonly hasDefault: boolean;
  /** The default value, if present */
  readonly defaultValue?: unknown;
  /** Whether the field is explicitly marked required */
  readonly required: boolean | undefined;
  /** Description from the configuration object */
  readonly description?: string;
  /** Extended metadata (category, friendlyName, visible, editable, isSensitive) */
  readonly metadata?: Record<string, unknown>;
  /** Source location */
  readonly source: { readonly file: string; readonly line: number };
}

/** Schema extracted from a static configuration object for one integrator type */
export interface ConfigSchema {
  /** Integrator type name (e.g., "eclinicalworks10e") */
  readonly integratorType: string;
  /** All fields found in the configuration object */
  readonly fields: readonly ConfigField[];
  /** Files the schema was extracted from */
  readonly sourceFiles: readonly string[];
  /** Vendor parent type, if this is a vendor extension */
  readonly extendsType?: string;
}

/** Result of extracting schemas from a codebase */
export interface ConfigSchemaExtractionResult {
  readonly schemas: readonly ConfigSchema[];
  readonly errors: readonly { file: string; error: string }[];
}

// ─── Phase 2: Credential access types ────────────────────────────────────────

/** Which config domain a field belongs to */
export type ConfigDomain = "credentials" | "integrator-settings" | "account-settings";

/** How a credential field is accessed */
export type AccessKind = "read" | "write" | "default-fallback";

/** A guard condition enclosing a credential access */
export interface GuardCondition {
  /** The credential field being tested */
  readonly field: string;
  /** The comparison operator or truthiness check */
  readonly operator: "truthy" | "falsy" | "==" | "!=" | "typeof" | "||" | "&&";
  /** Comparison value, if applicable */
  readonly value?: string;
  /** Whether the condition is negated (inside else branch or !condition) */
  readonly negated: boolean;
  /** Which config domain this guard field belongs to */
  readonly domain?: ConfigDomain;
}

/** A single credential field access site */
export interface CredentialAccess {
  /** The field name (dotted path for nested, e.g., "internalLoginService.mode") */
  readonly field: string;
  /** Source file */
  readonly file: string;
  /** Line number */
  readonly line: number;
  /** How the field is accessed */
  readonly accessKind: AccessKind;
  /** Whether this access has a default fallback (|| config.default or _.get with default) */
  readonly hasDefault: boolean;
  /** Whether this access came from a destructuring pattern (not a member_expression) */
  readonly isDestructured?: boolean;
  /** Guard conditions enclosing this access */
  readonly guardConditions: readonly GuardCondition[];
  /** Raw text of guard conditions that could not be parsed into structured GuardCondition objects */
  readonly rawGuardTexts?: readonly string[];
}

/** The access pattern that matched */
export type CredentialPattern =
  | "self.options.integrator.credentials"
  | "this.options.integrator.credentials"
  | "destructuring"
  | "lodash-get"
  | "this.credentials"
  | "credentials-param";

/** Result of extracting credential accesses from source files */
export interface CredentialAccessResult {
  readonly accesses: readonly CredentialAccess[];
  readonly errors: readonly { file: string; error: string }[];
  readonly stats: {
    readonly filesScanned: number;
    readonly filesWithAccesses: number;
    readonly totalAccesses: number;
    readonly byPattern: Record<string, number>;
  };
}

// ─── Phase 3: Constraint set types ───────────────────────────────────────────

/** Requirement level for a field in the constraint set */
export type RequirementLevel = 'always' | 'conditional' | 'never';

/** A merged constraint for a single field */
export interface FieldConstraint {
  /** Field name (dotted path) */
  readonly field: string;
  /** Whether the field is required */
  readonly required: RequirementLevel;
  /** Default value from configuration schema, if any */
  readonly defaultValue?: unknown;
  /** Inferred type from configuration schema */
  readonly inferredType?: string;
  /** Description from configuration schema */
  readonly description?: string;
  /** Extended metadata from configuration schema */
  readonly metadata?: Record<string, unknown>;
  /** When required='conditional', the conditions under which it's required */
  readonly conditions?: readonly {
    readonly requiredWhen: readonly GuardCondition[];
    readonly evidence: readonly { readonly file: string; readonly line: number }[];
  }[];
  /** Literal values seen in comparisons (from guard conditions) */
  readonly knownValues?: readonly string[];
  /** All evidence sites (file:line of accesses) */
  readonly evidence: readonly { readonly file: string; readonly line: number }[];
}

/** The merged constraint model for one integrator type */
export interface ConstraintSet {
  /** Integrator type name */
  readonly integratorType: string;
  /** Field constraints */
  readonly fields: readonly FieldConstraint[];
  /** Unresolvable dynamic accesses (_.get with computed paths, etc.) */
  readonly dynamicAccesses: readonly {
    readonly file: string;
    readonly line: number;
    readonly pattern: string;
  }[];
  /** Coverage metrics */
  readonly coverage: {
    /** Total credential accesses found */
    readonly totalAccesses: number;
    /** Accesses that could be resolved to a field name */
    readonly resolvedAccesses: number;
    /** Accesses that couldn't be resolved */
    readonly unresolvedAccesses: number;
  };
}

/** Result of building constraint sets */
export interface ConstraintSetResult {
  readonly constraintSets: readonly ConstraintSet[];
  readonly errors: readonly { integratorType: string; error: string }[];
}

// ─── Phase 4: Validation types ──────────────────────────────────────────────

/** The kind of violation found */
export type ViolationKind = 'missing-required' | 'missing-conditional' | 'unexpected-type' | 'unknown-field';

/** A single validation violation */
export interface Violation {
  /** The field with the issue */
  readonly field: string;
  /** The kind of violation */
  readonly kind: ViolationKind;
  /** Human-readable detail message */
  readonly detail: string;
  /** Evidence from static analysis supporting this violation */
  readonly evidence: readonly { readonly file: string; readonly line: number }[];
}

/** A suggested change to make the config valid */
export interface SuggestedChange {
  /** The field to change */
  readonly field: string;
  /** The action to take */
  readonly action: 'add' | 'remove' | 'set';
  /** Suggested value, if applicable */
  readonly suggestion?: unknown;
}

/** Result of validating a config against a ConstraintSet */
export interface ValidationResult {
  /** Whether the config is valid (no violations) */
  readonly valid: boolean;
  /** List of violations found */
  readonly violations: readonly Violation[];
  /** Nearest valid config (changes needed to fix violations) */
  readonly nearestValid?: {
    readonly changes: readonly SuggestedChange[];
    readonly distance: number;
  };
  /** Coverage from the ConstraintSet (pass-through so consumer knows confidence) */
  readonly coverage: ConstraintSet['coverage'];
}

// ─── Phase 2c: Cross-entity dependency types ─────────────────────────────────

/** A cross-entity dependency: field in domain A is guarded by a condition on domain B */
export interface CrossEntityDependency {
  readonly accessedDomain: ConfigDomain;
  readonly integratorType: string | null;
  readonly accessedField: string;
  readonly guard: GuardCondition & { readonly domain: ConfigDomain };
  readonly evidence: readonly { readonly file: string; readonly line: number }[];
}

export interface CrossEntityDependencyResult {
  readonly dependencies: readonly CrossEntityDependency[];
  readonly stats: {
    readonly totalAccesses: number;
    readonly crossEntityAccesses: number;
  };
}
