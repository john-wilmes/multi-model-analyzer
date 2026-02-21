# Feature Roadmap

Candidate features informed by analysis of comparable open source projects: [Roam Code](https://github.com/Cranot/roam-code), [Code Pathfinder](https://github.com/shivasurya/code-pathfinder), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser), [Sourcegraph/SCIP](https://github.com/sourcegraph/scip), [CodeMCP](https://github.com/SimplyLiz/CodeMCP).

## Landscape Summary

No existing tool combines all of what mma does: tree-sitter + ts-morph dual parsing, cross-repo service topology (queue/HTTP/WebSocket), fault tree generation, pattern detection, 4-tier summarization, SARIF output, and natural language query routing -- all without LLM calls at analysis time. The closest competitors either focus on one slice (dependency-cruiser for dep graphs, Jelly for call graphs) or are broader platforms that don't expose raw analytical models (Sourcegraph, CodeScene). The emerging MCP-server tools (Roam Code, Code Pathfinder, CodeMCP) are the most similar in spirit but are younger and primarily designed as AI-agent context providers rather than standalone analysis pipelines.

## High Priority

### MCP Server

Expose mma's query layer as MCP tools so AI agents (Claude Code, Codex, Cursor, etc.) can query the index directly instead of shelling out to the CLI.

Minimum viable tool set:
- `search_symbol` -- full-text symbol search (existing search store)
- `get_callers` / `get_callees` -- call graph traversal (existing call graph edges)
- `get_dependencies` -- dependency graph traversal (existing dep graph)
- `query` -- natural language routing (existing NL router)
- `get_architecture` -- repo roles, cross-repo deps, service topology (existing architecture query)
- `get_sarif` -- diagnostics and findings (existing SARIF store)

Highest-leverage addition: multiplies the value of everything mma already does by making it agent-accessible.

**Reference implementations:** Roam Code (48 MCP tools wrapping CLI via subprocess), Code Pathfinder (13 tools with Go JSON-RPC 2.0 server, stdio + HTTP transport).

### Architectural Rules Engine

Declarative constraints checked during indexing, producing SARIF findings.

Three rule categories (proven pattern from dependency-cruiser):
- **Forbidden** -- dependencies that must not exist (e.g., "packages/core must not import packages/cli")
- **Allowed** -- whitelist approach; anything not matching is a violation
- **Required** -- dependencies that must exist (e.g., "all controllers must import base-controller")

Rules defined in YAML/JSON config with regex path matching and capture group variables for workspace boundary enforcement (e.g., `$1`/`$2` groups to prevent cross-feature imports).

**Known violations baseline:** Allow teams to adopt rules incrementally without fixing all pre-existing violations. SARIF already supports `baselineState` (new/unchanged/updated/absent) -- leverage this directly.

### Instability Metrics

Robert C. Martin's package instability metric, computed per package and per file:
- **Afferent coupling (Ca)** -- incoming dependency count
- **Efferent coupling (Ce)** -- outgoing dependency count
- **Instability (I)** = Ce / (Ca + Ce), range 0 (stable) to 1 (unstable)

Detect violations of the Stable Dependencies Principle: a module depending on something more unstable than itself. mma already has all the edge data needed; computation is straightforward.

## Medium Priority

### Blast Radius / Impact Analysis

Given a symbol or file, compute the transitive set of affected dependents ranked by importance. mma already has BFS traversal; adding a reach-count or PageRank-based metric would make queries like "what breaks if I change X" answerable.

**Reference:** Roam Code uses Personalized PageRank for blast radius scoring.

### Dead Export Detection

Exports with no incoming import references. Set difference between exported symbols and import edge targets. Produces actionable SARIF findings for code cleanup.

### Git-Affected Scoping

Given a git diff (or revision range), compute the changed files plus their transitive dependents. Useful for CI: validate only the blast radius of a PR's changes rather than the full codebase.

**Reference:** dependency-cruiser's `--affected <revision>` flag.

## Lower Priority

### Temporal Coupling

Co-change analysis from git history: files that frequently change together but have no import/call relationship (hidden coupling). Requires processing `git log` for file-level co-change matrices, then NPMI or lift-based correlation scoring.

**Reference:** Roam Code's `coupling` and `dark-matter` commands.

### Vulnerability Reachability

Ingest npm audit (or Trivy/OSV) output, match vulnerable packages to symbols in the index, then trace call-graph paths from entry points to vulnerable code. Classifies vulnerabilities as reachable or unreachable from application entry points.

**Reference:** Roam Code's `vuln-map` + `vuln-reach` two-stage pipeline.

### Data Flow / Taint Tracking

Source-to-sink analysis for security vulnerabilities (SQL injection, RCE, etc.). Substantial implementation effort and orthogonal to the current architectural analysis focus.

**Reference:** Code Pathfinder's DFG-based taint tracking with Python SDK rules.

## Features Where mma Already Leads

For context, areas where mma has comparable or stronger capabilities than the competition:
- **Dual-engine parsing** -- tree-sitter + ts-morph (type-resolved extraction). Roam Code and Code Pathfinder are tree-sitter only.
- **Cross-repo analysis** -- packageRoots resolution, repo-scoped edges and queries. Most competitors are single-repo.
- **Service topology** -- queue producers/consumers, HTTP clients, WebSocket detection. Richer protocol diversity than competitors.
- **Fault tree generation** -- no competitor offers this.
- **SARIF output** -- standardized format with logical locations. Roam Code also supports SARIF; most others do not.
- **Pattern detection** -- adapter, facade, observer, factory, singleton, repository, middleware, decorator.
- **4-tier summarization** -- from free AST templates to optional LLM-powered descriptions.
