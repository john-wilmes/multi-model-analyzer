# Design Constraints Addendum: Research-Backed Refinements

Based on additional research into the four design constraints identified during the interview phase.

---

## Updated Design Constraints

1. **Autonomous initially, human-in-the-loop pluggable later.** Every place the system accepts "expected structure" input has a default provider (heuristics from code conventions, folder structure, naming patterns) and a human provider interface that can replace it later. The Reflexion Model pattern (Murphy 1995) explicitly separates hypothesis source from comparison engine -- the hypothesis can come from either.

2. **Maximize template/heuristic + local small model for human-readable output, minimize Sonnet tokens.** Three tiers of human-readable generation:
   - **Tier 1 (free):** Template-based from AST data -- structural signatures, call graphs, dependency lists, parameter types. SWUM-style (Sridhara et al.) identifier splitting and verb-object extraction.
   - **Tier 2 (free):** Heuristic-based -- inferred from naming conventions, folder structure, established patterns in the codebase.
   - **Tier 3 (local model, no API tokens):** `qwen2.5-coder:1.5b` via Ollama for method-level natural language summaries. Runs on M-series MacBook (986 MB, Metal-accelerated). Zero cloud API calls.
   - **Tier 4 (Sonnet, sparingly):** Service-level purpose descriptions, cross-cutting concern analysis, ambiguous intent extraction. Only what tiers 1-3 cannot handle.

3. **Sonnet-only cloud runtime for what local model can't do.** Opus is available only for developing the analyzer code (design time). Both indexing and querying run in a Sonnet-only environment. Local small model handles bulk summarization. Sonnet reserved for higher-level synthesis.

4. **SARIF-based abstracted diagnostic protocol for Opus-side iteration.** Every analysis component emits SARIF-formatted diagnostic output (source snippets omitted, logical locations only) that can be brought back for iteration without exposing proprietary code.

---

## SARIF as Diagnostic Protocol Foundation

### What SARIF Is

SARIF (Static Analysis Results Interchange Format) is an OASIS standard (v2.1.0, August 2023). It defines a JSON schema for static analysis tool output. Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

### Why It Fits

- **Source snippets are optional by spec** (section 3.30.13: region MAY contain snippet). A fully conformant SARIF file can contain rule IDs, logical locations (class/method names, nesting kind), severity, message text, and control-flow structure -- with zero source code.
- **`redactionTokens` field** (section 3.14.28) is defined for post-processing tools to scrub sensitive values.
- **Logical locations** capture class names, method names, and structural nesting without line-level source.

### Production Adoption

SARIF is the native output format for:
- **CodeQL** (GitHub) -- `--format sarif-latest`
- **Semgrep** -- `--sarif` flag, uploads to GitHub Advanced Security
- **GCC** -- SARIF diagnostic output format (added 2022)
- **MSVC** -- structured SARIF diagnostics
- **Checkov** -- IaC scanner
- **LinkedIn** -- rebuilt SAST pipeline (2025-2026) normalizing CodeQL + Semgrep via SARIF

### How to Extend for Multi-Model Analyzer

SARIF's `result` object structure maps to analyzer diagnostics:

| Analyzer Output | SARIF Field |
|----------------|-------------|
| Config constraint violation | `ruleId` = "config/missing-rollout-association" |
| Fault tree node | `ruleId` = "fault/unhandled-error-path" |
| Functional model gap | `ruleId` = "functional/undocumented-service-boundary" |
| Severity | `level` = error/warning/note |
| Location (no code) | `logicalLocations` = [{ name: "OrderService.processOrder", kind: "function" }] |
| Control flow trace | `codeFlows` with logical location steps |
| Statistics | Custom `properties` bag on `run` object |

Custom rule taxonomies go in the `tool.driver.rules` array with `id`, `shortDescription`, `helpUri`.

---

## Local Small Model for Code Summarization

### Recommended: Ollama + qwen2.5-coder:1.5b

