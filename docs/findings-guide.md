# Findings Guide

Reference for all diagnostics produced by Multi-Model Analyzer. Each finding appears as a SARIF result with a `ruleId`, severity `level`, and human-readable `message`. This guide explains what each rule detects, when it fires, what to do about it, and when it's safe to ignore.

## Quick Reference

| Rule ID | Severity | Category | Summary |
|---------|----------|----------|---------|
| `config/dead-flag` | warning | Configuration | Flag can never be enabled |
| `config/always-on-flag` | note | Configuration | Flag is always enabled |
| `config/missing-constraint` | warning | Configuration | Flag used without dependency validation |
| `config/untested-interaction` | note | Configuration | Flag pair lacks test coverage |
| `config/format-violation` | error | Configuration | Parameter violates type/range constraint |
| `config/unused-registry-flag` | note | Configuration | Registry flag declared but never consumed |
| `config/unregistered-flag` | warning | Configuration | Flag exists in code but not in the registry |
| `config/dead-setting` | warning | Configuration | Setting exists but is never read |
| `config/missing-dependency` | warning | Configuration | Setting depends on another setting that is absent |
| `config/conflicting-settings` | error | Configuration | Two settings have contradictory values |
| `config/high-interaction-strength` | note | Configuration | Parameter pair has high interaction strength |
| `isc/missing-required` | error | ISC Constraints | Required credential field absent from runtime config |
| `isc/missing-conditional` | warning | ISC Constraints | Conditionally required field absent (guard condition met) |
| `isc/unexpected-type` | warning | ISC Constraints | Credential field has wrong runtime type |
| `isc/unknown-field` | note | ISC Constraints | Config field not found in static analysis constraint set |
| `fault/unhandled-error-path` | warning | Fault Tree | Catch block with no logging or re-throw |
| `fault/silent-failure` | warning | Fault Tree | Error condition swallowed silently |
| `fault/missing-error-boundary` | warning | Fault Tree | Async operation with no error handler |
| `fault/cascading-failure-risk` | note | Fault Tree | Cross-service call chain, no circuit breaker |
| `structural/dead-export` | note | Structural | Exported symbol never imported |
| `structural/unstable-dependency` | warning | Structural | Stable module depends on unstable module |
| `structural/pain-zone-module` | note | Structural | Concrete and stable — hard to change |
| `structural/uselessness-zone-module` | note | Structural | Over-abstracted with few dependents |
| `arch/layer-violation` | configurable | Architecture | Import crosses layer boundary |
| `arch/forbidden-import` | configurable | Architecture | Import matches forbidden pattern |
| `arch/dependency-direction` | configurable | Architecture | Import violates denied directional pair |
| `temporal-coupling/co-change` | warning/note | Temporal Coupling | Files change together suspiciously often |
| `vuln/reachable-dependency` | error/warning | Vulnerability | Vulnerable package is imported in code |
| `hotspot/high-churn-complexity` | warning/note | Hotspot | File with high churn and complexity |
| `blast-radius/high-pagerank` | note | Blast Radius | File has high transitive importance |
| `cross-repo/breaking-change-risk` | warning | Cross-Repo | Breaking API change affects downstream repos |
| `cross-repo/orphaned-service` | note | Cross-Repo | Service has no consumers in the analyzed repos |
| `cross-repo/shared-flag` | note | Cross-Repo | Feature flag is shared across multiple repos |
| `cross-repo/cascading-fault` | warning | Cross-Repo | Fault in one repo can cascade to dependents |
| `cross-repo/undocumented-consumer` | note | Cross-Repo | Repo consumes a service with no documentation |
| `cross-repo/critical-path` | warning | Cross-Repo | Repo heads a dependency chain 4+ hops long |

## Reading SARIF Output

The analyzer writes all findings to a single SARIF v2.1.0 log stored at KV key `sarif:latest`. Each result contains:

- **`ruleId`** — the identifier from the table above
- **`level`** — `error`, `warning`, or `note`
- **`message.text`** — human-readable description with file paths and metric values
- **`locations[].logicalLocations`** — the module or symbol involved (no source code)
- **`baselineState`** — `new`, `unchanged`, `updated`, or `absent` (compared to previous run)
- **`properties`** — rule-specific metadata (scores, counts, thresholds)

Baseline tracking means re-running the analyzer shows which findings are new, which persist, and which were resolved since the last run.

---

## Configuration Model

Source: `packages/models/config/src/z3.ts`

These rules validate feature flag models built from code scanning. Constraint checking uses SAT-solver logic to find flags that are logically dead, always on, or insufficiently tested.

### `config/dead-flag`

**Severity:** warning

**What it means:** A feature flag can never be enabled given the current constraint set. The flag exists in code but the combination of `excludes` and `requires` constraints makes it logically impossible to turn on.

