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
| `blast-radius/high-pagerank` | note | Blast Radius | File has high transitive importance |

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

---

## Fault Tree

Source: `packages/models/fault/src/fault-tree.ts`

These rules analyze control flow graphs to find gaps in error handling. The fault tree model traces backward from error/warning log statements to identify root causes and missing safety nets.

### `fault/unhandled-error-path`

**Severity:** warning

**What it means:** A `catch` block in the control flow graph has no logging statement and no re-throw. The error is silently swallowed — if something goes wrong at runtime, there will be no trace in logs and no propagation to callers.

**Trigger:** A CFG node of kind `catch` has no successor nodes matching the logging pattern (`/\b(log(ger)?|error|warn(ing)?|console)\s*[.(]/i`) and no successor of kind `throw`.

**Action:** Add logging inside the catch block (at minimum) or re-throw the error if the caller should handle it. Even a `console.error` is better than silence.

**When to ignore:** Catch blocks that intentionally suppress expected errors (e.g., "file not found" when checking optional config) are valid. Add a comment explaining why the error is suppressed.

### `fault/silent-failure`

**Severity:** warning

**What it means:** An error condition is detected (e.g., a null check, an error code comparison) but the failure path produces no observable side effect — no log, no throw, no return value change.

**Trigger:** Defined in `FAULT_RULES`. Detection is part of gap analysis expansion.

**Action:** Ensure the failure path either logs the condition, propagates an error, or returns a distinguishable result.

**When to ignore:** Defensive checks that guard against theoretically impossible states may intentionally do nothing on the "impossible" path.

### `fault/missing-error-boundary`

**Severity:** warning

**What it means:** An async operation (Promise, async/await) has no `.catch()` handler, no try/catch wrapper, and no error boundary component (in React contexts).

**Trigger:** Defined in `FAULT_RULES`. Detection is part of gap analysis expansion.

**Action:** Add error handling around the async operation. Unhandled promise rejections crash Node.js processes and create silent failures in browsers.

**When to ignore:** If a global unhandled rejection handler exists and is intentionally the catch-all strategy, individual handlers may be redundant. This is a valid architecture choice but should be documented.

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

**Message format:** `Exported <kind> "<name>" in <path> is not imported by any other file`

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

---

## Temporal Coupling

Source: `packages/heuristics/src/temporal-coupling.ts`

> **Note:** The temporal coupling SARIF converter is defined but not yet wired into the CLI aggregation pipeline. These results are available programmatically but do not appear in `sarif:latest` by default.

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

## Vulnerability

Source: `packages/heuristics/src/vuln-match.ts`

> **Note:** The vulnerability SARIF converter is defined but not yet wired into the CLI aggregation pipeline. These results are available programmatically but do not appear in `sarif:latest` by default.

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

**Trigger:** The file ranks in the **top 10** (default `topN: 10`) by PageRank score and exceeds the minimum score threshold (default `minScore: 0`).

PageRank parameters: damping factor = 0.85, max iterations = 100, convergence tolerance = 1e-6. Dangling nodes (files with no outgoing imports) distribute rank evenly to all nodes.

**Message format:** `High blast radius: "<path>" has PageRank score <score> (rank #<rank>). Changes to this file affect many dependents.`

**Action:** Treat changes to high-PageRank files with extra care:
1. Require thorough code review for any modifications.
2. Ensure comprehensive test coverage.
3. Consider whether the module should be split to reduce coupling.
4. Use this information to prioritize which modules get integration tests.

**When to ignore:** Core type definition files and shared utility modules will naturally rank high. The finding is informational — it doesn't indicate a problem, just highlights where extra caution pays off.

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

Generated by the functional model from service boundary detection + summarization. Each entry describes an inferred service with its endpoints, dependencies, and documentation.

Access: `kvStore.get("docs:functional:<repo>")`

### Patterns

Detected by `packages/heuristics/src/patterns.ts`. Includes design pattern recognition (singletons, factories, observers, etc.) classified from naming conventions and structural analysis.

Access: Stored as part of heuristic analysis results.

### Graph Edges

The full import/dependency graph is stored as `GraphEdge[]` arrays. Edge kinds include `imports`, `calls`, `implements`, and others. Used by the query engine for structural queries like "what depends on X" and "what does Y call."

Access: `kvStore.get("edges:<repo>")`

### Search Index

Full-text search (SQLite FTS5 with BM25 ranking) over file content, symbol names, and summaries. Powers natural language queries routed through the query engine.

Access: Via the search store adapter and `mma query` command.
