# Multi-Model Analyzer

Static analysis system for large TypeScript/Node.js codebases. Extracts structural information, infers architecture, identifies configuration risks, builds fault trees, and generates documentation -- with minimal LLM usage.

## What It Does

Three analysis functions over a set of GitHub repositories:

1. **Configuration Validation** -- Inventories feature flags, infers constraints between them, checks for dead flags, impossible combinations, and untested interactions.
2. **Fault Tree Analysis** -- Finds error/warning log statements, traces backward through control flow to identify root causes, builds fault trees, flags silent failures and missing error boundaries.
3. **Functional Modeling** -- Generates service-level documentation from code structure and summaries, supports natural language queries over the codebase.

Output is SARIF v2.1.0 (static analysis standard) with logical locations only -- no source code is included in results.

## Architecture

Index-heavy, query-cheap. Expensive analysis runs once at index time; queries are lookups and graph traversals.

```
Repos --> Ingestion --> Parsing --> Structural Analysis --> Heuristic Analysis
                                                               |
                                          Summarization (tiers 1-4) --> Storage
                                                               |
                              Config Model / Fault Model / Functional Model
                                                               |
                                                      SARIF Diagnostics
```

### Package Inventory

| Package | Purpose |
|---------|---------|
| `packages/core` | Shared types, SARIF schema, hypothesis abstraction |
| `packages/ingestion` | Git clone/fetch, change detection, file classification |
| `packages/parsing` | AST parsing (tree-sitter for speed, ts-morph for type resolution) |
| `packages/structural` | Call graphs, dependency graphs, control flow graphs, SCIP index |
| `packages/heuristics` | Service boundary inference, pattern detection, feature flag scanning, log template mining, naming analysis |
| `packages/summarization` | 4-tier description generation (see below) |
| `packages/storage` | Adapter interfaces for graph DB, search engine, KV store |
| `packages/models/config` | Feature model + constraint validation |
| `packages/models/fault` | Fault tree construction + gap analysis |
| `packages/models/functional` | Service catalog + documentation + NL query |
| `packages/diagnostics` | SARIF emission, redaction, aggregation |
| `packages/query` | Query routing (structural, search, analytical) |
| `apps/cli` | CLI interface for indexing and querying |

### Summarization Tiers

| Tier | Source | Cost | Network | Example |
|------|--------|------|---------|---------|
| 1 | Templates from AST | Free | None | "Accepts (patientId: string), returns Promise" |
| 2 | Heuristics from naming | Free | None | "Fetches appointments for a patient" |
| 3 | qwen2.5-coder:1.5b via Ollama | Free | None (local) | "Queries appointment table, maps results, handles pagination" |
| 4 | Claude Sonnet API | API tokens | api.anthropic.com | "The Scheduler service manages appointment booking across provider calendars" |

Tiers 1-3 run locally with zero network calls. Tier 4 is optional and used only for service-level summaries.

## Setup

### Prerequisites

macOS with internet access for initial setup.

### One-Line Bootstrap

```bash
gh repo clone john-wilmes/multi-model-analyzer && cd multi-model-analyzer && ./scripts/setup.sh
```

### What the Setup Script Installs

| Software | Version | Source | Purpose | Network Access |
|----------|---------|--------|---------|---------------|
| Xcode CLT | System | Apple | Git, C compiler for native modules | None after install |
| Homebrew | Latest | brew.sh | Package manager | brew.sh, GitHub |
| Node.js | 22 LTS | nvm (GitHub) | JavaScript runtime | nodejs.org |
| npm packages | Per package.json | npmjs.com | Project dependencies (166 packages) | registry.npmjs.org |
| GitHub CLI | Latest | Homebrew | Authenticated repo clone | github.com |
| SQLite | System/Brew | Homebrew | Graph storage (POC) | None (local DB) |
| LevelDB | Latest | Homebrew | Key-value storage (POC) | None (local DB) |
| MeiliSearch | Latest | Homebrew | BM25 full-text search | None (local service, port 7700) |
| Ollama | Latest | Homebrew | Local LLM runtime | ollama.com (model download only) |
| qwen2.5-coder:1.5b | 1.5B params | Ollama registry | Code summarization (tier 3) | ~1 GB download, then local only |
| tree-sitter | Latest | Homebrew | Fast incremental parsing | None |
| dependency-cruiser | Latest | npmjs.com | Module dependency analysis | None |
| scip-typescript | Latest | npmjs.com | Cross-repo code intelligence | None |

### Network Access Summary

| Destination | When | Purpose |
|-------------|------|---------|
| github.com | Setup + indexing | Clone target repos, install tools |
| registry.npmjs.org | Setup only | Install npm packages |
| brew.sh | Setup only | Homebrew packages |
| ollama.com | Setup only | Download LLM model (~1 GB) |
| api.anthropic.com | Tier 4 only (optional) | Claude Sonnet API for service-level summaries |

After setup, the system operates **entirely locally** for tiers 1-3. The only ongoing network access is `git fetch` against target repos (for incremental re-indexing) and optionally the Anthropic API for tier 4 summaries.

### Runtime Services

Two local services run during analysis:

| Service | Port | Data Location | Purpose |
|---------|------|---------------|---------|
| MeiliSearch | 7700 | `./data/meilisearch/` | Full-text search over code summaries |
| Ollama | 11434 | `~/.ollama/` | Local LLM inference (tier 3) |

Both are localhost-only. Neither accepts external connections by default.

## Data Handling

- **Input**: Git repositories (cloned as bare mirrors to `./data/mirrors/`)
- **Processing**: AST parsing, graph extraction, heuristic analysis -- all in-memory or local storage
- **Output**: SARIF JSON files with logical locations only (no source snippets, no file contents)
- **Redaction**: Built-in SARIF redaction can hash service names and identifiers before sharing results
- **No telemetry**: The system sends no usage data anywhere

## Configuration

Copy `mma.config.example.json` to `mma.config.json` and add your target repositories:

```json
{
  "mirrorDir": "./data/mirrors",
  "repos": [
    {
      "name": "service-name",
      "url": "https://github.com/org/service-name.git",
      "branch": "main",
      "localPath": "./data/mirrors/service-name.git"
    }
  ]
}
```

## Usage

```bash
# Start services
meilisearch --db-path ./data/meilisearch &
ollama serve &

# Index repositories
npx mma index -v

# Query the index
npx mma query "what calls the authentication service?"
npx mma query "dependencies of scheduler"
npx mma query "error handling risks"
```

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for planned features informed by analysis of comparable tools.

## Development

```bash
npm run build          # TypeScript compilation
npm run type-check     # Type checking without emit
npm run test           # Run all tests
npm run clean          # Clean build artifacts
```