**Trigger:** The flag has `excludes` constraints from other flags but no `requires` constraint that would pull it in. Specifically: `excludingConstraints.length > 0 && requiredBy.length === 0`.

**Action:** Remove the dead flag and its associated code paths, or fix the constraints if the exclusion was unintentional.

**When to ignore:** The flag may be intentionally disabled as a kill switch that was turned off permanently. Check git history for context before removing.

### `config/always-on-flag`

**Severity:** note

**What it means:** A feature flag is always enabled regardless of configuration. Every other flag in the model requires this one, and nothing excludes it.

**Trigger:** The flag is in a `requires` constraint as a dependency, has no `excludes` constraints, and the number of flags that require it equals `model.flags.length - 1` (all other flags).

**Action:** If the flag is truly always on, simplify the code by removing the conditional and inlining the "enabled" path. The flag adds complexity without providing a toggle.

**When to ignore:** The flag may serve as a future kill switch or a dependency marker for documentation purposes. Acceptable to keep if the team prefers explicit feature boundaries.

### `config/missing-constraint`

**Severity:** warning

**What it means:** A flag is used in code without validation that its dependencies are met. The flag's behavior depends on other flags but no constraint enforces the relationship.

**Trigger:** Defined in `CONFIG_RULES` but detection is pending full Z3 integration.

**Action:** Add explicit constraints between the flag and its dependencies in the feature model configuration.

**When to ignore:** If the flag operates independently at runtime and the "dependency" is only a code-level convenience, not a logical requirement.

### `config/untested-interaction`

**Severity:** note

**What it means:** Two flags interact (inferred from constraints with `source: "inferred"`) but no test exercises both flags simultaneously.

**Trigger:** A constraint between two flags has `source: "inferred"` and `flags.length === 2`. The pair appears in the model but has no corresponding test coverage.

**Action:** Add an integration test that enables both flags simultaneously and verifies correct behavior. Flag interactions are a common source of production incidents.

**When to ignore:** If the two flags are in completely separate subsystems with no shared state, the interaction may be a false positive from the inference engine.

### `config/format-violation`

**Severity:** error

**What it means:** A flag parameter value violates its declared type or range constraint. For example, a numeric flag set outside its min/max bounds.

**Trigger:** Defined in `CONFIG_RULES` but detection is pending full Z3 integration.

**Action:** Fix the parameter value to conform to its declared constraints. This is the highest-severity configuration finding because it indicates a concrete misconfiguration.

**When to ignore:** Rarely safe to ignore. If the constraint definition is wrong rather than the value, update the constraint.

### `config/unused-registry-flag`

**Severity:** note

**What it means:** A flag that is marked as the authoritative registry definition (`isRegistry: true`) appears in only one location — the registry itself. This means the flag was declared in the registry but is never referenced in any consuming code.

**Trigger:** `flag.isRegistry === true && flag.locations.length <= 1`. The registry entry is counted as one location; a flag with no additional usages has length 1 (or 0).

**Action:** Either add usages of the flag in consuming code, or remove the registry entry if the flag is no longer needed. Registry flags with no consumers add dead weight to the feature model.

**When to ignore:** Flags that are pre-declared in the registry in advance of rollout. If the flag is actively being developed and consumption code is forthcoming, it is safe to suppress temporarily.

### `config/unregistered-flag`

**Severity:** warning

**What it means:** A feature flag appears in code but has no corresponding registry entry. The model contains at least one registry flag (`isRegistry: true`), indicating a registry is in use for this codebase, but this flag was not registered there.

**Trigger:** The model contains at least one flag with `isRegistry === true`, and this flag does not have `isRegistry === true`. Only fires when a registry exists — models with no registry flags produce no `config/unregistered-flag` findings.

**Action:** Add the flag to the feature registry so it is tracked, searchable, and subject to lifecycle governance (e.g., stale-flag cleanup). Unregistered flags are invisible to tooling that relies on the registry.

**When to ignore:** Flags that are intentionally managed outside the registry (e.g., third-party SDK flags or infrastructure toggles that follow a different governance process). Document the exception if suppressing.

### `config/dead-setting`

**Severity:** warning

**What it means:** A non-flag parameter (setting or credential) exists in the model but can never be used. Like `config/dead-flag`, but for settings: the parameter is excluded by at least one constraint and no constraint requires it.

**Trigger:** The parameter has `kind !== "flag"`, appears in at least one `excludes` constraint, and no `requires` constraint names it as a target. Mirrors `findDeadFlags` logic but operates on `model.parameters`.

**Action:** Remove the dead setting or fix the constraints if the exclusion was unintentional. Dead settings add noise to the configuration model and may indicate stale configuration that was never cleaned up.

**When to ignore:** Settings that are intentionally disabled as kill switches or reserved for future use. Check whether the exclusion constraint is correct before removing the setting.

### `config/missing-dependency`

