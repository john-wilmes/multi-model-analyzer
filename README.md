[![CI](https://github.com/john-wilmes/multi-model-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/john-wilmes/multi-model-analyzer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: 22+](https://img.shields.io/badge/Node-22%2B-brightgreen.svg)](https://nodejs.org/)

# Multi-Model Analyzer (mma)

> ⚠️ **Status: Beta** — APIs and output formats may change between releases.

## Contents
- [What It Finds](#what-it-finds)
- [Key Features](#key-features)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Examples](#examples)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Data Handling](#data-handling)
- [Findings Reference](#findings-reference)
- [Contributing](#contributing)
- [License](#license)

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

## Key Features

- Cross-repo analysis across hundreds of TypeScript repositories
- SARIF v2.1.0 output with built-in anonymization for safe sharing
- MCP server for IDE/agent integration (`mma serve`) — stdio or HTTP transport
- Web dashboard with dependency graphs, blast radius, and service catalog views
- 4-tier summarization (2 free local tiers + 2 optional LLM tiers)
- Design pattern detection (adapter, facade, observer, factory, singleton, repository, middleware, decorator)
- Baseline sharing for incremental reindexing across teams — see [docs/baseline-sharing.md](docs/baseline-sharing.md)
- Pluggable storage backends: SQLite (default) and Kuzu graph DB (`--backend kuzu`)
- Barrel cycle suppression (`suppressBarrelCycles`) to filter index-mediated false positive cycles
- Worker-thread blast radius computation for large graphs (with timeout fallback)
- Lazy SARIF pagination for O(limit) result streaming across large repos
- No LLM required for core analysis — everything runs locally

See [where MMA fits in the ecosystem](docs/ecosystem-venn.svg) for a capability map across related tools.

### Dashboard

The web dashboard provides interactive dependency graphs, blast radius visualization, service health overview, cross-repo correlation views, feature flag inventory, and fault tree exploration. Launch it with `mma dashboard` (default port 3000).

## Quick Start

If installed globally via `npm link` you can use `mma` directly. Otherwise, after cloning, invoke the CLI as `node apps/cli/dist/index.js`:

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
node apps/cli/dist/index.js index -v
node apps/cli/dist/index.js practices
```

## Commands

```
mma index      Index repositories (clone, parse, analyze)
mma practices  Health report with prioritized findings and grades
mma query      Natural language queries ("what calls auth?", "dependencies of scheduler")
mma report     Anonymized field trial report (JSON, markdown, SARIF)
mma export     Export SQLite DB (anonymized by default, --raw for baseline sharing)
mma import     Import a raw baseline export into local DB
mma merge      Combine multiple anonymized export DBs
mma validate   Statistical validation of SARIF findings quality
mma affected   Blast radius for a rev range
mma serve      MCP server for IDE integration (stdio by default; --transport http for HTTP mode, port 3001)
mma baseline create  Snapshot findings as known-violations baseline
mma baseline check   Check for new violations against baseline (exit 1 if found)
mma delta      Show diff of findings between two runs
mma catalog    Inspect the inferred service catalog
mma dashboard  Launch the web dashboard UI (default port 3000)
mma compress   Compress/prune the SQLite DB to reduce disk usage
mma audit      Parse npm audit JSON and check vulnerability reachability
mma enrich     Enrich summaries with LLM (Tier 3/4) outside of index
mma explore    Interactive incremental indexing (guided repo discovery)
```

Key flags that apply across commands:

```
--backend kuzu   Use Kuzu graph DB instead of SQLite (applies to index, serve, explore, and others)
--transport http  Use HTTP transport for MCP server instead of stdio (applies to serve, default port 3001)
--enrich          Enable LLM enrichment (Tier 3/4) during indexing (requires --api-key or ANTHROPIC_API_KEY)
```

## Examples

### Prioritized Practices Report

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

### Anonymized SARIF

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

**Summarization** has 4 tiers -- the first 2 are free and local; tiers 3–4 use the Anthropic API:

| Tier | Source | Cost | Example |
|------|--------|------|---------|
| 1 | Templates from AST | Free | "Accepts (patientId: string), returns Promise" |
| 2 | Heuristics from naming | Free | "Fetches appointments for a patient" |
| 3 | Claude Haiku API | API tokens | "Queries appointment table, maps results, handles pagination" |
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
| `packages/storage-kuzu` | Graph DB backend (Kuzu, optional) |
| `packages/correlation` | Cross-repo service correlation |
| `packages/models/*` | Config model, fault model, functional model |
| `packages/diagnostics` | SARIF emission, redaction, aggregation |
| `packages/query` | Natural language query routing |
| `packages/mcp` | MCP server for IDE integration |
| `apps/cli` | CLI entry point |
| `apps/dashboard` | Web dashboard (React 19, Recharts, Cytoscape) |

## Prerequisites

- Node.js 22+
- macOS, Linux, or Windows (WSL2)

Optional:
- Anthropic API key for tier 3 (Haiku) and tier 4 (Sonnet) summarization

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

## License

[MIT](LICENSE)
