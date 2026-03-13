[![CI](https://github.com/john-wilmes/multi-model-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/john-wilmes/multi-model-analyzer/actions/workflows/ci.yml)

# Multi-Model Analyzer (mma)

Point `mma` at your TypeScript repos. Get back a health report with structural problems, fault risks, and dead code -- in seconds, with no LLM required.

```
$ mma index -c repos.json && mma practices

Practices Report — Grade: F (0/100) — 1 repo(s)

Category Scorecard:
Category      Health  Errors  Warnings  Notes  Total
------------  ------  ------  --------  -----  -----
structural    ★☆☆☆☆   0       64        420    484
fault         ★★☆☆☆   0       15        0      15
blast-radius  ★★★★★   0       0         10     10

Top Findings:
Rule                                Category    Level    Count  Score
----------------------------------  ----------  -------  -----  -----
structural/unstable-dependency      structural  warning  64     115
fault/unhandled-error-path          fault       warning  15     95
structural/dead-export              structural  note     186    75
structural/pain-zone-module         structural  note     222    75
```

That output is real -- [TypeORM](https://github.com/typeorm/typeorm) (3,371 modules, 61k call graph edges), indexed in 26 seconds on a laptop.

## What It Finds

| Category | What | Example |
|----------|------|---------|
| **Structural** | Unstable dependencies, dead exports, pain zone modules | "Module A (stable) depends on module B (unstable) -- inverted dependency direction" |
| **Fault** | Unhandled error paths, silent catch blocks, missing re-throws | "Catch block in `handler` has no logging or re-throw" |
| **Blast radius** | High-PageRank modules where changes ripple widely | "This module's public API affects 40% of the import graph" |

All findings are SARIF v2.1.0 with logical locations only -- no source code leaves your machine.

## Quick Start

```bash
# Clone and install
git clone https://github.com/john-wilmes/multi-model-analyzer.git
cd multi-model-analyzer && npm install && npm run build

# Create a config pointing at your repos
cat > mma.config.json << 'EOF'
{
  "mirrorDir": "./data/mirrors",
  "dbPath": "./data/mma.db",
  "repos": [{
    "name": "my-service",
    "url": "https://github.com/org/my-service.git",
    "branch": "main",
    "localPath": "./data/mirrors/my-service.git"
  }]
}
EOF

# Index and analyze
npx mma index -v
npx mma practices
```

## Commands

```
mma index      Index repositories (clone, parse, analyze)
mma practices  Health report with prioritized findings and grades
mma query      Natural language queries ("what calls auth?", "dependencies of scheduler")
mma report     Anonymized field trial report (JSON, markdown, SARIF)
mma export     Export anonymized SQLite DB for sharing
mma affected   Blast radius for a rev range
mma serve      MCP server for IDE integration (stdio)
```

## Example: Prioritized Practices Report

The `practices` command partitions findings into action tiers:

- **Fix Now** -- warnings and errors that indicate active risk
- **Plan For** -- notes worth addressing in the next cycle
- **Monitor** -- low-priority items to track over time

Each finding includes a concrete action:

```json
{
  "ruleId": "structural/unstable-dependency",
  "count": 64,
  "level": "warning",
  "interpretation": "A stable module depends on an unstable one, inverting the expected dependency direction.",
  "action": "Introduce an abstraction layer or inversion-of-control boundary to isolate the unstable module."
}
```

Output formats: `--format table` (default), `json`, `markdown`.

## Example: Anonymized SARIF

When sharing results externally, use `--salt` to redact identifiers:

```json
{
  "ruleId": "fault/unhandled-error-path",
  "level": "warning",
  "message": {
    "text": "Catch block in [REDACTED:b1861bbf]#handler has no logging or re-throw"
  },
  "locations": [{
    "logicalLocations": [{
      "name": "[REDACTED:ad0b9153]",
      "kind": "module",
      "properties": { "repo": "[REDACTED:527d4d8a]" }
    }]
  }]
}
```

No source code, no file paths, no service names -- just the structural finding.

## How It Works

Index-heavy, query-cheap. All analysis runs at index time; queries are lookups and graph traversals.

```
Repos --> Ingestion --> Parsing --> Structural Analysis --> Heuristic Analysis
                                                               |
                                          Summarization (tiers 1-4) --> Storage
                                                               |
                              Config Model / Fault Model / Functional Model
                                                               |
                                                      SARIF Diagnostics
```

**Parsing** uses [tree-sitter](https://tree-sitter.github.io/tree-sitter/) (WASM) for fast syntax-only parsing, with optional [ts-morph](https://ts-morph.com/) for type-resolved symbols.

**Summarization** has 4 tiers -- the first 3 are free and local:

| Tier | Source | Cost | Example |
|------|--------|------|---------|
| 1 | Templates from AST | Free | "Accepts (patientId: string), returns Promise" |
| 2 | Heuristics from naming | Free | "Fetches appointments for a patient" |
| 3 | qwen2.5-coder:1.5b via Ollama | Free (local) | "Queries appointment table, maps results, handles pagination" |
| 4 | Claude Sonnet API | API tokens | "The Scheduler service manages appointment booking across provider calendars" |

## Architecture

Monorepo with npm workspaces:

| Package | Purpose |
|---------|---------|
| `packages/core` | Shared types, SARIF schema |
| `packages/ingestion` | Git clone/fetch, change detection, file classification |
| `packages/parsing` | AST parsing (tree-sitter WASM + ts-morph) |
| `packages/structural` | Call graphs, dependency graphs, control flow graphs |
| `packages/heuristics` | Service inference, pattern detection, feature flags, log mining |
| `packages/summarization` | 4-tier description generation |
| `packages/storage` | Graph DB, search (FTS5/BM25), KV store (SQLite) |
| `packages/models/*` | Config model, fault model, functional model |
| `packages/diagnostics` | SARIF emission, redaction, aggregation |
| `packages/query` | Natural language query routing |
| `packages/mcp` | MCP server for IDE integration |
| `apps/cli` | CLI entry point |

## Prerequisites

- Node.js 22+
- macOS or Linux

Optional:
- [Ollama](https://ollama.com/) for tier 3 summarization (free, local)
- Anthropic API key for tier 4 summarization

## Data Handling

- Repos are cloned as bare mirrors (no working tree checkout)
- All analysis is local -- in-memory or SQLite
- Output uses logical locations only (no source snippets)
- Built-in redaction hashes all identifiers before sharing
- No telemetry

## Findings Reference

See [docs/findings-guide.md](docs/findings-guide.md) for all SARIF rule IDs, severity levels, and metrics.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Development

```bash
npm run build          # TypeScript compilation
npm run type-check     # Type checking without emit
npm run test           # Run all tests (1054 tests)
npm run lint           # ESLint
```

## License

[Apache 2.0](LICENSE)
