# Configuration Validation & Feature Interaction Analysis

Plan for extending MMA's static analysis to cover application settings, credentials, and their interactions with feature flags — enabling agents to validate configurations before deployment.

## Problem

Large codebases have hundreds of configuration parameters (settings, credentials, feature flags) whose valid values depend on each other. The combinatorial space is beyond human comprehension, but the *actual* valid configurations are a manageable subset defined by constraints in the code. Today, misconfigurations are caught at runtime (or not at all). Static analysis can surface these constraints and check configurations against them *before* deployment.

## What exists today

MMA already has the building blocks:

| Component | Location | What it does |
|-----------|----------|-------------|
| Flag scanner | `packages/heuristics/src/flags.ts` | Extracts feature flags from code (SDK calls, env vars, custom patterns) |
| Constraint extractor | `packages/models/config/src/constraints.ts` | Finds mutex (if-else chains) and range constraints between flags |
| Feature model builder | `packages/models/config/src/feature-model.ts` | Infers requires/excludes/implies from co-location and dependency graphs |
| SAT validator | `packages/models/config/src/z3.ts` | Heuristic dead-flag, always-on, untested-interaction checks |
| SARIF diagnostics | `config/dead-flag`, `config/always-on-flag`, etc. | 7 config rules defined, 5 emitting findings |
| Core types | `packages/core/src/types.ts` | `FeatureFlag`, `FeatureModel`, `FeatureConstraint`, `ConstraintKind` |

Constraint kinds: `requires | excludes | implies | mutex | range`

## Design principles

1. **Generic, not vendor-specific.** No hardcoded setting names, credential types, or framework assumptions. Users configure patterns via `RepoConfig` (same as flag scanner).
2. **Additive to existing model.** Settings and credentials become first-class participants in the `FeatureModel` alongside flags — same constraint types, same SAT checking, same SARIF output.
3. **Static analysis only.** No runtime data, no database queries. Everything derived from code in the repo.
4. **Configurable patterns.** Each repo can declare its own setting access patterns, credential types, and constraint idioms via config.

## Phase 1: Settings scanner ✓ Complete

**Goal:** Extract application settings from code the same way we extract feature flags.

### What to scan for

Settings access patterns (generic, not framework-specific):

| Pattern | Example | Detection |
|---------|---------|-----------|
| Property access on config objects | `config.retryLimit`, `settings.timeout` | Tree-sitter: member_expression where object matches configured names |
| Destructured config | `const { retryLimit } = config` | Tree-sitter: object_pattern from configured source |
| Environment variables | `process.env.DATABASE_URL` | Already partially covered by flag scanner (FEATURE_* prefix) — generalize |
| Schema/validation declarations | `z.object({ port: z.number().min(1).max(65535) })` | Tree-sitter: call chains on configured validator libraries |
| Default value assignments | `config.timeout ?? 30000` | Tree-sitter: nullish coalescing / logical OR with literals |

### New types

```typescript
// packages/core/src/types.ts

export interface ConfigParameter {
  readonly name: string;
  readonly locations: readonly LogicalLocation[];
  readonly kind: "setting" | "credential" | "flag";  // unified taxonomy
  readonly valueType?: "string" | "number" | "boolean" | "enum" | "unknown";
  readonly defaultValue?: unknown;
  readonly enumValues?: readonly string[];  // if detected from validation/switch
  readonly rangeMin?: number;               // if detected from validation
  readonly rangeMax?: number;
  readonly source?: string;                 // e.g., "env", "config-file", "database"
  readonly description?: string;
}

export interface ConfigInventory {
  readonly parameters: readonly ConfigParameter[];
  readonly repo: string;
}
```

### Scanner options (per-repo configurable)

```typescript
// packages/heuristics/src/settings.ts

export interface SettingsScannerOptions {
  readonly configObjectNames?: readonly string[];    // e.g., ["config", "settings", "options"]
  readonly envVarPrefixes?: readonly string[];        // e.g., ["DATABASE_", "REDIS_", "API_"]
  readonly credentialPatterns?: readonly string[];    // e.g., ["*_KEY", "*_SECRET", "*_TOKEN"]
  readonly validatorLibraries?: readonly string[];   // e.g., ["zod", "joi", "yup"]
  readonly excludePaths?: readonly RegExp[];          // test files, fixtures
}
```