**Severity:** warning

**What it means:** A setting has a `requires` constraint pointing at another parameter, but that target parameter is not defined anywhere in the model (neither in flags nor parameters). The dependency cannot be satisfied.

**Trigger:** A `requires` constraint has a `source` parameter that exists in the model but a `target` parameter that does not appear in `model.flags` or `model.parameters`. Emits the message: `"<requiredBy>" requires "<parameter>"[when <condition>] but no definition was found`.

**Action:** Either add the missing parameter to the model, or remove the `requires` constraint if the dependency is no longer needed. This typically indicates a parameter was renamed or removed without updating its dependents.

**When to ignore:** Rarely safe to ignore. If the dependency is on a parameter from an external configuration source not scanned by the analyzer, suppress with a comment explaining the external dependency.

### `config/conflicting-settings`

**Severity:** error

**What it means:** Two settings have contradictory constraints — one parameter both requires and excludes another, making it impossible to satisfy both constraints simultaneously.

**Trigger:** A parameter `A` has a `requires` constraint targeting `B`, and also an `excludes` constraint targeting `B` (directly or symmetrically). Emits: `"<A>" both requires and excludes "<B>" — contradictory constraints`.

**Action:** Fix the constraint model. Either the `requires` or the `excludes` constraint is wrong. This is a modeling error that must be resolved — there is no valid configuration that can satisfy both.

**When to ignore:** Never — contradictory constraints indicate a logic error in the feature model.

### `config/high-interaction-strength`

**Severity:** note

**What it means:** A parameter participates in complex interactions with 3 or more other parameters. High interaction strength means the parameter's behavior depends on many others, requiring higher-order combinatorial testing to cover all interaction paths.

**Trigger:** A parameter either (a) appears in a single constraint of arity ≥ 3, or (b) co-occurs with 3 or more distinct other parameters across all constraints. Emits: `Parameter "<name>" participates in 3+ way interactions — consider higher-order combinatorial testing`.

**Action:** Add pairwise or higher-order combinatorial tests (e.g., using t-way testing tools) that cover the parameter's interactions. Consider whether the parameter can be decomposed into simpler, more independent units.

**When to ignore:** Parameters that are central to the system architecture will naturally have many interactions. This finding is informational — it highlights which parameters need the most thorough test coverage.

---

## ISC Constraint Validation

Source: `packages/constraints/src/config-validator.ts`

These rules validate runtime integrator configurations against constraint sets extracted by static analysis of integrator-service-clients (ISC) code. Constraint sets are built per integrator type by analyzing `configuration` schema objects and credential access patterns in ISC source files. Each constraint set tracks coverage metrics so consumers know the confidence level of the analysis.

The constraint extraction pipeline (`packages/constraints`) works in three stages:
1. **Schema extraction** — parses static `configuration` objects to discover fields, types, defaults, and required flags
2. **Credential access extraction** — walks tree-sitter ASTs to find all `self.options.integrator.credentials.*` access sites, guard conditions, and default fallbacks
3. **Constraint building** — merges schema and access data to classify each field as `always` required, `conditional`, or `never` required

### `isc/missing-required`

**Severity:** error

**What it means:** A credential field that is always required by the integrator type is absent from the runtime configuration. The integrator will fail at runtime when it attempts to access this field.

**Trigger:** The constraint set marks the field with `requirement: "always"` (the field appears in the configuration schema with `required: true` and no default value, or every code path accesses the field unconditionally). The runtime config object does not contain a key matching the field name.

**Action:** Add the missing field to the integrator's credentials. Check the constraint set's `evidence` array for the source files and line numbers where the field is required.

**When to ignore:** If the constraint set's coverage is below 100% (`coverage.resolvedAccesses / (resolvedAccesses + unresolvedAccesses)`), the field may be required only in code paths the analyzer couldn't resolve. Check the evidence before dismissing.

### `isc/missing-conditional`

**Severity:** warning

**What it means:** A credential field is conditionally required based on a guard condition that appears to be met in the runtime config, but the field is absent. For example, if `useOAuth2` is `true`, then `oauthClientId` is required.

**Trigger:** The constraint set marks the field with `requirement: "conditional"` and includes a `requiredWhen` guard. The guard condition evaluates to true against the runtime config (e.g., the guard field exists and matches the expected value), but the conditional field is missing.

**Action:** Either add the missing conditional field or change the guard field's value so the condition is no longer met. The `requiredWhen` property on the constraint describes the exact condition.

**When to ignore:** Guard condition evaluation is heuristic — complex compound conditions or aliased variables may cause false positives. If the guard involves fields the analyzer couldn't fully resolve, verify manually.

### `isc/unexpected-type`

**Severity:** warning

**What it means:** A credential field exists in the runtime config but has a different type than what the configuration schema declares. For example, the schema says `port` should be a `number` but the runtime value is a string.

