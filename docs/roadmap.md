# Feature Roadmap

Candidate features informed by analysis of comparable open-source projects: [Roam Code](https://github.com/Cranot/roam-code), [Code Pathfinder](https://github.com/shivasurya/code-pathfinder), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser), [Sourcegraph/SCIP](https://github.com/sourcegraph/scip), [CodeMCP](https://github.com/SimplyLiz/CodeMCP).

## Landscape Summary

No existing tool combines all of what mma does: tree-sitter + ts-morph dual parsing, cross-repo service topology (queue/HTTP/WebSocket), fault tree generation, pattern detection, 4-tier summarization, SARIF output, and natural language query routing -- all without LLM calls at analysis time. The closest competitors either focus on one slice (dependency-cruiser for dep graphs, Jelly for call graphs) or are broader platforms that don't expose raw analytical models (Sourcegraph, CodeScene). The emerging MCP-server tools (Roam Code, Code Pathfinder, CodeMCP) are the most similar in spirit but are younger and primarily designed as AI-agent context providers rather than standalone analysis pipelines.

## Completed

### MCP Server ✓

Implemented in `packages/mcp`. Exposes mma's query layer as MCP tools over stdio transport for AI agent integration (Claude Code, Codex, Cursor, etc.). Run via `npx mma serve`.

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

## Lower Priority

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
