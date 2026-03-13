# Research Synthesis: What Fundamentally Modifies, Constrains, or Extends the Multi-Model Analyzer Approach

Four research agents produced comprehensive reports covering architecture recovery, fault tree analysis, configuration constraint analysis, and minimal-LLM code analysis. A fifth agent verified references by visiting actual URLs and reading the papers.

---

## 1. No Automated Recovery Technique Works Alone

This is the single most important finding. Garcia, Ivkovic, Medvidovic (ASE 2013) tested six automated architecture recovery techniques against carefully verified ground-truth architectures. **All achieved below 20% accuracy.** Lutellier et al. (IEEE TSE 2018) expanded this to nine techniques and found MoJoFM scores of 38-59% -- still poor.

**What works instead:** Information fusion. SARIF (Zhang et al., ESEC/FSE 2023) combined three sources -- dependencies, code text (identifiers/comments), and folder structure -- and achieved **36% higher accuracy** than any single-source technique. A microservice tool comparison (Springer EMSE 2025) found that combining four tools achieved F1 of 0.91 vs. 0.86 for the best individual tool.

**Design constraint:** The system must combine multiple extraction methods and fuse their results. No single parser, analyzer, or technique will produce reliable results on its own.

---

## 2. Human-in-the-Loop Is Not Optional at the Current State of the Art

Murphy, Notkin, Sullivan's **Reflexion Models** (1995) remain the most industrially validated approach. The engineer defines a hypothesized architecture, maps it to code, and a tool computes convergences, divergences, and absences. This top-down approach leveraging domain knowledge consistently outperforms fully automated bottom-up techniques.

**Design constraint:** The POC should support a feedback loop where analysts define expected structures and the system reports deviations, rather than trying to discover architecture from scratch.

---

## 3. Constraint Extraction from Code Is Fundamentally Incomplete

Nadi, Berger, Kastner, Czarnecki (IEEE TSE 2015) showed that even highly accurate static analysis (93% precision) **only recovers 28% of existing constraints.** The remaining 72% come from domain knowledge, runtime behavior requirements, and corner cases not expressed in code structure.

However, what static analysis does find is valuable: Yin et al. (SOSP 2011) showed **38-54% of configuration parameter errors violate format or semantic rules** and are mechanically detectable. Configuration issues cause **31% of high-severity support requests** -- the single largest category.

**Design constraint:** Configuration validation must be a layered system: (1) schema/format validation catches the easy stuff mechanically, (2) constraint checking catches dependency violations, (3) human review handles semantic correctness. Don't promise 100% coverage from code analysis alone.

---

## 4. SAT/SMT Solving for Feature Models Is Easy and Fast

Mendonca, Wasowski, Czarnecki (SPLC 2009) proved that **feature model instances avoid the phase transition** that makes random SAT problems hard. Real-world feature models with thousands of features and constraints are solved in milliseconds by Z3.

The SPLC 2022 paper "From Feature Models to Feature Toggles in Practice" bridges SPL theory to the exact problem: model all variability using a feature model, resolve some at design/build time, generate feature toggles for the rest. This means products/rollouts can be formally modeled as a feature model and checked by a SAT solver.

Schroeder et al. (ESEC/FSE 2022) studied Microsoft Office's **12,000 active feature flags** and discovered hidden interdependencies using probabilistic reasoning on runtime query logs -- without code analysis at all.

**Design extension:** The configuration model should include a formal feature model (SAT-checkable) for the product-rollout relationships. The solver is not the bottleneck; modeling accuracy is.

---

## 5. Fault Trees from Source Code Have Not Been Automated for Modern Languages

Leveson & Harvey (1983) defined SFTA with language construct templates (if, while, assignment) for backward code tracing. NASA's SWEHB codifies this. But the technique is **fundamentally manual**: a Canadian nuclear shutdown system of 6,000 lines took 3 work-months via SFTA. It does not scale to modern polyglot codebases.

No tool exists that automatically generates fault trees from TypeScript/JavaScript source code. The closest work generates fault trees from **design models** (SysML, AADL), not code.

