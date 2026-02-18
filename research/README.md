# Multi-Model Analyzer Research

Research findings for a system that analyzes a large healthcare SaaS codebase (~300 GitHub repos, React/Node/TypeScript/microservices) supporting three functions:

1. **Configuration Validation** -- constraint analysis of product/rollout feature flags
2. **Fault Tree Analysis** -- from log statements in source code, mapping to Datadog output
3. **Functional Modeling** -- documentation generation, natural language queries about system behavior

## Key Design Constraints (from research)

1. **Fuse multiple extraction methods** -- no single technique exceeds ~60% accuracy alone (Garcia 2013, Lutellier 2018)
2. **Human-in-the-loop via Reflexion Models** -- define expected structures, system reports deviations
3. **Layered config validation** -- schema + constraints + human review (code analysis recovers only 28% of constraints per Nadi 2015)
4. **SAT solver for product-rollout feature models** -- fast and well-proven (Mendonca 2009)
5. **Log statements as fault tree roots** -- don't attempt classical SFTA, trace backward from log.error/warn calls
6. **Heavy indexing, cheap queries** -- Opus for development, Sonnet for execution
7. **TypeScript toolchain is mature** -- tree-sitter, ts-morph, dependency-cruiser, scip-typescript, Joern, Z3
8. **Design for incremental/compositional analysis from day one**

## Research Documents

| File | Domain | Key Finding |
|------|--------|-------------|
| [synthesis.md](research/synthesis.md) | Overview | Consolidated design constraints from all four domains |
| [architecture-recovery.md](research/architecture-recovery.md) | Software Architecture Recovery | No automated technique works alone; information fusion is the frontier |
| [fault-tree-analysis.md](research/fault-tree-analysis.md) | Fault Tree Analysis | Classical SFTA doesn't scale; log-based backward tracing is practical |
| [configuration-constraints.md](research/configuration-constraints.md) | Configuration and Feature Flags | SAT solving is easy; constraint extraction is the bottleneck |
| [minimal-llm-code-analysis.md](research/minimal-llm-code-analysis.md) | Code Analysis Without Runtime LLM | Heavy indexing + cheap queries pattern validated at Meta/Google/Sourcegraph scale |
| [reference-verification.md](research/reference-verification.md) | Reference Verification | 8 key references verified; 1 significant error found and corrected |

## POC Scope

- ~12 repos initially (eClinicalWorks EHR integrations, scheduler, related products)
- Running on MacBook, later scaling to k8s
- Opus for development, Sonnet for execution, minimize runtime LLM tokens

## Technology Stack

| Layer | Tool | LLM Required | When |
|-------|------|-------------|------|
| Parsing | tree-sitter (incremental) | No | Every edit |
| Type-aware AST | ts-morph / TypeScript Compiler API | No | On change |
| Dependencies | dependency-cruiser | No | On change |
| Code intelligence index | scip-typescript (SCIP format) | No | On change |
| Structural queries | Joern CPG + graph DB | No | At query time |
| Lexical search | BM25 (Elasticsearch) | No | At query time |
| Semantic search | Precomputed embeddings (CodeBERT) | Once at index | At query time (dot product only) |
| Code summaries | Distilled model or SWUM templates | Once at index | At query time (lookup only) |
| High-level descriptions | LLM (Claude) | Once at index | At query time (lookup only) |
| Constraint solving | Z3 SAT/SMT solver | No | At query time |
| Log parsing | Drain3 | No | At index time |
