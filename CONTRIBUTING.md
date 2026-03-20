# Contributing to Multi-Model Analyzer

## Prerequisites

- Node.js 22+
- npm

### Optional dependencies

- **Kuzu graph database** — The `packages/storage-kuzu` package uses [Kuzu](https://kuzudb.com/), an embedded graph database with prebuilt native binaries for Linux x64, macOS (x64/arm64), and Windows x64. It is installed automatically via npm. If Kuzu fails to install on your platform, mma falls back to SQLite-based storage (`packages/storage`) with full functionality.

## Getting Started

```bash
git clone https://github.com/john-wilmes/multi-model-analyzer.git
cd multi-model-analyzer
npm install
npm run build
npm test
```

## Project Structure

Monorepo with npm workspaces. 15 packages under `packages/` plus 2 apps (`apps/cli` and `apps/dashboard`):

| Package | Purpose |
|---------|---------|
| `packages/core` | Shared types, SARIF schema |
| `packages/ingestion` | Git clone/fetch, change detection |
| `packages/parsing` | AST parsing (tree-sitter + ts-morph) |
| `packages/structural` | Call/dependency/control-flow graphs |
| `packages/heuristics` | Service inference, pattern detection |
| `packages/summarization` | 4-tier description generation |
| `packages/storage` | Graph, search, KV stores (SQLite) |
| `packages/storage-kuzu` | Kuzu graph DB backend (optional) |
| `packages/correlation` | Cross-repo service correlation |
| `packages/models/config` | Feature model + constraint validation |
| `packages/models/fault` | Fault tree construction + gap analysis |
| `packages/models/functional` | Service catalog + NL query |
| `packages/diagnostics` | SARIF emission and aggregation |
| `packages/query` | Query routing |
| `packages/mcp` | MCP server for IDE integration |
| `apps/cli` | CLI entry point |
| `apps/dashboard` | Web dashboard (React 19) |

## Development Workflow

```bash
npm run build          # TypeScript compilation (all packages)
npm run test           # Run all tests (vitest)
npm run lint           # ESLint
npm run type-check     # Type checking without emit
npm run clean          # Clean build artifacts
```

Build before testing -- tests run against compiled output.

## Code Style

- TypeScript strict mode, ESM throughout
- Each package follows `src/` -> `dist/` layout with composite project references
- Barrel exports via `src/index.ts` in each package
- Do not commit generated files: `dist/`, `*.tsbuildinfo`
- tree-sitter WASM grammars in `packages/parsing/wasm/` are vendored in git. To refresh after updating tree-sitter packages: `npm run build:wasm -w packages/parsing`

## Pull Requests

1. Branch off `main`
2. Make your changes
3. Ensure `npm run build && npm run test && npm run lint` passes
4. Open a PR against `main`
5. CI runs automatically (build, type-check, lint, test)
6. CodeRabbit reviews PRs automatically -- address its findings before merging

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
