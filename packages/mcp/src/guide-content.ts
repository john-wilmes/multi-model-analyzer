export const GUIDE_CONTENT = `# Multi-Model Analyzer (MMA) — Agent Guide

Read this guide once when connecting to the MMA MCP server. It covers everything you need to use MMA effectively: tools, workflows, concepts, and resources.

---

## 1. Overview

MMA is a **static analysis toolchain** for large TypeScript/JavaScript codebases. It extracts symbols, dependency graphs, call graphs, and architectural patterns from source repos without cloud LLM calls.

**What data is available after indexing:**
- Symbol graph: every exported function, class, and interface with call and import edges
- Dependency and call graphs within each repo and across repos
- Module metrics: instability (I), abstractness (A), distance from main sequence
- SARIF findings: structural, fault, config, blast-radius, temporal, hotspot, and vulnerability rules
- Feature flags and config parameters with inferred constraint models
- Design patterns detected per repo
- Git-derived hotspots and temporal coupling

**Prerequisites:** Repos must be indexed first via \`mma index\` (CLI) or \`index_repo\` (MCP tool). Use \`mma://repos\` to see what is already indexed.

---

## 2. Quick Start Workflows

### "What breaks if I change this file?"
1. \`search\` — find the exact file or symbol path
2. \`get_blast_radius\` — list files transitively affected via imports and calls
3. \`get_diagnostics\` — check existing issues in that file
4. (optional) add \`crossRepo: true\` to \`get_blast_radius\` for downstream repo impact

### "Is this configuration valid?"
1. \`get_config_inventory\` — enumerate detected settings, credentials, and flags
2. \`get_config_model\` — see constraint relationships (requires, mutex, enum, conditional)
3. \`validate_config\` — check a specific config object against the model
4. \`get_test_configurations\` — generate a minimal pairwise test plan

### "How do these repos connect?"
1. \`get_architecture\` — service roles, cross-repo edges, and communication topology
2. \`get_cross_repo_graph\` — full edge list with upstream/downstream maps
3. \`get_service_correlation\` — linchpin services, shared packages, orphaned endpoints

### "Find risky code to review"
1. \`get_diagnostics\` with \`level: "error"\` — highest severity findings first
2. \`get_hotspots\` — high churn × high complexity files
3. \`get_blast_radius\` — understand the scope of changes to those files
4. \`get_metrics\` — instability and zone analysis

### "Understand feature flag impact"
1. \`get_flag_inventory\` — list all flags (optionally filter unregistered ones)
2. \`get_flag_impact\` — trace a flag through the import/call graph
3. \`get_config_model\` — see which other flags or settings this one constrains

### "Where does this symbol come from / go to?"
1. \`search\` — find the symbol's FQN (e.g. \`src/auth.ts#AuthService.signIn\`)
2. \`get_callers\` — who calls it
3. \`get_callees\` — what it calls
4. \`get_dependencies\` — full dependency subgraph up to maxDepth hops
5. \`get_symbol_importers\` — which repos import it from an npm package

---

## 3. Tool Reference

### Code Navigation

**\`search\`** — BM25 full-text search across all indexed symbols and files.
- Inputs: \`query\` (required), \`repo\`, \`limit\` (default 10), \`offset\`
- Returns ranked hits with file paths and metadata
- Use this first to find exact FQNs before calling \`get_callers\`/\`get_callees\`

**\`get_callers\`** — Find all callers of a symbol.
- Inputs: \`symbol\` (FQN preferred, e.g. \`src/auth.ts#AuthService.signIn\`), \`repo\`
- Short names fall back to BM25 (less precise)

**\`get_callees\`** — Find all symbols called by a given symbol.
- Inputs: same as \`get_callers\`

**\`get_dependencies\`** — Traverse the dependency graph from a symbol or module.
- Inputs: \`symbol\` (name, FQN, or file path), \`repo\`, \`maxDepth\` (default 3)
- Returns graph edges within maxDepth hops

**\`get_symbol_importers\`** — Find which repos import a specific symbol from a package.
- Inputs: \`symbol\` (exact name, e.g. \`createClient\`), \`package\` (e.g. \`@supabase/supabase-js\`), \`repo\`
- Requires cross-repo correlation data (2+ repos indexed)

**\`query\`** — Natural language routing to any analysis backend.
- Inputs: \`query\` (question), \`repo\`
- Routes to: callers, callees, dependencies, circular deps, search, diagnostics, architecture, patterns, docs, fault trees
- Best used when you are not sure which tool to call

### Architecture

**\`get_architecture\`** — Cross-repo architecture overview.
- Inputs: \`repo\` (optional — scopes output)
- Returns: repo roles, cross-repo dependency edges (top 50 by import count), service communication topology (HTTP, queues, WebSocket)
- Truncation note: large edge sets are trimmed; use \`get_cross_repo_graph\` for the full list

**\`get_cross_repo_graph\`** — Full cross-repo dependency graph.
- Inputs: \`repo\` (filter to edges involving this repo), \`includePaths\` (compute all dependency paths between repos, limited to 20-repo scope)
- Returns: edges, repoPairs, downstreamMap, upstreamMap

**\`get_service_correlation\`** — Service correlation analysis.
- Inputs: \`endpoint\` (substring filter), \`kind\` (linchpins | packages | orphaned | all), \`limit\`, \`offset\`
- Linchpins = HTTP endpoints called by many repos; packageLinchpins = npm packages with high cross-repo coupling; orphaned = services with no consumers

**\`get_cross_repo_models\`** — Cross-repo model results: shared feature flags, cascading faults, and service catalog.
- Inputs: \`kind\` (features | faults | catalog | all), \`repo\`, \`offset\`, \`limit\`
- Requires 2+ repos indexed

**\`get_cross_repo_impact\`** — Compute cross-repo blast radius for a list of changed files.
- Inputs: \`files\` (array of file paths), \`repo\`
- Returns: affected files within the repo plus files in downstream repos

### Quality & Diagnostics

**\`get_diagnostics\`** — Retrieve SARIF findings.
- Inputs: \`query\` (keyword filter on ruleId and message), \`repo\`, \`level\` (error | warning | note), \`limit\` (default 50), \`offset\`
- Returns paginated SARIF results with ruleId, level, message, and location

**\`get_metrics\`** — Module instability metrics.
- Inputs: \`repo\`, \`module\` (file path filter), \`limit\`, \`offset\`
- Returns instability (I), abstractness (A), distance from main sequence, and zone classification per module

**\`get_blast_radius\`** — Impact scope of file changes.
- Inputs: \`files\` (array), \`repo\`, \`maxDepth\` (default 5), \`includeCallGraph\` (default true), \`crossRepo\` (default false)
- Affected files are scored by PageRank (transitive importance) and sorted by score descending

**\`get_vulnerability\`** — Vulnerability reachability findings.
- Inputs: \`repo\`, \`severity\` (low | moderate | high | critical), \`limit\` (default 20), \`offset\`
- Shows vulnerable npm packages that are actually imported in code (not just installed)
- Requires \`npm audit --json\` output to be present during indexing

**\`get_hotspots\`** — Files ranked by churn × complexity (highest risk to change).
- Inputs: \`repo\`, \`limit\` (default 20), \`offset\`
- Score = (churn / maxChurn + symbolCount / maxSymbols) / 2, normalized globally across all repos

**\`get_temporal_coupling\`** — Files that change together in commits without a declared import dependency.
- Inputs: \`repo\`, \`minCoChanges\` (default 2), \`limit\` (default 30), \`offset\`
- Reveals hidden logical coupling and architectural drift
- Requires git history; not available for single-commit bare clones

**\`get_patterns\`** — Detected design patterns per repo.
- Inputs: \`repo\`, \`pattern\` (substring filter, e.g. \`adapter\`, \`factory\`)
- Detected types: adapter, facade, observer, factory, singleton, repository, middleware, decorator

### Feature Flags & Config

**\`get_flag_inventory\`** — List and search detected feature flags.
- Inputs: \`repo\`, \`search\` (substring), \`limit\` (default 50), \`offset\`, \`registry_only\`, \`unregistered\`
- \`unregistered: true\` finds flags in code but not in the canonical registry

**\`get_flag_impact\`** — Trace a feature flag through the codebase via reverse BFS.
- Inputs: \`flag\` (exact name tried first, then substring), \`repo\`, \`maxDepth\` (default 5), \`includeCallGraph\` (default true), \`crossRepo\` (default false)
- Returns flagLocations (where the flag is checked) + affectedFiles (transitively impacted)

**\`get_config_inventory\`** — List configuration parameters (settings, credentials, flags).
- Inputs: \`repo\`, \`search\`, \`kind\` (setting | credential | flag), \`limit\` (default 50), \`offset\`

**\`get_config_model\`** — Constraint graph for a repo's config space.
- Inputs: \`repo\` (required)
- Returns: flags, parameters, constraint count, and all constraints by kind (requires, mutex, enum, conditional)
- Built automatically when both flag inventory and config inventory are present

**\`validate_config\`** — Check a partial config object against the model.
- Inputs: \`repo\` (required), \`config\` (key-value map of parameter names to values)
- Returns: \`valid\` boolean, list of issues (missing dependencies, conflicts, invalid values)

**\`get_test_configurations\`** — Generate a minimal covering array for the config space.
- Inputs: \`repo\`, \`strength\` (default 2), \`constraintAware\` (default true)
- Strength 2 = pairwise (every pair of parameters covered); higher values give stronger guarantees but more test cases
- \`constraintAware: true\` automatically excludes constraint-violating combinations

**\`get_interaction_strength\`** — How many parameters interact with a given parameter.
- Inputs: \`repo\`, \`parameter\` (parameter name)
- Useful for deciding which parameters to test exhaustively vs. pairwise

### Repo Management

**\`scan_org\`** — Discover repos in a GitHub org and register them as indexing candidates.
- Inputs: \`org\`, \`excludeForks\` (default true), \`excludeArchived\` (default true), \`languages\` (array filter)

**\`get_repo_candidates\`** — List repos by indexing status.
- Inputs: \`status\` (candidate | indexed | ignored | indexing, default: candidate)

**\`index_repo\`** — Clone and fully index a single repo.
- Inputs: \`name\`, \`url\` (required if repo is new), \`branch\` (default: main)
- Runs the full analysis pipeline and updates cross-repo correlations

**\`ignore_repo\`** — Mark a repo so it is not suggested for indexing.
- Inputs: \`name\`

**\`get_indexing_state\`** — Full snapshot of all repos and their states.
- No inputs; returns summary + per-repo status, discovery source, connection counts

**\`check_new_repos\`** — Re-scan an org and diff against known state.
- Inputs: \`org\`
- Efficient way to find newly added repos without re-indexing everything

---

## 4. Resources

MMA exposes the following MCP resources. Prefer these for bulk reads — they avoid pagination overhead.

| URI | Contents |
|-----|----------|
| \`mma://repos\` | JSON list of all indexed repos (names only) |
| \`mma://repo/{name}/findings\` | Full SARIF results for one repo |
| \`mma://repo/{name}/metrics\` | Module metrics (I, A, distance) for one repo |
| \`mma://repo/{name}/patterns\` | Detected design patterns for one repo |
| \`mma://guide\` | This guide |

Use \`get_diagnostics\` when you need filtering or pagination. Use \`mma://repo/{name}/findings\` when you need all findings for a repo at once.

---

## 5. Key Concepts

### SARIF
The Standard Analysis Results Interchange Format (v2.1.0). Every MMA finding is a SARIF result containing:
- \`ruleId\` — identifier like \`structural/unstable-dependency\` or \`config/dead-flag\`
- \`level\` — \`error\`, \`warning\`, or \`note\`
- \`message.text\` — human-readable description with file paths and values
- \`locations[].logicalLocations\` — the module or symbol (no raw source code)
- \`baselineState\` — \`new\`, \`unchanged\`, \`updated\`, or \`absent\` vs. previous run
- \`properties\` — rule-specific metadata (scores, thresholds, counts)

### SARIF Rule Categories

| Category | Rule prefix | What it covers |
|----------|-------------|----------------|
| Structural | \`structural/\` | Dead exports, unstable dependencies, pain/useless zone modules |
| Fault tree | \`fault/\` | Unhandled errors, silent failures, missing error boundaries, cascading failure risk |
| Configuration | \`config/\` | Dead flags, always-on flags, missing constraints, format violations, untested interactions |
| Blast radius | \`blast-radius/\` | High-PageRank files with outsized transitive impact |
| Temporal | \`temporal-coupling/\` | Files that change together without a declared dependency |
| Hotspot | \`hotspot/\` | High churn × high complexity |
| Vulnerability | \`vuln/\` | Reachable vulnerable dependencies (from \`npm audit\`) |
| Cross-repo | \`cross-repo/\` | Breaking change risk, orphaned services, shared flags, cascading faults |
| Architecture | \`arch/\` | Layer violations, forbidden imports, denied directional pairs |

### Module Metrics
Computed per-module from coupling analysis:
- **Instability (I)** = efferent couplings / (afferent + efferent) — ranges 0 (maximally stable) to 1 (maximally unstable)
- **Abstractness (A)** = abstract types / total types — ranges 0 (concrete) to 1 (abstract)
- **Distance from main sequence (D)** = |A + I − 1| — ideal modules sit near the diagonal; D > 0.5 is a zone violation
- **Pain zone**: A ≈ 0, I ≈ 0 — concrete and stable, hard to change (\`structural/pain-zone-module\`)
- **Useless zone**: A ≈ 1, I ≈ 1 — over-abstracted with few dependents (\`structural/uselessness-zone-module\`)

### Feature Model
The config model for a repo combines:
- **Flags**: boolean feature toggles detected in code
- **Parameters**: settings and credentials with types and value constraints
- **Constraints**: inferred or explicit relationships —
  - \`requires\`: flag A can only be enabled if flag B is also enabled
  - \`mutex\`: flags A and B cannot both be enabled
  - \`enum\`: a parameter must take one of a fixed set of values
  - \`conditional\`: constraint applies only when another condition is true

Constraints with \`source: "inferred"\` were derived statically from code co-occurrence patterns. Constraints with \`source: "explicit"\` came from config schema files or registry definitions.

### Covering Arrays
A covering array is a minimal set of test configurations that exercises every t-way combination of parameter values at least once:
- **Strength 2 (pairwise)**: every pair of parameters takes every value combination. Typical size: O(v² log n) where v = max values, n = parameters. Catches ~75% of config-related bugs.
- **Strength 3**: every triple covered. Roughly 3–6× more test cases than pairwise. Appropriate for parameters with known three-way interactions.
- Higher strengths are rarely needed unless the model has complex ternary constraints.

Use \`get_interaction_strength\` to identify which parameters have many constraint partners — those are candidates for higher-strength coverage.

---

## 6. Combining MMA with Runtime Data Sources

MMA tells you **what the code says** — what flags exist, what credentials are expected, what the call graph looks like. To understand what is **actually configured or happening** in a live system, pair MMA with runtime data sources available through other MCP servers.

| Question | MMA provides | Runtime source fills the gap |
|----------|-------------|------------------------------|
| Is this flag still used? | \`get_flag_inventory\` — where it appears in code | Runtime config — which accounts have it enabled |
| What broke in production? | \`get_callers\`/\`get_blast_radius\` — code path and impact scope | Application logs — actual errors, timestamps, stack traces |
| Who owns the affected code? | \`get_architecture\` — repo roles and service topology | Issue tracker — team assignments and task tracking |

### Cross-tool workflow: Dead flag cleanup
1. \`get_flag_inventory\` with \`unregistered: true\` — find flags in code that are not in the canonical registry
2. Query user database — count how many accounts still have each flag enabled
3. \`get_flag_impact\` — compute blast radius if the flag is removed from code
4. Decision: if zero accounts have the flag and code impact is isolated, it is safe to remove

### Cross-tool workflow: Change risk assessment
1. \`get_blast_radius\` with \`crossRepo: true\` — find all files and repos affected by proposed changes
2. \`get_diagnostics\` — check for existing findings in affected files
3. \`get_hotspots\` — identify if affected files are high-churn hotspots
4. Query issue tracker — find which teams own the affected repos and notify them

---

## 7. Maintenance Note

This guide is updated with each new MMA feature. If a tool is not documented here, check its description directly via the MCP tool list. When in doubt, \`query\` routes natural language questions to the right backend automatically.
`;
