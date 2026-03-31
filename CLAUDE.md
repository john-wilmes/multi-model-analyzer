# Multi-Model Analyzer -- Claude Code Instructions

## Project Overview

Static analysis toolchain for large TypeScript/JavaScript codebases. Extracts symbols, dependency graphs, call graphs, and architectural patterns without cloud LLM calls. Designed for ~300-repo scale.

## Architecture

Monorepo with npm workspaces — 15 `packages/*` workspaces + 2 apps (`apps/cli`, `apps/dashboard`):

| Package | Purpose |
|---------|---------|
| `packages/core` | Shared types (ParsedFile, SymbolInfo, GraphEdge, SARIF) |
| `packages/ingestion` | Git clone/fetch, change detection, file classification |
| `packages/parsing` | Symbol extraction via tree-sitter (WASM) and ts-morph |
| `packages/structural` | Dependency graphs, call graphs, control flow graphs |
| `packages/heuristics` | Service inference, pattern detection, feature flags, log mining |
| `packages/summarization` | 3-tier summary generation |
| `packages/storage` | Graph, search (FTS5/BM25), KV stores (SQLite + in-memory) |
| `packages/storage-kuzu` | Kuzu-backed graph, search, and KV stores |
| `packages/correlation` | Cross-repo correlation and service grouping |
| `packages/mcp` | MCP server exposing analysis tools to LLM agents |
| `packages/models/config` | Feature model (config flag inventory) |
| `packages/models/fault` | Fault trees (fault detection rules) |
| `packages/models/functional` | Service catalog (functional service inference) |
| `packages/diagnostics` | SARIF report generation |
| `packages/query` | Natural language query routing |
| `apps/cli` | CLI entry point (`mma index`, `mma query`, `mma practices`) |
| `apps/dashboard` | Web dashboard (React 19, Recharts, Cytoscape) |

## Key Commands

```bash
npm install                 # Install all workspace deps
npm run build               # tsc --build (all workspaces)
npm run build -w packages/parsing && npm run build:wasm -w packages/parsing
                            # Rebuild parsing + WASM grammars
npx tsc --build --noEmit    # Type-check without emit
npx vitest run              # Run tests
node apps/cli/dist/index.js index -c mma.config.json -v   # Index repos
node apps/cli/dist/index.js export --raw -o baseline.db    # Export raw baseline
node apps/cli/dist/index.js import baseline.db             # Import baseline
node apps/cli/dist/index.js validate --mirrors ./mirrors   # Validate findings
```

## Parsing Layer

Two parsing engines with graceful degradation:

- **tree-sitter** (web-tree-sitter, WASM): Fast syntax-only parsing. Handles .ts, .tsx, .js, .jsx, .mjs, .cjs. WASM grammars are built from node_modules via `npm run build:wasm -w packages/parsing` (runs automatically on `npm install`).
- **ts-morph**: Type-resolved symbol extraction. Optional, enabled via `enableTsMorph` flag. Slower but produces richer symbols (type info, accurate export detection).

The `parseFiles()` orchestrator runs tree-sitter first, then optionally augments with ts-morph results. Either engine can fail independently.

## Development Rules

- Node.js 22+ required
- TypeScript strict mode, ESM throughout
- Build must pass (`npx tsc --build`) before committing
- Do not commit generated files: `dist/`, `*.tsbuildinfo`
- Do not commit `mma.config.json` (contains local paths)
- Do not commit `luma.mapping.json` or variants (private Luma-specific mapping for the `validate-org-config` skill)
- Single-developer project: use feature branches + PRs to main. The `protect-main.js` hook (from the playbook repo) blocks direct commits to main/master.
- All PRs are reviewed by CodeRabbit (GitHub app). Wait for the review and address findings before merging.
- CodeRabbit MCP server is available for local review queries (coderabbitai in ~/.claude/settings.json)

## Findings Reference

Findings reference: `docs/findings-guide.md` — explains all SARIF rule IDs, severity levels, trigger thresholds, metrics (instability, abstractness, zones), and non-SARIF model outputs.

## File Conventions

- All packages follow `src/` -> `dist/` layout with composite TypeScript projects
- Barrel exports via `src/index.ts` in each package
- SQLite (better-sqlite3) for persistent storage; in-memory backends for unit tests
- Analysis output targets SARIF v2.1.0 format

## Baseline Sharing

Raw exports (`mma export --raw`) include all KV keys and graph edges needed for incremental indexing. Colleagues import via `mma import` or set `baselinePath` in config for automatic import on first `mma index` run. See `docs/baseline-sharing.md` or README for details.