- **Model:** Qwen2.5-Coder 1.5B (Q4_K_M quantized)
- **Size:** 986 MB download
- **Runtime:** Ollama with Metal acceleration on Apple Silicon
- **npm client:** `ollama-js` (https://github.com/ollama/ollama-js) -- async/await TypeScript API
- **Tokens:** Zero cloud API calls. Runs entirely on-device.
- **Use case:** Method-level and function-level natural language summaries during indexing

### Alternatives

| Model | Size | Quality | Notes |
|-------|------|---------|-------|
| qwen2.5-coder:1.5b | 986 MB | Good for code tasks | Recommended starting point |
| qwen2.5-coder:3b | 1.93 GB | Better quality | If machine has 32GB+ |
| deepseek-coder:1.3b | ~800 MB | Comparable | Smaller alternative |

### Integration Pattern

```
Index pipeline:
  1. Parse with tree-sitter (free)
  2. Extract structural signatures with ts-morph (free)
  3. Generate template descriptions from AST (free, tier 1)
  4. Infer from naming/folder conventions (free, tier 2)
  5. Summarize with local model via ollama-js (free, tier 3)
  6. Flag items needing Sonnet for higher-level synthesis (tier 4)
  7. Batch Sonnet calls for tier 4 items only
```

---

## What SBOMs Do and Don't Cover

**SPDX** (Linux Foundation) and **CycloneDX** (OWASP/Ecma-424) describe:
- Component identities (package name, version, license)
- Dependency relationships
- Known vulnerabilities (via VEX)

They do NOT describe:
- First-party code structure
- Function/method signatures
- Internal service relationships
- Configuration constraints
- Log statement analysis

SBOMs are useful for the dependency graph layer of the analyzer but contribute nothing to the diagnostic protocol for proprietary first-party logic analysis.

---

## Privacy-Preserving Analysis: State of the Art

### What Exists (production-ready)

- **SARIF with snippet omission**: Logical locations only, no source code. Production standard.
- **Software metrics**: Coupling, cohesion, cyclomatic complexity, fan-in/fan-out. ISO/IEC 25023. Structural properties without code.
- **Architectural pattern classification**: Adapter, facade, observer, etc. Named patterns without implementation details.

### What Exists (academic)

- **Abstract non-interference** (ACM TPAS 2018): Formal framework for proving information does not flow from private to observable data via abstractions. Provides theoretical vocabulary but no deployable tool.
- **Privacy-preserving redaction via data flow analysis** (arXiv:2409.17535, SSDBM 2023): Uses data flow graph to identify which diagnostic outputs originate from sensitive sources, applies targeted redaction. Implemented but research-grade.
- **Federated code intelligence / differential privacy for code**: No production system exists. Techniques from healthcare/IoT DP literature could theoretically apply but none have been validated for code analysis.

### Practical Approach

Engineering convention, not formal proof:
1. SARIF output with snippets omitted
2. Logical locations (class/method names, structural nesting) only
3. Statistical aggregates (counts, distributions, pattern frequencies)
4. Named pattern classifications
5. Schema shapes without values
6. Anonymized relationship graphs (hashed service names if needed)

This is defensible for the use case (iterating with Opus on analyzer design) even though it lacks a cryptographic guarantee of non-reconstruction.

---

## Sources

- [SARIF v2.1.0 OASIS Standard](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
- [OASIS SARIF Technical Committee](https://www.oasis-open.org/committees/tc_home.php?wg_abbrev=sarif)
- [oasis-tcs/sarif-spec GitHub](https://github.com/oasis-tcs/sarif-spec)
- [CodeQL SARIF output - GitHub Docs](https://docs.github.com/en/code-security/codeql-cli/using-the-advanced-functionality-of-the-codeql-cli/sarif-output)
- [Distilled GPT for Source Code Summarization - arXiv](https://arxiv.org/abs/2308.14731)
- [Distilled GPT for Source Code Summarization - Springer](https://link.springer.com/article/10.1007/s10515-024-00421-4)
- [ollama/ollama-js - GitHub](https://github.com/ollama/ollama-js)
- [qwen2.5-coder - Ollama library](https://ollama.com/library/qwen2.5-coder)
- [@huggingface/transformers - npm](https://www.npmjs.com/package/@huggingface/transformers)
- [CycloneDX specification](https://cyclonedx.org/)
- [Privacy-Preserving Redaction via Source Code Analysis - arXiv](https://arxiv.org/abs/2409.17535)
- [Abstract Non-Interference - ACM](https://dl.acm.org/doi/10.1145/3175660)
- [Cousot POPL 1977 - Abstract Interpretation](https://www.di.ens.fr/~cousot/COUSOTpapers/POPL77.shtml)