### Implementation

New file: `packages/heuristics/src/settings.ts`
- `scanForSettings(files, repo, options)` -> `ConfigInventory`
- Reuses tree-sitter traversal patterns from `flags.ts`
- Shares test-path exclusion logic

Wire into indexing pipeline: `apps/cli/src/commands/indexing/phase-heuristics.ts`
- Run alongside `scanForFlags()`
- Store results in KV under `config-inventory:<repo>`

### SARIF rules (new)

| Rule ID | Severity | Trigger |
|---------|----------|---------|
| `config/unused-setting` | note | Setting declared in schema but never read in code |
| `config/unvalidated-setting` | warning | Setting read from env/config with no validation |
| `config/hardcoded-credential` | error | Credential value appears as string literal |

## Phase 2: Unified constraint extraction ✓ Complete

**Goal:** Detect constraints *between* settings, flags, and credentials — not just between flags.

### Constraint patterns to detect

| Pattern | Code shape | Constraint |
|---------|-----------|------------|
| Guard clause | `if (settings.provider === 'epic') { require(config.hl7Enabled) }` | `provider=epic` requires `hl7Enabled=true` |
| Switch dispatch | `switch (integrationType) { case 'fhir': ... case 'hl7': ... }` | `integrationType` mutex over its cases |
| Validation schema | `z.discriminatedUnion('type', [...])` | Discriminator field constrains which sub-schemas are valid |
| Conditional default | `timeout = isProduction ? 30000 : 5000` | `environment` constrains `timeout` range |
| Credential requirement | `if (provider === 'twilio') { assert(config.twilioSid) }` | `provider=twilio` requires `twilioSid` |
| Enum exhaustiveness | `switch (flag) { ... default: assertNever(flag) }` | Flag must be one of the enumerated values |

### Extended constraint types

```typescript
// Extend ConstraintKind
export type ConstraintKind =
  | "requires"    // A=x requires B=y
  | "excludes"    // A=x forbids B=y
  | "implies"     // A being set implies B must be set
  | "mutex"       // At most one of [A, B, C] can be active
  | "range"       // A must be in [min, max]
  | "conditional" // NEW: A=x constrains B to specific values
  | "enum"        // NEW: A must be one of [v1, v2, v3]

export interface FeatureConstraint {
  readonly kind: ConstraintKind;
  readonly flags: readonly string[];      // parameter names (flags + settings + credentials)
  readonly description: string;
  readonly source: "inferred" | "human" | "schema";  // NEW: "schema" for validation-derived
  readonly condition?: Record<string, unknown>;       // NEW: e.g., { provider: "epic" }
  readonly allowedValues?: readonly unknown[];        // NEW: for enum/conditional
}
```

### Implementation

Extend `packages/models/config/src/constraints.ts`:
- `extractConstraintsFromCode()` already walks tree-sitter AST for flag if-chains
- Add visitors for: switch statements, validation schemas, conditional assignments
- Accept `ConfigParameter[]` in addition to `FeatureFlag[]`

Extend `packages/models/config/src/feature-model.ts`:
- `buildFeatureModel()` accepts `ConfigInventory` alongside `FlagInventory`
- Constraint inference operates on unified parameter set

## Phase 3: SAT-based validation ✓ Complete

**Goal:** Use constraint solving to answer: "Given parameters X with values Y, what is required/forbidden/suspicious?"

### Validation queries

| Query | Use case |
|-------|----------|
| **Satisfiability** | "Is this combination of settings valid?" |
| **Dead parameter** | "Can this setting ever be used given current constraints?" |
| **Missing dependency** | "Setting A=x is set but required setting B is missing" |
| **Conflict detection** | "Settings A and B contradict each other" |
| **Minimal configuration** | "What's the smallest valid config for integration type X?" |
| **Impact analysis** | "If I change setting A, what else might break?" |

### Implementation

