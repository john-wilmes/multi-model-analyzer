# Getting Started with Multi-Model Analyzer

This guide walks you through your first analysis in about 15 minutes.

## Prerequisites

- Node.js 22 or later
- Git

## Installation

### Option 1: Install globally

```bash
npm install -g multi-model-analyzer
```

### Option 2: Build from source

```bash
git clone https://github.com/lumahealthhq/multi-model-analyzer.git
cd multi-model-analyzer
npm install
npm link
```

After either option, `mma --help` should print the command list.

## Quick Index: Your First Analysis

Create a file called `quickstart.config.json` in any working directory:

```json
{
  "repos": [
    { "url": "https://github.com/supabase/supabase-js.git", "branch": "main" },
    { "url": "https://github.com/supabase/ssr.git", "branch": "main" }
  ],
  "mirrorDir": "./mirrors",
  "outputDb": "./mma-quickstart.db"
}
```

Then run:

```bash
mma index -c quickstart.config.json -v
```

The `-v` flag enables verbose output so you can follow along. Here is what happens:

1. **Clone**: Each repo is cloned as a bare mirror under `./mirrors/`. Subsequent runs fetch only new commits.
2. **Parse**: TypeScript and JavaScript files are parsed with tree-sitter (fast, syntax-level) and optionally ts-morph (type-resolved). Symbols, exports, and imports are extracted.
3. **Graph construction**: Dependency edges and call graph edges are stored in a SQLite-backed graph store inside `mma-quickstart.db`.
4. **Heuristics**: Service roles, feature flags, and architectural patterns are inferred from the symbol graph.
5. **SARIF diagnostics**: Findings are generated (coupling violations, instability zones, dead exports, etc.) and stored in SARIF v2.1.0 format.
6. **ATDI score**: An Architectural Technical Debt Index (0-100) is computed and printed at the end.

Two small repos like these finish in under a minute on most machines.

## Exploring Results

### Natural language queries

```bash
mma query "what patterns exist?"
mma query "which modules have the highest coupling?"
mma query "are there any circular dependencies?"
```

Queries route to the appropriate analysis store and return structured results.

### Best-practices report

```bash
mma practices
```

Prints recommendations based on detected patterns: high-instability packages, missing abstractions, overly broad exports, and similar issues.

### Export a findings report

```bash
mma report -o report.json
```

Writes an anonymized SARIF report to `report.json`. Rule IDs and severity levels are documented in `docs/findings-guide.md`.

### Web dashboard

```bash
mma dashboard
```

Opens a local web UI at `http://localhost:3000`. The dashboard has several tabs:

- **Overview**: ATDI score trend, top findings by severity, repo summary cards.
- **Dependencies**: Interactive dependency graph (Cytoscape). Zoom and click nodes to inspect module-level edges.
- **Call Graph**: Function-level call relationships filtered by repo or package.
- **Findings**: Filterable table of all SARIF results with rule ID, severity, location, and message.
- **Feature Flags**: Detected config flags and their usage sites across repos.
- **Service Catalog**: Inferred service roles (API gateway, data layer, utility, etc.) with confidence scores.
- **Fault Trees**: Cascading failure paths derived from the dependency graph.

## Sharing a Baseline

Indexing large repos can take several minutes. Baselines let you share pre-built analysis databases with teammates.

### Export for teammates (full, includes raw graph data)

```bash
mma export --raw -o baseline.db
```

This exports all KV keys and graph edges needed for incremental indexing. A teammate can import it on their machine:

```bash
mma import baseline.db
```

Or set `baselinePath` in their config to import automatically on first run:

```json
{
  "baselinePath": "./baseline.db",
  "repos": [ ... ]
}
```

### Export for external sharing (anonymized)

```bash
mma export -o anonymized.db
```

Strips repo URLs and file paths, keeping only structural metrics and findings.

### Prebuilt Supabase ecosystem baseline

A prebuilt baseline covering 10 Supabase repos (~20 MB compressed) is available as a GitHub release asset. Download it and run `mma import supabase-baseline.db` to explore a real-world multi-repo system without cloning anything.

## Using with GitHub Codespaces

This repository includes a devcontainer configuration. Click **Code > Open with Codespaces** on GitHub and the environment will be provisioned automatically with Node.js 22 and all dependencies installed via `npm install`.

Once the container starts, create your config file and run `mma index` — no local setup required.

## Next Steps

- **`docs/findings-guide.md`**: Full reference for all SARIF rule IDs, severity levels, trigger thresholds, and metrics (instability, abstractness, coupling zones).
- **`docs/baseline-sharing.md`**: Detailed baseline workflows for teams, including incremental updates and CI integration.
- **`CONTRIBUTING.md`**: How to add new heuristics, detectors, or storage backends.
- **`mma dashboard`**: The fastest way to explore findings visually once your first index run completes.