**What does work:** Static analysis of log statement placement as failure mode indicators. Each `log.error()` or `log.warn()` encodes developer knowledge about failure conditions. Drain (He et al., ICWS 2017) is the best-performing log parser (highest average accuracy across 16 benchmarks). Combined with backward control flow tracing from log statements, approximate fault trees can be built identifying which code paths lead to which logged failure conditions.

**Design constraint:** Don't attempt classical SFTA. Instead, treat log statements as the "top events" and trace backward through control flow to build pragmatic fault trees.

---

## 6. The Optimal Architecture Is Heavy Indexing, Cheap Queries

This is confirmed across every major system: Glean (Meta), CodeQL (GitHub/Semmle), SCIP (Sourcegraph), Infer (Meta), Aroma (Meta). The pattern is:

- **Index time:** Parse, analyze, embed, summarize. Use expensive tools (LLMs, deep static analysis) once.
- **Query time:** Lookups, graph traversals, vector similarity. No LLM calls.

Specific evidence:
- **Glean** returns simple queries in ~1ms, complex queries in a few ms, using RocksDB with layered immutable databases
- **SCIP** is 5x smaller than LSIF and 10x faster to generate than lsif-node
- **Infer** uses bi-abduction for compositional analysis -- procedures analyzed independently, results cached, incremental updates proportional to changes
- **Aroma** recommends code in 1.6 seconds using purely structural features from parse trees, no LLM
- **BM25** (sparse retrieval) outperforms dense neural methods for code-to-code retrieval where lexical overlap is high

**Design confirmation:** The Opus-for-development, Sonnet-for-execution model maps perfectly to this. Use Opus to build the indexing pipeline and analysis logic. At runtime, Sonnet handles only the queries that genuinely need LLM reasoning (intent extraction, natural language responses). Everything structural runs without LLM.

---

## 7. TypeScript Toolchain Is Well-Served

For Node/TypeScript/React stack, the production-quality toolchain is:

| Tool | Purpose | LLM Required |
|------|---------|-------------|
| tree-sitter + tree-sitter-typescript | Fast incremental parsing | No |
| ts-morph | Type-aware AST analysis, symbol lookup | No |
| dependency-cruiser | Dependency validation, circular detection | No |
| scip-typescript | Precomputed code intelligence (definitions, refs, hover) | No |
| Joern | Code Property Graphs (AST+CFG+PDG) | No |
| Z3 (via z3-solver npm) | SAT/SMT constraint checking | No |
| Drain3 | Log template mining | No |
| BM25 (Elasticsearch) | Lexical code search | No |
| CodeBERT/ColBERT | One-time embedding generation | Once at index |

All npm-installable and actively maintained.

---

## 8. Scale Remains Unsolved for Hundreds of Services

No technique has been empirically validated on systems with hundreds of microservices and millions of lines of polyglot code. The microservice tool comparison (2025) tested on benchmark suites with 5-20 services. All available tools target Java/Spring Boot; polyglot support is an open problem.

**Design constraint:** The POC with ~12 repos is well within validated ranges. Scaling to 300 repos will require incremental/compositional analysis patterns (like Infer's bi-abduction or Graspan's disk-based graph processing) that should be designed for from the start, even if the POC doesn't need them.

---

## Bottom Line: What Changes vs. What Stays

**Stays the same:**
- Three-model approach (config, fault, functional) is well-grounded
- Code as sole source of truth is validated by the literature
- Opus for dev, Sonnet for execution maps to the index-heavy/query-cheap pattern

**Must change:**
- No single extraction technique -- must fuse multiple methods
- Constraint extraction will never be complete from code alone -- design for layered validation
- Don't attempt classical SFTA -- use log statements as fault tree roots instead
- Human-in-the-loop is required, not optional, for architecture-level accuracy

**Should add:**
- Formal feature model with SAT solver for product-rollout constraint checking
- SCIP indexes as the precomputed code intelligence backbone
- Compositional/incremental analysis from day one (even if POC doesn't need scale)
- BM25 as primary code search (outperforms neural methods for structural queries)