Extend `packages/models/config/src/z3.ts`:
- Current heuristic checks become the fallback (no-dependency path)
- Optional z3-solver WASM integration for full SAT/SMT when installed
- New functions: `validateConfiguration(model, partialConfig)`, `findMinimalConfig(model, constraints)`

### New SARIF rules

| Rule ID | Severity | Trigger |
|---------|----------|---------|
| `config/dead-setting` | warning | Setting can never be used given constraints |
| `config/missing-dependency` | warning | Setting requires another that isn't configured |
| `config/conflicting-settings` | error | Two settings contradict each other |
| `config/unused-registry-flag` | note | Flag in registry enum but not referenced in code |
| `config/unregistered-flag` | warning | Flag in code but missing from registry enum |

### MCP tools

Extend `packages/mcp/src/`:
- `get_config_model` — return the full constraint graph for a repo
- `validate_config` — check a partial configuration against constraints
- `get_config_impact` — blast radius of changing a setting
- Extend existing `get_flag_inventory` to include settings/credentials

## Phase 4: Combinatorial interaction testing (CIT) support ✓ Complete

**Goal:** Generate minimal test configurations that cover all pairwise (or t-way) parameter interactions.

### Background

For N parameters with K values each, exhaustive testing requires K^N configurations. Pairwise (2-way) covering arrays reduce this to O(K^2 * log N) — typically 95%+ fault detection rate in practice (Kuhn et al., NIST).

### Implementation

New file: `packages/models/config/src/covering-array.ts`
- `generateCoveringArray(model, strength)` -> array of configurations
- Strength 2 (pairwise) by default; configurable up to 6-way
- Algorithm: greedy IPOG (In-Parameter-Order-General) — well-studied, no dependencies
- Output: array of `Record<string, unknown>` representing test configurations

### SARIF integration

| Rule ID | Severity | Trigger |
|---------|----------|---------|
| `config/untested-interaction` | note | Already exists — extend to settings pairs |
| `config/high-interaction-strength` | note | Parameter participates in 3+ way interaction |

### MCP tools

- `get_test_configurations` — generate covering array for a repo's config space
- `get_interaction_strength` — how many parameters interact with a given one

## Repo configuration

All scanner options go in the existing per-repo config (same pattern as flag scanner):

```jsonc
// mma.config.json
{
  "repos": [
    {
      "url": "https://github.com/org/service",
      "settings": {
        "configObjectNames": ["config", "settings", "appConfig"],
        "envVarPrefixes": ["DATABASE_", "REDIS_", "API_"],
        "credentialPatterns": ["*_KEY", "*_SECRET", "*_TOKEN", "*_PASSWORD"],
        "validatorLibraries": ["zod", "joi"]
      }
    }
  ]
}
```

## Dependencies

- **Phase 1-2:** Zero new dependencies (tree-sitter + existing infrastructure)
- **Phase 3:** Optional `z3-solver` (WASM, ~8MB) for full SAT — heuristic fallback works without it
- **Phase 4:** Zero new dependencies (IPOG is ~200 lines of code)

## Implementation order

1. **Phase 1** — Settings scanner. Natural extension of flag scanner. Immediate value: visibility into what settings exist and where they're used.
2. **Phase 3 partial** — `config/unused-registry-flag` and `config/unregistered-flag` SARIF rules (these are flag-only, no settings needed).
3. **Phase 2** — Unified constraints. Requires Phase 1 output. High value: surfaces hidden dependencies.
4. **Phase 3 full** — SAT validation. Requires Phase 2. The agent-facing payoff.
5. **Phase 4** — CIT. Requires Phase 3. Generates actionable test plans.

## References

- Apel, S. et al. "Feature Interactions: A Survey" — SPL feature interaction taxonomy
- Kuhn, D.R. et al. "Software Fault Interactions and Implications for Software Testing" (IEEE TSE 2004) — empirical basis for t-way CIT
- ACTS (NIST) — reference implementation for covering array generation
- Nadi, S. et al. "Mining Configuration Constraints" (ICSE 2014) — constraint extraction from code
- Lillack, M. et al. "Tracking Load-Time Configuration Options" (IEEE TSE 2018) — config-to-code mapping
