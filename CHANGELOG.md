# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.1.0] - 2026-03-23

### Added
- Sanity check framework (`mma validate`) with 12 corpus-agnostic checks
- Architectural Technical Debt Index (ATDI) per-repo and system-wide scoring
- Cross-repo model analysis (breaking-change-risk, orphaned-service, shared-flag, cascading-fault, undocumented-consumer)
- Hotspot analysis (high churn + complexity detection)
- Web dashboard (`mma dashboard`) with React 19, Recharts, Cytoscape
- Baseline sharing via `mma export --raw` and `mma import`
- Ollama-based LLM enrichment (optional, runs locally)
- `mma delta` command for PR-level finding diffs
- `mma catalog` command for service catalog inspection
- `mma compress` command for DB pruning

### Fixed
- SARIF fingerprint stamping now covers all rule categories (was missing config, fault, cross-repo)
- Drain sanity check correctly unwraps `{repo, templates}` format
- dotenv override so `.env` takes precedence over shell env vars
- Fingerprint stamping runs after baseline comparison (so "absent" results get stamped)
- 19 bugs from Novu corpus dogfood audit

## [1.0.0] - 2026-03-17

### Added
- Cross-repo dependency graph visualization in dashboard
- Temporal coupling detection (git co-change analysis) in index pipeline and dashboard
- Per-repo dependency graph view with Cytoscape.js + dagre layout
- Per-repo ATDI gauge and debt breakdown on repo detail page
- Dependency graph link and temporal coupling table on repo detail page
- Cross-repo blast radius analysis with stable symbol IDs
- Architectural Technical Debt Index (ATDI) scoring
- Technical debt cost estimation (minutes per SARIF finding)
- ATDI gauge, debt bar chart, and per-repo ATDI chart in dashboard
- Backstage catalog export command (`mma catalog`)
- PR delta analysis command (`mma delta`)
- Dependency Structure Matrix (DSM) visualization in dashboard
- Main Sequence scatter chart in dashboard
- Hotspot analysis (high churn + complexity detection)
- Cross-repo correlation analysis (breaking-change-risk, orphaned-service, critical-path)
- Kuzu graph database backend with automatic migration (v1 -> v2 -> v3)
- MCP server with 10+ tools for IDE integration (`mma serve`)
- Flag impact traversal and inventory
- Ollama-based LLM enrichment (optional, runs locally)
- Natural language query routing
- Statistical validation of SARIF findings (`mma validate`)
- Baseline sharing via `mma export --raw` and `mma import`
- Local web dashboard (`mma dashboard`)
- 3-tier summarization (AST templates, heuristics, local Ollama LLM)
- Dual parsing engine: tree-sitter (WASM) + ts-morph (optional)
- SARIF v2.1.0 diagnostics with built-in redaction
- SQLite storage (graph, search/FTS5/BM25, KV)
- Git bare-mirror cloning and incremental indexing
- Service topology detection (HTTP, queue, WebSocket)
- Pattern detection (adapter, facade, observer, factory, singleton, repository, middleware, decorator)
- Fault tree generation and gap analysis
- Dead export detection
- Instability metrics and Stable Dependencies Principle violations

### Fixed
- `--diff-merges=first-parent` for accurate commit history
- OOM prevention at ~300 repo scale
- Path traversal, zombie symbols, and tree-sitter init race conditions
- Per-repo decomposition for graph edges and SARIF vectors