**Trigger:** The constraint set includes a `type` property for the field (extracted from the configuration schema's type annotations), and the runtime value's `typeof` does not match.

**Action:** Fix the field value to match the expected type. Type mismatches can cause subtle runtime bugs (e.g., string `"3000"` instead of number `3000` in port comparison).

**When to ignore:** Some fields are legitimately polymorphic (e.g., accept both string and number). Check the ISC source code to confirm whether the type annotation is strict.

### `isc/unknown-field`

**Severity:** note

**What it means:** A field exists in the runtime config but was not found in the constraint set for this integrator type. The field may be valid but was not seen during static analysis — it could be accessed via dynamic patterns (e.g., `_.get()`, computed property names) that the analyzer doesn't track.

**Trigger:** The runtime config contains a key that does not match any `FieldConstraint.field` in the constraint set, and the key is not a known container path (parent of known fields). Unknown nested subtrees are collapsed to the shallowest unknown ancestor to provide a minimal edit set.

**Action:** Verify that the field is actually consumed by the integrator. If it is, this is a false positive caused by a code pattern the analyzer doesn't cover. If it isn't, the field is dead config that should be removed.

**When to ignore:** Common for integrator types that use dynamic property access patterns (`_.get`, bracket notation). Check the coverage metrics — low coverage increases the likelihood of false positives.

---

## Fault Tree

Source: `packages/models/fault/src/fault-tree.ts`

These rules analyze control flow graphs to find gaps in error handling. The fault tree model traces backward from error/warning log statements to identify root causes and missing safety nets.

### `fault/unhandled-error-path`

**Severity:** warning

**What it means:** A `catch` block in the control flow graph has no logging statement and no re-throw. The error is silently swallowed — if something goes wrong at runtime, there will be no trace in logs and no propagation to callers.

**Trigger:** A CFG node of kind `catch` has no successor nodes matching the logging pattern (`/\b(console|log(ger)?)\s*\.\s*(log|error|warn|info|debug)\s*\(|\b(log|warn|error)\s*\(/`) and no successor of kind `throw`, and no error-forwarding pattern (`.catch(`, `reject(`, `next(err)`).

**Action:** Add logging inside the catch block (at minimum) or re-throw the error if the caller should handle it. Even a `console.error` is better than silence.

**When to ignore:** Catch blocks that intentionally suppress expected errors (e.g., "file not found" when checking optional config) are valid. Add a comment explaining why the error is suppressed.

### `fault/silent-failure`

**Severity:** warning

**What it means:** A `catch` block exists but has no reachable successor nodes — it is completely empty. The caught error is silently discarded with no logging, re-throw, or forwarding.

**Trigger:** A CFG node of kind `catch` has zero reachable nodes (`reachable.length === 0`). Emits: `Empty catch block in <functionId> silently swallows errors`.

**Action:** Add at minimum a logging statement inside the catch block. Even `console.error(err)` is better than silence. If the error is truly expected and harmless, add a comment explaining why it is safe to suppress.

**When to ignore:** Catch blocks that intentionally suppress known-harmless errors (e.g., `JSON.parse` of optional config that may be absent). Add a comment so the intent is clear to future readers.

### `fault/missing-error-boundary`

**Severity:** warning

**What it means:** An async function uses `await` but has no `try/catch` wrapper, meaning unhandled rejections can escape the function boundary.

**Trigger:** Fires when a function's control flow graph contains an `await` statement with no surrounding `try/catch` block. Implemented in `detectMissingErrorBoundaries()` (`apps/cli/src/commands/indexing/ast-utils.ts`).

**Action:** Wrap the `await` expression (or the entire async function body) in a `try/catch`. Unhandled promise rejections crash Node.js processes and create silent failures in browsers.

**When to ignore:** Top-level entry points (CLI scripts, test runners) that intentionally let errors propagate to an outer process handler may not need an explicit boundary.

### `fault/cascading-failure-risk`

**Severity:** note

**What it means:** A chain of cross-service calls exists with no circuit breaker, retry limit, or timeout pattern. A failure in a downstream service could cascade through the chain.

**Trigger:** Defined in `FAULT_RULES`. Detection is part of gap analysis expansion.

**Action:** Add circuit breaker patterns (e.g., using libraries like `opossum`), timeouts on outgoing calls, and fallback behavior when a dependency is unavailable.

**When to ignore:** Internal service-to-service calls within a monolith or within a tightly coupled deployment may not need circuit breakers if they share a failure domain.

---

## Structural

Source: `packages/structural/src/dead-exports.ts`, `packages/structural/src/metrics.ts`

Structural rules analyze the import/export graph and apply Robert C. Martin's package coupling metrics.

### `structural/dead-export`

**Severity:** note

**What it means:** A symbol is exported from a file but no other file in the repository imports that file. The export serves no purpose within the analyzed codebase.

**Trigger:** The file has exported symbols (`symbol.exported === true`), is not in the entry points set (package.json `main`/`bin`), and no import edge targets this file.

**Message format:** `N dead export(s) in <path>: <kind1> <name1>, <kind2> <name2>, ...` (one finding per file, listing all dead exports together)

**Action:** Remove the `export` keyword if the symbol is only used locally, or remove the symbol entirely if it's unused. Dead exports increase API surface area and create maintenance burden.

**When to ignore:**
- The symbol is part of a public package API consumed by external packages not in the analysis set.
- The file is an entry point not listed in the configured `entryPoints` set.
- The export is used via dynamic `import()` that the static analyzer cannot trace.

### `structural/unstable-dependency`

**Severity:** warning

**What it means:** A stable module (low instability) depends on an unstable module (high instability). This violates Robert C. Martin's Stable Dependencies Principle (SDP): dependencies should flow toward stability.

**Trigger:** For an import edge A → B: `B.instability - A.instability > threshold` where the default threshold is **0.3**.

- **Instability (I)** = Ce / (Ca + Ce), where Ce = efferent coupling (outgoing imports) and Ca = afferent coupling (incoming imports). Range: 0 (maximally stable) to 1 (maximally unstable).

**Message format:** `<source> (I=<value>) depends on <target> (I=<value>): stable module depends on unstable module (delta=<value>, threshold=<value>)`

**Action:** Introduce an abstraction (interface) in the stable module and have the unstable module implement it. This inverts the dependency direction while preserving the runtime behavior.

**When to ignore:** Small utility modules with few dependents may have high instability scores without being genuinely risky. SDP violations in test files or scripts are typically harmless.

### `structural/pain-zone-module`

**Severity:** note

**What it means:** The module is in the "pain zone" of Martin's instability/abstractness graph: it has **low instability** (many things depend on it, hard to change) and **low abstractness** (mostly concrete implementations, not interfaces). Changing this module is painful because it requires updating many dependents.

**Trigger:** Instability < 0.3 **and** Abstractness < 0.3.

- **Abstractness (A)** = (interfaces + type aliases) / total symbols. Range: 0 (all concrete) to 1 (all abstract).

**Message format:** `<module> is in the pain zone (I=<value>, A=<value>): concrete and stable, hard to change`

**Action:** Extract interfaces or type aliases from the concrete implementations. This raises abstractness toward the "main sequence" (A + I ≈ 1) without changing stability.

**When to ignore:** Foundational modules (e.g., core types, utility libraries) are expected to be stable and concrete. The pain zone is informational — it doesn't mean the module is broken, just that changes will have wide impact.

### `structural/uselessness-zone-module`

**Severity:** note

**What it means:** The module is in the "uselessness zone": it has **high instability** (few things depend on it) and **high abstractness** (mostly interfaces/types). The abstractions aren't earning their keep because nothing stable depends on them.

**Trigger:** Instability > 0.7 **and** Abstractness > 0.7.

**Message format:** `<module> is in the uselessness zone (I=<value>, A=<value>): over-abstracted with few dependents`

**Action:** Simplify by removing unnecessary abstractions or merge the interfaces into the modules that use them. Alternatively, if the abstractions are intended for future use, consider whether YAGNI applies.

**When to ignore:** Modules designed as plugin interfaces or extension points may legitimately be abstract and unstable if plugins are external to the analyzed codebase.

### Metrics Summary

The analyzer also computes aggregate metrics per repository (via `summarizeRepoMetrics`):

| Metric | Formula | Ideal |
|--------|---------|-------|
| Avg. Instability | mean of all module I values | Context-dependent (lower = more stable) |
| Avg. Abstractness | mean of all module A values | Context-dependent |
| Avg. Distance | mean of \|A + I - 1\| | Close to 0 (on the "main sequence") |
| Pain Zone Count | modules with I < 0.3, A < 0.3 | Low |
| Uselessness Zone Count | modules with I > 0.7, A > 0.7 | Low |

**Martin's Main Sequence:** The ideal relationship between abstractness and instability is A + I = 1. Modules on this line balance their abstraction level with their stability. Distance from the main sequence measures how far a module deviates from this ideal.

**Zone Classification:**
- **Pain zone** (I < 0.3, A < 0.3): Concrete and stable. Hard to modify.
- **Uselessness zone** (I > 0.7, A > 0.7): Abstract and unstable. Over-engineered.
- **Main sequence** (|A + I - 1| < 0.3): Well-balanced.
- **Balanced**: Everything else.

---

## Architecture

Source: `packages/heuristics/src/arch-rules.ts`

Architecture rules enforce configurable structural constraints on the import graph. Rules are defined in the project configuration and can have any severity level (`error`, `warning`, or `note`).

### `arch/layer-violation`

**Severity:** configurable (per rule definition)

**What it means:** A file in one architectural layer imports a file in a layer that is not in its `allowedDependencies` list. For example, a presentation layer file importing directly from the data access layer, bypassing the business logic layer.

**Trigger:** Configuration defines layers with glob patterns and allowed dependency lists. An import edge crosses from a file matching layer A's patterns to a file matching layer B's patterns, where B is not in A's `allowedDependencies`.

**Message format:** `Layer violation: "<source>" (<sourceLayer>) imports "<target>" (<targetLayer>). Allowed dependencies for <sourceLayer>: [<list>]`

**Action:** Restructure the import to go through the allowed intermediate layer, or update the layer configuration if the direct dependency is architecturally valid.

**When to ignore:** Test files often legitimately cross layer boundaries. Consider excluding test patterns from layer rule evaluation.

### `arch/forbidden-import`

**Severity:** configurable (per rule definition)

**What it means:** A file matching the `from` patterns imports a file matching one of the `forbidden` patterns. This enforces hard boundaries — for example, preventing frontend code from importing server-only modules.

**Trigger:** Configuration defines `from` (source glob patterns) and `forbidden` (target glob patterns). An import edge has a source matching `from` and a target matching `forbidden`.

**Message format:** `Forbidden import: "<source>" imports "<target>" which matches forbidden pattern`

**Action:** Remove the forbidden import. Find an alternative API or move the shared logic to an allowed location.

**When to ignore:** Only if the rule configuration is overly broad and needs refinement. The rule itself should be updated rather than the violation ignored.

### `arch/dependency-direction`

**Severity:** configurable (per rule definition)

**What it means:** An import edge matches a denied directional pair. This enforces that certain module groups should never depend on others — for example, `packages/core` should never import from `packages/cli`.

**Trigger:** Configuration defines `denied` pairs as `[fromPattern, toPattern]` tuples. An import edge has source matching `fromPattern` and target matching `toPattern`.

**Message format:** `Dependency direction violation: "<source>" -> "<target>" matches denied pair [<from>, <to>]`

**Action:** Invert the dependency or extract shared code. The denied direction typically indicates an architectural smell where a lower-level module reaches up to a higher-level one.

**When to ignore:** Type-only imports (used only for compile-time checking) may sometimes cross direction boundaries safely. Consider whether the rule should be scoped to runtime imports only.

### Configuring rules in `mma.config.json`

Rules are declared in the top-level `rules` array of your config file. Each rule requires `id`, `kind`, and `config`; `description` and `severity` are optional (severity defaults to `"warning"`).

```json
{
  "repos": [...],
  "mirrorDir": "mirrors",
  "rules": [
    {
      "id": "no-presentation-to-data",
      "description": "Presentation must not import from infrastructure",
      "kind": "forbidden-import",
      "severity": "error",
      "config": {
        "from": ["src/presentation/**"],
        "forbidden": ["src/infrastructure/**"]
      }
    },
    {
      "id": "layered-arch",
      "description": "Enforce 3-tier architecture",
      "kind": "layer-violation",
      "severity": "warning",
      "config": {
        "layers": [
          { "name": "presentation", "patterns": ["src/controllers/**", "src/routes/**"], "allowedDependencies": ["business"] },
          { "name": "business",     "patterns": ["src/services/**", "src/domain/**"],   "allowedDependencies": ["data"] },
          { "name": "data",         "patterns": ["src/repositories/**", "src/models/**"], "allowedDependencies": [] }
        ]
      }
    },
    {
      "id": "no-core-importing-cli",
      "description": "Core packages must not depend on CLI packages",
      "kind": "dependency-direction",
      "severity": "error",
      "config": {
        "denied": [["packages/core/**", "apps/cli/**"]]
      }
    }
  ]
}
```

Rules are validated on startup with `validateArchRules()`. Invalid rules emit a warning and are skipped; valid rules are forwarded to `evaluateArchRules()` for each indexed repository. Violations are stored at KV key `sarif:arch:<repoName>` and aggregated into `sarif:latest`.

---

## Temporal Coupling

Source: `packages/heuristics/src/temporal-coupling.ts`

### `temporal-coupling/co-change`

**Severity:** warning if confidence >= 80%, note otherwise

**What it means:** Two files change together in git history more often than expected. This suggests a hidden dependency — changing one file almost always requires changing the other, but there is no import or type-level link between them.

**Trigger:** The file pair must meet **all** of these thresholds (configurable):
- **Minimum co-changes:** 3 commits (default `minCoChanges: 3`)
- **Minimum confidence:** 50% (default `minConfidence: 0.5`)
- **Maximum files per commit:** 50 (commits with more files are skipped as likely merges; default `maxFilesPerCommit: 50`)

Confidence = `max(supportA, supportB)` where support is the proportion of one file's commits that also include the other file. Results are capped at 20 pairs (default `maxResults: 20`), sorted by co-change count then confidence.

**Message format:** `Temporal coupling: "<fileA>" and "<fileB>" changed together in <count> commits (confidence: <pct>%). Consider if these files should be co-located or if there is a missing abstraction.`

**Action:** Investigate the relationship:
1. **Co-locate:** If the files logically belong together, move them closer in the directory structure.
2. **Extract shared logic:** If both files change because they share an implicit contract, make it explicit with a shared type or interface.
3. **Merge:** If the files are always changed together and are small, consider merging them.

**When to ignore:**
- Test file + implementation file pairs are expected to co-change.
- Configuration files that are updated alongside the code they configure.
- Files that changed together during a large refactor but don't have an ongoing relationship.

---

## Hotspot Analysis

Source: `packages/heuristics/src/hotspots.ts`, `packages/diagnostics/src/sarif-hotspot.ts`

Hotspot analysis identifies files that are both frequently modified and structurally complex — prime candidates for bugs, merge conflicts, and difficult maintenance.

### `hotspot/high-churn-complexity`

**Severity:** warning if score >= 50, note if score >= 25

**What it means:** A file has a high combination of git churn (commit frequency) and code complexity (symbol count). Files that change often and contain many symbols are statistically more likely to harbour bugs and create maintenance bottlenecks.

**Trigger:** The hotspot score must meet the threshold:
- **Churn** = number of distinct commits that touched the file (from `git log`)
- **Complexity proxy** = number of parsed symbols in the file
- **churnScore** = `(churn / maxChurn) × 100` (normalized independently, 0–100)
- **complexityScore** = `(symbolCount / maxSymbolCount) × 100` (normalized independently, 0–100)
- **Hotspot score** = `round((churnScore + complexityScore) / 2)` (average of the two dimensions, 0–100)
- Files with zero symbols are excluded (config files, docs, etc.). Test and spec files are also unconditionally excluded.
- Default warning threshold: **50**; note threshold: **25** (half of warning)

**Message format:** `File has high churn (<churn> commits) and complexity (<symbolCount> symbols) — hotspot score <score>/100`

**Properties:** `churn`, `symbolCount`, `hotspotScore`

**Action:**
1. **Refactor:** Break large files into smaller, focused modules to reduce both complexity and merge conflict risk.
2. **Increase test coverage:** High-churn files benefit most from comprehensive tests since they change frequently.
3. **Establish code ownership:** Assign clear ownership to prevent drive-by edits that increase churn without improving quality.
4. **Review commit patterns:** Determine whether high churn reflects active development (acceptable) or repeated bug fixes (problematic).

**When to ignore:**
- Entry point files or barrel exports (`index.ts`) that grow naturally as the project adds modules.
- Files undergoing a planned refactor — churn will be temporarily elevated.
- Generated files that are committed to the repo (consider adding them to `.gitignore` instead).

**Practices report:** Category weight 15, effort "high", debt estimate 240 minutes (4 hours) per finding.

---

## Vulnerability

Source: `packages/heuristics/src/vuln-match.ts`

### `vuln/reachable-dependency`

**Severity:** error if severity is `critical` or `high`; warning otherwise

**What it means:** A dependency with a known vulnerability is actually imported by application code. This goes beyond simply having a vulnerable package in `node_modules` — the analyzer checks whether any file has an import edge to `node_modules/<package>/`, confirming the vulnerable code is reachable at runtime.

**Trigger:** The installed package version satisfies the advisory's vulnerable range (via `semver.satisfies`), **and** at least one file in the codebase has an import edge targeting a path containing `node_modules/<package>/`.

**Message format:** `Reachable vulnerability: <name>@<version> matches <advisoryId> (<severity>). Imported by <count> file(s): <files>`

**Action:** Update the vulnerable package to a patched version. If no patch exists, evaluate whether the vulnerable code path is actually exercised by your usage, and consider alternative packages.

**When to ignore:**
- If the advisory affects a code path your application never calls (requires manual verification beyond what the import-level reachability check provides).
- If the "vulnerable" version is disputed or the advisory has been withdrawn.

---

## Blast Radius

Source: `packages/query/src/pagerank.ts`

### `blast-radius/high-pagerank`

**Severity:** note

**What it means:** The file has a high PageRank score in the dependency graph, meaning many other files transitively depend on it. Changes to this file have a wide blast radius — a bug here affects a large portion of the codebase.

**Trigger:** The file ranks in the **top 10** (default `topN: 10`) by PageRank score and exceeds the minimum score threshold (default minScore: 10% of the top score, adapting to graph size).

PageRank parameters: damping factor = 0.85, max iterations = 100, convergence tolerance = 1e-6. Dangling nodes (files with no outgoing imports) distribute rank evenly to all nodes.

**Message format:** `High blast radius: "<path>" has PageRank score <score> (rank #<rank>). Changes to this file affect many dependents.`

**Action:** Treat changes to high-PageRank files with extra care:
1. Require thorough code review for any modifications.
2. Ensure comprehensive test coverage.
3. Consider whether the module should be split to reduce coupling.
4. Use this information to prioritize which modules get integration tests.

**When to ignore:** Core type definition files and shared utility modules will naturally rank high. The finding is informational — it doesn't indicate a problem, just highlights where extra caution pays off.

---

## Cross-Repo

Source: `packages/correlation/src/sarif-rules.ts`

Cross-repo rules detect risks that emerge from dependencies between repositories. These findings require multi-repo indexing (2+ repos in `mma.config.json`).

### `cross-repo/breaking-change-risk`

**Severity:** warning

**What it means:** A module's public API is consumed by other repos, and changes to it could break downstream consumers. The finding identifies the specific exports that are cross-repo dependencies.

**Action:** Treat these exports as public API contracts. Add stability guarantees, versioning, or deprecation notices before making breaking changes.

**When to ignore:** If the consuming repos are owned by the same team and can be updated simultaneously.

### `cross-repo/orphaned-service`

**Severity:** note

**What it means:** A service was detected in the catalog but no other repo in the analysis set consumes it. The service may be unused, or its consumers are outside the analyzed repos.

**Action:** Verify whether the service has external consumers. If genuinely orphaned, consider deprecation.

**When to ignore:** If the service is consumed by repos not included in the analysis configuration.

### `cross-repo/shared-flag`

**Severity:** note

**What it means:** A feature flag (enum member or env var) is defined or referenced in multiple repos. Changes to the flag's behavior may have cross-repo impact.

**Action:** Ensure flag changes are coordinated across all repos that reference it. Consider centralizing flag definitions.

**When to ignore:** If the shared flag is a well-known platform toggle with established change management.

### `cross-repo/cascading-fault`

**Severity:** warning

**What it means:** A fault detected in one repo (e.g., missing error boundary) is on a code path consumed by another repo. The fault could cascade across service boundaries.

**Action:** Add error handling at the cross-repo boundary. The consuming repo should not assume the upstream service handles all errors.

**When to ignore:** If circuit breakers or retry logic exist at the integration point but are not detected by static analysis.

### `cross-repo/undocumented-consumer`

**Severity:** note

**What it means:** A repo imports from another repo's package, but the consumed API has no tier-1 or tier-2 summary. The dependency exists without documentation of what the consumed module does.

**Action:** Run `mma index --enrich` to generate summaries, or add manual documentation to the consumed module.

**When to ignore:** If the consumed module is a well-known utility with self-documenting API (e.g., type definitions).

### `cross-repo/critical-path`

**Severity:** warning

**What it means:** A repo sits at the head of a dependency chain that is 4 or more hops long. Any failure in this repo — a breaking API change, an outage, or a build regression — cascades to every repo downstream in the chain.

**Action:** Treat this repo's public API as high-risk to change. Prioritize reliability work (error handling, retries, SLOs) in this repo. Consider adding integration tests that exercise the downstream chain.

**When to ignore:** If the downstream chain consists of low-criticality repos or the chain length is inflated by test/dev-only dependencies.

---

## Non-SARIF Model Outputs

The analyzer produces several outputs beyond SARIF diagnostics. These are stored in the KV store and accessible via the query engine.

### Fault Trees

Stored as structured `FaultTree` objects. Each tree has:
- **Top event:** The error/warning log statement that was traced backward.
- **Gates:** OR/AND nodes representing branching conditions.
- **Basic events:** Leaf conditions (root causes).
- **Code flows:** SARIF `codeFlow` objects showing the trace path with nesting levels.

Access: `kvStore.get("faultTrees:<repo>")`

### Service Catalog

Generated by the functional model from service boundary detection + summarization. This is a cross-repo catalog — all repos' services are aggregated into a single entry. Each entry describes an inferred service with its endpoints, dependencies, and documentation.

Access: `kvStore.get("cross-repo:catalog")`

### Patterns

Detected by `packages/heuristics/src/patterns.ts`. Includes design pattern recognition (singletons, factories, observers, etc.) classified from naming conventions and structural analysis.

Access: Stored as part of heuristic analysis results.

### Graph Edges

The full import/dependency graph is stored as `GraphEdge[]` arrays. Edge kinds include `imports`, `calls`, `implements`, and others. Used by the query engine for structural queries like "what depends on X" and "what does Y call."

Access: Graph edges are stored in the graph store, not the KV store. Use `graphStore.getEdgesByKind(kind, repo)` to retrieve edges filtered by kind and repository.

### Search Index

Full-text search (SQLite FTS5 with BM25 ranking) over file content, symbol names, and summaries. Powers natural language queries routed through the query engine.

Access: Via the search store adapter and `mma query` command.
