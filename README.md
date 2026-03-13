[![CI](https://github.com/john-wilmes/multi-model-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/john-wilmes/multi-model-analyzer/actions/workflows/ci.yml)

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
| `packages/mcp` | MCP server for IDE integration (stdio transport) |
| `apps/cli` | CLI entry point (`index`, `query`, `serve`, `report`, `export`) |

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

macOS or Linux with internet access for initial setup. Node.js 22+ required.

### One-Line Bootstrap

```bash
gh repo clone <owner>/multi-model-analyzer && cd multi-model-analyzer && ./scripts/setup.sh
```

Replace `<owner>` with the GitHub user or organization that hosts your copy of the repo.

### What the Setup Script Installs

| Software | Version | Source | Purpose | Network Access |
|----------|---------|--------|---------|---------------|
| Xcode CLT | System | Apple (macOS only) | Git, C compiler for native modules | None after install |
| Homebrew | Latest | brew.sh (macOS only) | Package manager | brew.sh, GitHub |
| Node.js | 22 LTS | nvm (GitHub) | JavaScript runtime | nodejs.org |
| npm packages | Per package.json | npmjs.com | Project dependencies | registry.npmjs.org |
| GitHub CLI | Latest | Homebrew / apt | Authenticated repo clone | github.com |
| SQLite | System/Brew/apt | OS package manager | Graph, search, and KV storage | None (local DB) |
| Ollama | Latest | Homebrew / ollama.com | Local LLM runtime | ollama.com (model download only) |
| qwen2.5-coder:1.5b | 1.5B params | Ollama registry | Code summarization (tier 3) | ~1 GB download, then local only |
| tree-sitter | Latest | Homebrew / npm | Fast incremental parsing | None |
| dependency-cruiser | Latest | npmjs.com | Module dependency analysis | None |
| scip-typescript | Latest | npmjs.com | Cross-repo code intelligence | None |

On Linux, the script uses `apt-get` where available. For other Linux distros, it prints manual install instructions.

### Network Access Summary

| Destination | When | Purpose |
|-------------|------|---------|
| github.com | Setup + indexing | Clone target repos, install tools |
| registry.npmjs.org | Setup only | Install npm packages |
| brew.sh | Setup only (macOS) | Homebrew packages |
| ollama.com | Setup only | Download LLM model (~1 GB) |
| api.anthropic.com | Tier 4 only (optional) | Claude Sonnet API for service-level summaries |

After setup, the system operates **entirely locally** for tiers 1-3. The only ongoing network access is `git fetch` against target repos (for incremental re-indexing) and optionally the Anthropic API for tier 4 summaries.

### Runtime Services

One local service is used during analysis (optional -- tier 3 summarization only):

| Service | Port | Data Location | Purpose |
|---------|------|---------------|---------|
| Ollama | 11434 | `~/.ollama/` | Local LLM inference (tier 3) |

Ollama is localhost-only and does not accept external connections by default. Override the URL and model via environment variables: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`.

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
  "dbPath": "./data/mma.db",
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

`dbPath` is resolved relative to the config file directory. It can also be overridden with the `--db` CLI flag.

## Usage

```bash
# Start Ollama (optional, for tier 3 summarization)
ollama serve &

# Index repositories
npx mma index -v

# Query the index
npx mma query "what calls the authentication service?"
npx mma query "dependencies of scheduler"
npx mma query "error handling risks"

# Start MCP server (for IDE integration, stdio transport)
npx mma serve

# Generate anonymized field trial report
npx mma report --format markdown -o report.md
npx mma report --include-sarif --salt "$(openssl rand -hex 16)"

# Export anonymized database for sharing
npx mma export -o export.db --salt "$(openssl rand -hex 16)"

# Generate best-practices recommendations
npx mma practices
npx mma practices --format json -o practices.json
```

The `export` command creates a portable SQLite database with all repo names, file paths, and service names hashed. It includes KV and edge data but strips symbols and FTS indexes. Use `--salt` to control the hash seed (omit for a random salt).

The `practices` command reads SARIF findings and structural metrics to produce a prioritized report with health grades, tier-partitioned findings (Fix Now / Plan For / Monitor), structural health ratings, and concrete recommendations. Unlike `report`, it uses real repo names and is designed for the repo owner, not for anonymized data collection.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for planned features informed by analysis of comparable tools.

## Findings Reference

See [docs/findings-guide.md](docs/findings-guide.md) for detailed explanations of all SARIF diagnostic rules, metrics, and model outputs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Development

```bash
npm run build          # TypeScript compilation
npm run type-check     # Type checking without emit
npm run test           # Run all tests
npm run clean          # Clean build artifacts
```
