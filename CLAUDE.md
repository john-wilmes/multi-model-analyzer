# Multi-Model Analyzer -- Claude Code Instructions

## Project Overview

Static analysis toolchain for large TypeScript/JavaScript codebases. Extracts symbols, dependency graphs, call graphs, and architectural patterns without runtime LLM calls. Designed for ~300-repo scale.

## Architecture

Monorepo with npm workspaces, 13 packages:

| Package | Purpose |
|---------|---------|
| `packages/core` | Shared types (ParsedFile, SymbolInfo, GraphEdge, SARIF) |
| `packages/ingestion` | Git clone/fetch, change detection, file classification |
| `packages/parsing` | Symbol extraction via tree-sitter (WASM) and ts-morph |
| `packages/structural` | Dependency graphs, call graphs, control flow graphs |
| `packages/heuristics` | Service inference, pattern detection, feature flags |
| `packages/summarization` | 4-tier summary generation |
| `packages/storage` | Graph, search (FTS5/BM25), KV stores (SQLite + in-memory) |
| `packages/models/*` | Config (feature model), fault (fault trees), functional (service catalog) |
| `packages/diagnostics` | SARIF report generation |
| `packages/query` | Natural language query routing |
| `apps/cli` | CLI entry point (`mma index`, `mma query`) |

## Key Commands

```
npm install                 # Install all workspace deps
npm run build               # tsc --build (all 13 packages)
npm run build -w packages/parsing && npm run build:wasm -w packages/parsing
                            # Rebuild parsing + WASM grammars
npx tsc --build --noEmit    # Type-check without emit
npx vitest run              # Run tests
node apps/cli/dist/index.js index -c mma.config.json -v   # Index repos
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
- Do not commit generated files: `dist/`, `*.tsbuildinfo`, `packages/parsing/wasm/`
- Do not commit `mma.config.json` (contains local paths)
- Single-developer project: use feature branches + PRs to main
- All PRs are reviewed by CodeRabbit (GitHub app). Wait for the review and address findings before merging.
- CodeRabbit MCP server is available for local review queries (coderabbitai in ~/.claude/settings.json)

## File Conventions

- All packages follow `src/` -> `dist/` layout with composite TypeScript projects
- Barrel exports via `src/index.ts` in each package
- SQLite (better-sqlite3) for persistent storage; in-memory backends for unit tests
- Analysis output targets SARIF v2.1.0 format
