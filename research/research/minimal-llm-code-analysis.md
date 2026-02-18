# Deep Research: Large-Scale Code Analysis Without LLM at Query Time

## 1. Code Knowledge Graphs

### Code Property Graphs (CPGs)

The foundational work is **"Modeling and Discovering Vulnerabilities with Code Property Graphs"** by Yamaguchi, Golde, Arp, and Rieck (IEEE S&P 2014). CPGs merge three representations into a single graph:

- **Abstract Syntax Tree (AST)**: syntactic structure
- **Control Flow Graph (CFG)**: execution order
- **Program Dependence Graph (PDG)**: data and control dependencies

The schema uses nodes typed by program construct (METHOD, LOCAL, CALL, LITERAL, etc.) connected by labeled directed edges (AST, CFG, CDG, REACHING_DEF, EVAL_TYPE, CONTAINS, etc.). The original paper demonstrated 88 vulnerabilities found in the Linux kernel (18 previously unknown, 15 CVEs) using manually crafted graph traversals.

The production implementation is **[Joern](https://github.com/joernio/joern)** (open source, maintained by Qwiet AI / ShiftLeft). Joern supports C/C++, Java, JavaScript, TypeScript, Python, and Kotlin. Its CPG specification defines over 20 edge types including ALIAS_OF, BINDS, CAPTURE, DOMINATE, POST_DOMINATE, INHERITS_FROM, POINTS_TO, and TAGGED_BY. Queries are written in a Scala-based domain-specific language. The schema is extensible via a schema extender framework.

**Key finding**: CPGs are verified as the most efficient single representation for static vulnerability detection. They allow combining syntactic, control-flow, and data-flow queries in a single traversal, which no other single representation enables.

### CodeOntology

**[CodeOntology](http://codeontology.org/)** takes a different approach: RDF-izing source code using a semantic web ontology. It parses Java code into an AST, then serializes it as RDF triples. The resulting dataset can be queried via SPARQL. The OpenJDK 8 dataset is publicly available on Zenodo. The pipeline supports Maven and Gradle projects.

**Key finding**: SPARQL provides expressive structural queries over code but is limited to Java. The RDF approach is heavyweight compared to property graph databases for interactive querying.

### Kythe (Google)

**[Kythe](https://kythe.io/)** is Google's open-source code indexing system, essentially the public version of their internal "Grok" system. It defines a language-agnostic graph schema for cross-reference data by instrumenting compilers to emit graph-structured metadata. The schema covers definitions, references, documentation, and type relationships. Kythe supports C++, Go, Java, and works with build systems like Bazel.

**Key finding**: The schema design principle of instrumenting compilers (rather than re-parsing) yields the most accurate cross-reference data, since the compiler already has complete type resolution.

### Glean (Meta)

**[Glean](https://github.com/facebookincubator/Glean)** is Meta's code indexing system, open-sourced in 2021. Key technical details:

- **Storage**: RocksDB backend for scalability
- **Query language**: Angle, a declarative logic-based language (anagram of "Glean")
- **Incremental indexing**: Immutable database layers are stacked; each layer non-destructively adds or hides information from layers below. Cost is O(changes) rather than O(repository), though practical limitations create O(fanout) costs (e.g., changing a C++ header reprocesses all dependents)
- **Performance**: Simple queries return in ~1 millisecond; complex queries return first results in a few milliseconds with incremental fetching
- **Applications**: Code navigation, code search, documentation generation, dead code detection, build dependency analysis, test coverage tracking

The SCIP integration (Meta engineer Don Stewart) showed SCIP is **8x smaller and 3x faster to process** than LSIF.

**Key finding**: Glean's layered-immutable-database architecture is the state of the art for incremental code indexing at massive scale. The schema-per-language approach with a general-purpose query engine is proven at Meta's scale.

Sources:
- [Yamaguchi et al. - IEEE S&P 2014](https://ieeexplore.ieee.org/document/6956589/)
- [Joern - GitHub](https://github.com/joernio/joern)
- [Joern CPG Specification](https://cpg.joern.io/)
- [CodeOntology](http://codeontology.org/)
- [Kythe Overview](https://kythe.io/docs/kythe-overview.html)
- [Glean - Meta Engineering Blog](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)
- [Glean - GitHub](https://github.com/facebookincubator/Glean)

---

## 2. Precomputed Code Representations

### Code Embeddings

**code2vec** (Alon et al., POPL 2019) represents code snippets as fixed-length continuous vectors by decomposing code into paths in the AST. Each path connects two terminal nodes through the tree. The model learns atomic representations of paths and how to aggregate them via attention. It achieved **75% improvement** over previous techniques for method name prediction, with an F1 score of 58-59%.

**code2seq** (Alon et al., ICLR 2019) extends code2vec by encoding paths node-by-node with LSTMs instead of monolithic path embeddings, and decodes target sequences with an LSTM. This enables generating multi-token predictions (e.g., multi-word method names).

Both models produce **precomputed embeddings** that can be stored and reused. The embedding files are large (~2 GiB each for 128-dimensional vectors) but enable code similarity search without re-running the model.

**Key finding**: AST-path-based representations are the only approach that captures structural code semantics in precomputed vectors without requiring a language model at query time. The vectors support nearest-neighbor search for code similarity.

### Pre-trained Code Models (for one-time embedding generation)

- **CodeBERT** (Microsoft, 2020): First bimodal pre-trained model for programming and natural language, supporting 6 languages
- **GraphCodeBERT** (Microsoft, 2021): Extends CodeBERT by incorporating data flow graphs (semantic-level "where-the-value-comes-from" relationships between variables) into pre-training
- **UniXcoder** (Microsoft, 2022): Unified cross-modal pre-trained model supporting both understanding and generation tasks

These models can be used **once** to generate embeddings for an entire codebase. The embeddings are then stored in a vector database for retrieval without further model inference. A 2024 analysis of these models examined how they represent code syntax and semantics internally.

### SCIP (Sourcegraph)

**[SCIP](https://github.com/sourcegraph/scip)** (SCIP Code Intelligence Protocol) provides a precomputed semantic index format. Key metrics:

- **Protobuf-encoded** (vs LSIF's JSON): 5x smaller uncompressed, 4x smaller gzip-compressed
- **scip-typescript** achieved a **10x speedup** in CI over the previous lsif-node indexer
- Mapping SCIP into Glean requires **~550 lines of code** vs 1500 for LSIF
- Supports TypeScript, JavaScript, Java, Scala, Kotlin via dedicated indexers

**Key finding**: SCIP represents the most efficient precomputed code intelligence format currently available. It encodes definitions, references, hover documentation, and type information in a compact protobuf schema centered around human-readable symbol IDs.

Sources:
- [code2vec - ACM DL](https://dl.acm.org/doi/10.1145/3290353)
- [code2vec - GitHub](https://github.com/tech-srl/code2vec)
- [code2seq - GitHub](https://github.com/tech-srl/code2seq)
- [GraphCodeBERT - arXiv](https://arxiv.org/abs/2009.08366)
- [CodeBERT - GitHub](https://github.com/microsoft/CodeBERT)
- [SCIP - GitHub](https://github.com/sourcegraph/scip)
- [SCIP announcement - Sourcegraph Blog](https://sourcegraph.com/blog/announcing-scip)

---

## 3. Graph Databases for Code Analysis

### Neo4j

Neo4j is the most widely used graph database for code analysis in both research and industry. Key evidence:

- **Urma et al. (2014)**, "Source-code queries with graph databases," demonstrated storing syntactic and semantic representations of source code with interconnected graph layers in Neo4j, scaling to **44 million lines of code** in production
- Neo4j's architecture supports both operational and analytical workloads at **over 100 terabytes** without graph fragmentation
- The Cypher query language provides pattern-matching that maps naturally to code relationships (calls, inheritance, containment, data flow)

Industrial use cases include software dependency analysis, architecture visualization, and plagiarism detection.

### Graspan

**Graspan** (ASPLOS 2017, Wang et al.) is a purpose-built disk-based graph system for interprocedural static analysis. Key findings:

- Turns code analysis into a **Big Data analytics problem** using edge-pair centric computation for dynamic transitive closures
- Two backends: Graspan-C (CPU) and Graspan-G (GPU, orders of magnitude speedup)
- Analyzed **Linux, PostgreSQL, and Apache httpd**: found 132 new NULL pointer bugs, 1308 unnecessary NULL tests, and 401 fewer false positives
- Context-sensitive pointer/alias and dataflow analyses scale to **millions of lines of code** on a single commodity PC
- Implementations are **much simpler** than original analysis implementations

**Key finding**: Purpose-built graph systems significantly outperform general-purpose graph databases for interprocedural analysis at scale because they can exploit the specific computation patterns of static analysis (transitive closure, reachability).

### CodeQL (GitHub/Semmle)

**[CodeQL](https://codeql.github.com/)** takes a database-centric approach: source code is extracted into a **relational database** containing the AST, data flow graph, and control flow graph. Queries are written in QL, a specialized object-oriented query language that treats "code as data."

- Acquired by GitHub in 2019 (Semmle Inc.)
- Powers GitHub Advanced Security
- Creates self-contained databases that are queryable offline
- Open-source query libraries available for multiple languages

**Key finding**: CodeQL's approach of creating a complete queryable database from code is the most mature commercial implementation of "precomputed code model for offline querying." The QL language is purpose-designed for code queries and is more expressive than Cypher for code-specific patterns.

Sources:
- [Urma et al. - ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0167642313002943)
- [Graspan - ACM DL](https://dl.acm.org/doi/10.1145/3093336.3037744)
- [Graspan extended - ACM TOCS](https://dl.acm.org/doi/10.1145/3466820)
- [CodeQL](https://codeql.github.com/)
- [CodeQL Documentation](https://codeql.github.com/docs/codeql-overview/about-codeql/)

---

## 4. Hybrid LLM + Static Analysis

### One-Time LLM Annotation Approaches

The most promising pattern is: **use an LLM once to annotate/summarize code, store the annotations, query them without further LLM calls.**

**"Combining Large Language Models with Static Analyzers for Code Review Generation"** (arXiv, February 2025) evaluated three integration strategies:
1. **DAT (Data-Augmented Training)**: Integrate static analysis findings into LLM training data
2. **RAG (Retrieval-Augmented Generation)**: Inject static analysis results at inference time
3. **NCO (Naive Concatenation of Outputs)**: Combine outputs post-inference

Finding: Combining static analysis and LLMs captures the strengths of both -- the **precision** of static analysis and the **comprehensiveness** of LLMs.

**IRIS** (2024-2025): A neuro-symbolic approach combining LLMs with static analysis for whole-repository security vulnerability detection. The LLM reasons about patterns that static analysis flags, creating a precomputed vulnerability database.

**"Do Code LLMs Do Static Analysis?"** (May 2025): Found that traditional static analysis tools like **PyCG** (Python) and **Jelly** (JavaScript) **significantly outperform LLMs** in call-graph generation. However, for **type inference**, LLMs demonstrated a clear advantage. This suggests using LLMs for type annotation (once) and static analysis for structural queries.

### Aroma (Meta/Facebook)

**[Aroma](https://dl.acm.org/doi/10.1145/3360578)** (OOPSLA 2019) is a code recommendation system that demonstrates the precomputed-corpus approach:

1. **Index phase**: Parse every method in a large code corpus, extract structural features from parse trees, create sparse vectors
2. **Query phase**: Given a code snippet, compute its sparse vector, find top-1000 methods by dot product, rerank by structural similarity, cluster and intersect
3. **Performance**: Average recommendation time of **1.6 seconds** on a large corpus
4. No LLM involved at any stage -- purely structural features from ASTs

**Key finding**: The optimal architecture is to use LLMs for tasks where static analysis is weak (type inference, intent extraction, natural language summaries) and then store those results for query-time retrieval without further LLM calls. Structural queries (call graphs, dependencies, data flow) should never use LLMs.

Sources:
- [Hybrid Code Review - arXiv](https://arxiv.org/html/2502.06633v1)
- [Do Code LLMs Do Static Analysis? - arXiv](https://arxiv.org/html/2505.12118v1)
- [IRIS - OpenReview](https://openreview.net/forum?id=9LdJDU7E91)
- [Aroma - ACM DL](https://dl.acm.org/doi/10.1145/3360578)
- [Augmenting LLMs with Static Analysis - arXiv](https://arxiv.org/html/2506.10330v1)

---

## 5. Information Retrieval for Code

### Sparse Retrieval (BM25/TF-IDF)

BM25 improves on TF-IDF with two key innovations: **term frequency saturation** (diminishing returns for repeated terms) and **document length normalization**. BM25 is used in Elasticsearch, Apache Lucene, and Whoosh.

**"Practical Code RAG at Scale: Task-Aware Retrieval"** (arXiv, October 2025) provides the most definitive comparison:

- For **code completion** (code-to-code retrieval): BM25 with word-level splitting **consistently outperformed** dense retrieval methods. The substantial lexical overlap between query and target makes sparse scoring a natural fit.
- For **bug localization**: Dense retrieval (Voyager-3-Code) achieved ~0.72 NDCG vs ~0.57 for BM25.

### Dense Retrieval

Late-interaction models like **ColBERT** precompute per-token embeddings offline and store them, enabling fast retrieval at query time without running the full model. This is a middle ground: more expensive than BM25 at index time, but much cheaper than full neural inference at query time.

### The CoIR Benchmark (ACL 2025)

**[CoIR](https://github.com/CoIR-team/coir)** is the most comprehensive code retrieval benchmark, covering 10 datasets, 8 retrieval tasks, and 7 domains. It evaluates text-to-code, code-to-code, code-to-text, and hybrid retrieval. Key finding: even state-of-the-art models show **significant difficulties** in code retrieval tasks.

### CodeSearchNet

**[CodeSearchNet](https://github.com/github/CodeSearchNet)** (GitHub, 2019) established the standard benchmark: 6 million functions across 6 languages, with 2 million (comment, code) pairs. Baseline models (Neural-BoW, RNN, 1D-CNN, Self-Attention) achieved MRR scores of **0.47-0.69**.

### Hybrid Retrieval

The **TNO 2025 paper** "Orchestrating graph and semantic searches for code analysis" proposed combining graph-based structural queries with semantic embedding search. The orchestrator performed **exceptionally well on structural questions** (all but one correctly answered across ten runs). This confirms the pattern: use graph queries for structural questions, embedding search for semantic/intent questions.

**Key finding**: For code search, BM25 is an underappreciated baseline that outperforms neural methods for lexically-similar tasks (code completion, API search). The optimal approach is hybrid: BM25 for lexical queries, precomputed embeddings for semantic queries, graph traversal for structural queries.

Sources:
- [Practical Code RAG at Scale - arXiv](https://arxiv.org/pdf/2510.20609)
- [CoIR - arXiv](https://arxiv.org/abs/2407.02883)
- [CodeSearchNet - GitHub](https://github.com/github/CodeSearchNet)
- [TNO 2025 Paper](https://publications.tno.nl/publication/34644253/xS9zUaY0/TNO-2025-R10992.pdf)
- [Greptile Blog - Semantic Search Challenges](https://www.greptile.com/blog/semantic-codebase-search)

---

## 6. Applicable Open Source Tools (npm/TypeScript/JavaScript Ecosystem)

### Parsing and AST

**[Tree-sitter](https://tree-sitter.github.io/)**: Incremental parsing library supporting 100+ languages. Key characteristics:
- **Incremental**: Re-parsing after edits reuses the unchanged subtree. Benchmarks show sub-5ms reparse times on hundreds of megabytes.
- **Error-tolerant**: Produces useful parse trees even for syntactically incomplete code.
- **tree-sitter-typescript**: Dedicated grammar for TypeScript and TSX.
- **Performance**: Full parse of a 1.6MB file in ~1.2 seconds; incremental reparse in ~0.7 seconds. Production-quality, used by Neovim, Helix, Zed, GitHub, and Sourcegraph.

**[ts-morph](https://github.com/dsherret/ts-morph)**: TypeScript AST manipulation library built on the TypeScript Compiler API. Provides a higher-level abstraction for programmatic code analysis and transformation. Not a static analysis tool itself, but the **foundation** for building custom analysis tools. Gives full type-checked AST access including type resolution, symbol lookup, and declaration navigation.

### Dependency Analysis

**[madge](https://github.com/pahen/madge)**: Module dependency graph generator for CommonJS, AMD, and ES6 modules. Key features:
- Circular dependency detection via depth-first search
- Visual graph output (DOT format, convertible to images via Graphviz)
- TypeScript support via `--extensions ts` and `--ts-config` flags
- CLI: `npx madge --circular --extensions ts ./` detects all circular dependencies

**[dependency-cruiser](https://github.com/sverweij/dependency-cruiser)** (v17.3.8): More comprehensive than madge. Features:
- Rule-based validation of dependency patterns
- Multiple output formats: mermaid, JSON, CSV, HTML, plain text, DOT
- Configurable rules for: circular dependencies, orphans, missing package.json entries, prod code depending on devDependencies
- TypeScript, JavaScript, CoffeeScript, LiveScript support
- Used in production by major npm packages (real-world samples available in repo)

### Linting and Type Analysis

**[typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)**: ESLint plugin providing TypeScript-aware lint rules. Uses `@typescript-eslint/typescript-estree` to convert TypeScript to ESLint-compatible AST.

**[eslint-plugin-import](https://github.com/import-js/eslint-plugin-import)**: Import validation rules. The fork **eslint-plugin-import-x** provides better performance.

### Code Intelligence

**[scip-typescript](https://github.com/sourcegraph/scip-typescript)**: Generates SCIP indexes for TypeScript and JavaScript. 10x faster than lsif-node. Enables precomputed go-to-definition, find-references, and hover documentation.

**Key finding for your stack**: For a TypeScript/React codebase, the production-quality toolchain is: **tree-sitter** for fast incremental parsing, **ts-morph** for type-aware AST analysis, **dependency-cruiser** for dependency validation (superior to madge), and **scip-typescript** for precomputed code intelligence indexes. All are npm-installable and actively maintained.

Sources:
- [Tree-sitter](https://tree-sitter.github.io/)
- [tree-sitter-typescript - GitHub](https://github.com/tree-sitter/tree-sitter-typescript)
- [ts-morph - GitHub](https://github.com/dsherret/ts-morph)
- [madge - GitHub](https://github.com/pahen/madge)
- [dependency-cruiser - GitHub](https://github.com/sverweij/dependency-cruiser)
- [dependency-cruiser - npm](https://www.npmjs.com/package/dependency-cruiser)
- [scip-typescript - Sourcegraph](https://sourcegraph.com/blog/announcing-scip)

---

## 7. Code Analysis at Scale

### Meta/Facebook Infer

**[Infer](https://github.com/facebook/infer)** is the gold standard for scalable static analysis in production. Key technical details:

- **Compositional analysis via bi-abduction**: Procedures are analyzed independently of their callers. Bi-abduction infers both the precondition (what the procedure needs) and the frame (what it leaves unchanged). This makes analysis **naturally incremental** -- changing one procedure does not require re-analyzing all others.
- **Differential workflow**: Infer runs on two versions of a project and reports only introduced/fixed issues. Target: **15-20 minutes** on a diff (including checkout, build, and analysis of base and parent commits).
- **Scale**: Targets codebases with **tens of millions of lines**. Over **100,000 reported issues fixed** by developers before reaching production. By 2015, fixing over 1,000 bugs per month.
- **Separation logic**: Allows reasoning about small, independent parts of memory rather than the entire heap at every step.
- Used at Meta, Amazon, Spotify, Mozilla.

The paper **"Scaling Static Analyses at Facebook"** (CACM 2019) documents the key lessons. The companion paper **"Compositional Shape Analysis by Means of Bi-abduction"** (POPL 2009) won the Most Influential Paper award.

### Coverity

**"A Few Billion Lines of Code Later"** (Bessey et al., CACM 2010) documents Coverity's experience analyzing code for ~700 customers with over a billion lines of code collectively. Key lessons:
- **False positive rate** is the critical metric for adoption -- developers stop using tools with high false positive rates
- **Incremental analysis** is essential for CI integration
- Compiler compatibility is a major engineering challenge at scale

### Graspan at Scale

As noted in Section 3, Graspan demonstrated that interprocedural analyses (pointer/alias, dataflow) can be reformulated as graph problems and solved on commodity hardware. The GPU backend (Graspan-G) provides **orders of magnitude speedup**.

### Incremental Analysis Patterns

Research from ECOOP 2024 ("Scaling Interprocedural Static Data-Flow Analysis to Large C/C++ Applications") shows recent optimizations to IDE-based analysis improving runtime and memory usage by **up to 7x on average**.

General strategies that work at scale:
1. **Compositional/modular analysis**: Analyze procedures independently, cache results
2. **Differential analysis**: Only re-analyze changed code and its dependents
3. **Parallel computation**: Divide into work units, compute in parallel, cache results
4. **Disk-based processing**: Avoid memory limits by using disk for graph storage (Graspan approach)

**Key finding**: The only approaches that scale to hundreds of millions of lines are compositional (Infer's bi-abduction) or graph-based (Graspan's edge-pair computation). Traditional whole-program analysis does not scale.

Sources:
- [Infer - GitHub](https://github.com/facebook/infer)
- [Scaling Static Analyses at Facebook - CACM](https://cacm.acm.org/research/scaling-static-analyses-at-facebook/)
- [Bi-abduction - Infer Docs](https://fbinfer.com/docs/separation-logic-and-bi-abduction/)
- [A Few Billion Lines of Code Later - CACM](https://cacm.acm.org/research/a-few-billion-lines-of-code-later/)
- [Graspan - ACM TOCS](https://dl.acm.org/doi/10.1145/3466820)
- [Scaling Interprocedural Analysis - ECOOP 2024](https://drops.dagstuhl.de/storage/00lipics/lipics-vol313-ecoop2024/LIPIcs.ECOOP.2024.36/LIPIcs.ECOOP.2024.36.pdf)

---

## 8. Natural Language Generation from Code Models

### Template-Based Approaches (No LLM Required)

**SWUM (Software Word Usage Model)** by Sridhara et al. is the foundational work:
- Splits identifiers by camelCase convention
- Extracts verbs (starting word of method identifiers, e.g., "scan")
- Extracts noun phrases from parameter types and names
- Deduces verb-object relationships
- Generates natural language summaries using **predefined templates** for different Java statement types
- Requires zero neural computation at runtime

**Swummary** (open-source implementation on GitHub) applies SWUM to generate method summaries.

McBurney and McMillan (2014) extended this with **"Automatic Documentation Generation via Source Code Summarization"**, adding context-awareness by considering how a method is called and what calls it.

### Lightweight Neural Approaches

**"Distilled GPT for Source Code Summarization"** (Automated Software Engineering journal, 2024): Uses knowledge distillation to create a **350 million parameter** model trained on GPT-3.5 output. This model runs on a single 16GB GPU and approximates GPT-3.5's code summarization quality. Once deployed, it requires no API calls.

**SG-Trans** (ACM TOSEM, 2022): A structure-guided transformer that incorporates code structural properties into a smaller transformer model for code summarization.

**NeuralCodeSum** (ACL 2020): A transformer-based approach specifically for source code summarization, with open-source implementation available.

### Practical Template Generation

For generating descriptions from a precomputed code model without heavy LLM usage, the evidence supports a **three-tier approach**:

1. **Structural descriptions** (template-based): "Method `processOrder` in class `OrderService` takes parameters `(orderId: string, items: Item[])`, returns `Promise<OrderResult>`, calls `validateItems`, `calculateTotal`, `submitToPaymentGateway`. Has 3 branches and 2 error paths." This requires only AST traversal and templates.

2. **Semantic summaries** (distilled model): A small distilled model (350M-1B parameters) runs locally to generate one-line summaries like "Processes a customer order by validating items, computing the total, and submitting payment." This is computed once and cached.

3. **Intent/purpose descriptions** (one-time LLM): For high-level architectural descriptions ("This module handles the order fulfillment pipeline, integrating with Stripe for payments and SendGrid for confirmation emails"), use a large LLM once during indexing, store the result.

**Key finding**: Template-based generation from AST data produces accurate but mechanical descriptions. Distilled models (350M-1B params) provide human-quality summaries at low inference cost. The combination eliminates runtime LLM dependency while maintaining description quality.

Sources:
- [Sridhara et al. - ResearchGate](https://www.researchgate.net/publication/220883580_Towards_automatically_generating_summary_comments_for_Java_methods)
- [Swummary - GitHub](https://github.com/herbertkb/Swummary)
- [McBurney & McMillan - Automatic Documentation](https://sdf.org/~cmc/papers/mcburney_icpc_2014.pdf)
- [Distilled GPT for Code Summarization - Springer](https://link.springer.com/article/10.1007/s10515-024-00421-4)
- [NeuralCodeSum - GitHub](https://github.com/wasiahmad/NeuralCodeSum)
- [SG-Trans - ACM DL](https://dl.acm.org/doi/10.1145/3522674)
- [Automatic Code Summarization Survey - arXiv](https://arxiv.org/pdf/1909.04352)

---

## Synthesis: Recommended Architecture

Based on the evidence, the optimal architecture for large-scale code analysis with minimal LLM usage at query time would combine:

| Layer | Tool/Approach | LLM Required | When |
|-------|--------------|--------------|------|
| Parsing | Tree-sitter (incremental) | No | Every edit |
| Type-aware AST | ts-morph / TypeScript Compiler API | No | On change |
| Dependencies | dependency-cruiser | No | On change |
| Code intelligence index | scip-typescript (SCIP format) | No | On change |
| Structural queries | CodeQL or Joern CPG + graph DB | No | At query time |
| Lexical search | BM25 (Elasticsearch/Lucene) | No | At query time |
| Semantic search | Precomputed embeddings (CodeBERT/ColBERT) | Once at index | At query time (dot product only) |
| Code summaries | Distilled model (350M params) or SWUM templates | Once at index | At query time (lookup only) |
| High-level descriptions | LLM (GPT-4 / Claude) | Once at index | At query time (lookup only) |
| Incremental updates | Compositional analysis (Infer pattern) | Proportional to change | On change |

The key insight across all the research: **the expensive work (LLM inference, deep analysis) should happen at index time, and query time should involve only lookups, graph traversals, and vector similarity computations.** This is the pattern used by Glean, CodeQL, SCIP, Infer, and Aroma, and it scales to hundreds of millions of lines of code.
