# Feature Roadmap

Candidate features informed by analysis of comparable open-source projects: [Roam Code](https://github.com/Cranot/roam-code), [Code Pathfinder](https://github.com/shivasurya/code-pathfinder), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser), [Sourcegraph/SCIP](https://github.com/sourcegraph/scip), [CodeMCP](https://github.com/SimplyLiz/CodeMCP).

## Landscape Summary

No existing tool combines all of what mma does: tree-sitter + ts-morph dual parsing, cross-repo service topology (queue/HTTP/WebSocket), fault tree generation, pattern detection, 3-tier summarization, SARIF output, and natural language query routing -- all without cloud LLM calls at analysis time. Related tools tend to focus on one slice (dependency-cruiser for dep graphs, Jelly for call graphs) or are broader platforms that don't expose raw analytical models (Sourcegraph, CodeScene). The emerging MCP-server tools (Roam Code, Code Pathfinder, CodeMCP) are the most similar in spirit but are younger and primarily designed as AI-agent context providers rather than standalone analysis pipelines.

## Completed

### MCP Server ✓

Implemented in `packages/mcp`. Exposes mma's query layer as MCP tools over stdio or HTTP transport for AI agent integration (Claude Code, Codex, Cursor, etc.). Run via `mma serve`. Use `--transport http` to switch to HTTP mode (default port 3001).

### MCP Tools Modularization ✓

Split the monolithic `tools.ts` into focused modules (PR #73). Each tool category lives in its own file under `packages/mcp/src/tools/`, reducing merge conflicts and making it easier to add new tools.

### MCP Agent Scenario Tests ✓

Six scripted multi-step integration tests in `packages/mcp/src/agent-scenarios.test.ts` that simulate real agent workflows. Each scenario seeds interconnected stores, then chains 2-4 tool calls where each step's output informs the next — validating that an agent can answer questions like "what breaks if I change this file?" or "trace this vulnerability's reach" using the MCP tools.

### Worker Thread Blast Radius ✓

Implemented in PR #74. `computeReachCounts` (SCC + bitset) runs in a worker thread with a 30-second timeout and graceful fallback. Prevents large-repo blast radius computation from blocking the main thread.

### Lazy SARIF Pagination ✓

Implemented in PR #75. `getSarifResultsPaginated` iterates repos lazily, stopping as soon as the requested page is filled. Performance is O(max_per_repo + limit) instead of O(total_findings), enabling fast pagination over large result sets.

### Barrel Cycle Suppression ✓

Implemented in PR #76. A new `suppressBarrelCycles` option filters circular dependency findings where the cycle is mediated by barrel (`index.ts`) re-exports rather than a genuine mutual dependency. Reduces false positives by ~17% in measured corpora.

### Interactive Indexing ✓

Implemented as `mma explore`. Guided repo discovery with incremental indexing — add and index repos one at a time without a full config file. Supports `--enrich` and all LLM provider flags (`--llm-provider`, `--llm-api-key`, `--llm-model`, `--ollama-url`, `--ollama-model`). Useful for exploratory analysis.

### GitHub Org Indexing ✓

Implemented as `mma index-org <org>`. Scans a GitHub org via the API, clones all matching repos, indexes in batches, and runs cross-repo correlation. Resumable: already-indexed repos are skipped; repos stuck in `"indexing"` state are reset on restart. Supports `--concurrency`, `--batch-size`, `--language`, `--force-full-reindex`, and all LLM enrichment flags.

### LLM Provider Config File Support ✓

`llmProvider`, `llmApiKey`, and `llmModel` can now be set in `mma.config.json`. Precedence: CLI flags > config file > defaults. API keys should still be passed via environment variables rather than committed to the config file.

### Progress Tracking with ETA ✓

A `ProgressTracker` utility displays estimated time remaining during the clone phase, batch indexing, tier-1 summarization, and tier-3 LLM summarization phases.

### Instability Metrics ✓

Implemented in `packages/structural/src/metrics.ts`. Computes afferent/efferent coupling and instability per module. Detects Stable Dependencies Principle violations, reported as SARIF findings.

### Dead Export Detection ✓

Implemented in `packages/structural/src/dead-exports.ts`. Identifies exports with no incoming import references. Produces SARIF findings for code cleanup.

### Architectural Rules Engine ✓

Implemented in `packages/heuristics/src/arch-rules.ts`. Supports forbidden-import, layer-violation, and dependency-direction rules configured in `mma.config.json`.

### Blast Radius / Impact Analysis ✓

Implemented via PageRank scoring in `packages/query/src/pagerank.ts` and `mma affected` command for rev-range scoping.

### Git-Affected Scoping ✓

Implemented as `mma affected <rev-range>` and `mma delta <rev-range>` commands.

### Temporal Coupling ✓

Implemented in `packages/heuristics/src/temporal-coupling.ts`. Detects co-change patterns from git history with NPMI scoring.

### Vulnerability Reachability ✓

Implemented in `packages/heuristics/src/vuln-match.ts`. Matches npm audit advisories against import graph reachability.

### Configuration Validation & Feature Interaction Analysis ✓

Implemented across four phases: settings scanner (`packages/heuristics/src/settings.ts`), unified constraint extraction, SAT-based validation (`packages/models/config/src/z3.ts`), and combinatorial interaction testing (`packages/models/config/src/covering-array.ts`). See [config-validation-plan.md](config-validation-plan.md) for the detailed design.

## Lower Priority

### Data Flow / Taint Tracking

Source-to-sink analysis for security vulnerabilities (SQL injection, RCE, etc.). Substantial implementation effort and orthogonal to the current architectural analysis focus.

**Reference:** Code Pathfinder's DFG-based taint tracking with Python SDK rules.

## Existing Strengths

Areas where mma already has strong capabilities:
- **Dual-engine parsing** -- tree-sitter + ts-morph (type-resolved extraction).
- **Cross-repo analysis** -- packageRoots resolution, repo-scoped edges and queries.
- **Service topology** -- queue producers/consumers, HTTP clients, WebSocket detection.
- **Fault tree generation** -- static fault trees derived from call graphs.
- **SARIF output** -- standardized format with logical locations.
- **Pattern detection** -- adapter, facade, observer, factory, singleton, repository, middleware, decorator.
- **3-tier summarization** -- from free AST templates to optional local Ollama LLM descriptions.
