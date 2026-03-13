# Software Architecture Recovery and Reconstruction from Source Code: Evidence-Based Research Findings

## 1. Foundational Work

### Symphony (van Deursen, Hofmeister, Koschke, Moonen, Riva, 2004)

**Paper:** "Symphony: View-Driven Software Architecture Reconstruction," IEEE/IFIP Working Conference on Software Architecture (WICSA), 2004, pp. 122-132.

Symphony established the first structured process for architecture reconstruction organized around architectural views. The key contribution is a view-driven process that addresses the gap between having many techniques for recovering individual views but no guidance on selecting views or managing the reconstruction process. Symphony defines a common framework for reporting reconstruction experiences and comparing approaches. The process is problem-driven and iterative: you choose which views to reconstruct based on what questions need answering, not based on what is technically easiest to extract.

**Validation:** Applied to multiple industrial case studies. Its primary value is as a process framework, not as a specific technique. [Source](https://ieeexplore.ieee.org/document/1310696/)

### Reflexion Models (Murphy, Notkin, Sullivan, 1995)

**Paper:** "Software Reflexion Models: Bridging the Gap between Source and High-Level Models," 3rd ACM SIGSOFT Symposium on Foundations of Software Engineering, 1995.

Reflexion models work by having an engineer define a hypothesized high-level model and a mapping from that model to source code elements. A tool then computes where the model agrees with, diverges from, or is absent from the actual source. The technique explicitly exploits architectural drift rather than trying to eliminate it. The output shows convergences (model matches source), divergences (source has relations the model doesn't), and absences (model claims relations the source doesn't support).

**Key finding:** This top-down, human-in-the-loop approach produces more actionable results than fully automated bottom-up techniques because it leverages domain knowledge from the start. It remains one of the most widely used techniques in industrial practice. [Source](https://www.cs.ubc.ca/~murphy/papers/rm/fse95.html)

### ARCADE (Laser, Medvidovic et al., 2020)

**Paper:** "ARCADE: An Extensible Workbench for Architecture Recovery, Change, and Decay Evaluation," ESEC/FSE 2020.

ARCADE is a workbench that integrates multiple recovery techniques (ACDC, Bunch, WCA, LIMBO, ARC, and others), architectural smell detection, and architectural change/decay metrics. It has been deployed in research labs and three large companies over a decade. ARCADE enables comparative evaluation of recovery techniques on the same codebase and tracks architectural evolution across versions. [Source](https://dl.acm.org/doi/10.1145/3368089.3417941)

### Garcia, Ivkovic, Medvidovic (2013): Comparative Analysis

**Paper:** "A Comparative Analysis of Software Architecture Recovery Techniques," ASE 2013.

This is arguably the most important empirical finding in the field: **all six recovery techniques tested performed poorly, with average accuracy below 20% for cluster matches against carefully verified ground-truth architectures.** Even the best-performing techniques had surprisingly low accuracy. This paper established that no existing general-purpose automated recovery technique produces reliable results without human intervention. [Source](https://ieeexplore.ieee.org/document/6693106/)

### Ducasse and Pollet (2009): Process-Oriented Taxonomy

**Paper:** "Software Architecture Reconstruction: A Process-Oriented Taxonomy," IEEE Transactions on Software Engineering, vol. 35, pp. 573-591, 2009.

This taxonomy classifies SAR approaches along five axes: goals, process, inputs, techniques, and outputs. It identifies three process types:

- **Bottom-up:** Extract views from source code, then refine upward.
- **Top-down:** Define a hypothesized architecture, check against code, refine.
- **Hybrid:** Combine both directions.

**Key finding:** Most SAR approaches rely on source code and human expertise as primary inputs. The paper documents that no approach works without human involvement at some stage -- purely automated bottom-up recovery produces unreliable results. [Source](https://ieeexplore.ieee.org/document/4815276/)

### Koschke (2008): Architecture Reconstruction Survey

**Paper:** "Architecture Reconstruction," in Software Engineering (Lecture Notes), Springer, 2008.

Koschke's survey relates reconstruction techniques to the viewpoints proposed in architecture design, identifying gaps where available techniques do not cover important architectural concerns. He emphasizes the need to combine clustering techniques and integrate human oversight as a conformance supervisor. [Source](https://link.springer.com/chapter/10.1007/978-3-540-95888-8_6)

---

## 2. Static Analysis for Architecture Recovery

### What Works

**Dependency extraction** is the foundation. Three main types of dependencies are used:

- **Include/import dependencies:** Easy to extract but miss many important semantic dependencies.
- **Symbol dependencies:** Extracted from compiled code (e.g., via LLVM IR); significantly more accurate.
- **Call graph dependencies:** More precise but harder to extract and language-specific.

### Lutellier, Chollak, Garcia, Medvidovic et al. (2015, 2018)

**Papers:**
- "Comparing Software Architecture Recovery Techniques Using Accurate Dependencies," ICSE 2015.
- "Measuring the Impact of Code Dependencies on Software Architecture Recovery Techniques," IEEE TSE, 2018.

These two papers evaluated nine recovery techniques (ACDC, Bunch-NAHC, Bunch-SAHC, WCA-UE, WCA-UENM, LIMBO, ARC, ZBR, and others) and found:

- **Average MoJoFM scores ranged from 38% to 59%** -- none achieved high accuracy.
- **ACDC consistently outperformed** other techniques and was the most scalable (70-120 minutes on Chromium).
- **Symbol dependencies significantly improved recovery quality** compared to include dependencies.
- **Scalability varied dramatically:** WCA variants took 8-14 hours, Bunch-NAHC took 20-24 hours, and LIMBO ran out of memory (40+ GB RAM) on some configurations.
- **ZBR ran out of memory** on large projects entirely.
- **Non-deterministic techniques** (like Bunch's hill-climbing) produced inconsistent results across runs.

[Source: ICSE 2015](https://www.cs.purdue.edu/homes/lintan/publications/archrec-icse15.pdf) | [Source: TSE 2018](https://ieeexplore.ieee.org/document/7859416/)

### AST-Based Analysis

AST traversal identifies system components and their interconnections. It is the baseline technique for most tools. **Known limitation:** Vanilla AST representation introduces information redundancy, leading to performance degradation and excessive time costs at scale. More effective approaches compile source to intermediate representations (e.g., LLVM IR) and extract symbol dependencies from there.

### Call Graph Extraction

Sound and complete call graph construction is undecidable in general. Practical tools use approximations (CHA, RTA, VTA), each with different precision/recall tradeoffs. Dynamic binding (virtual dispatch, reflection, dependency injection) makes static call graphs incomplete by definition.

### Data Flow Analysis

Inter-procedural data flow analysis does not scale well to millions of lines of code. It is most useful for targeted analysis within bounded scopes, not for whole-system architecture recovery.

### SARIF: Information Fusion Approach (Zhang, Xu et al., 2023)

**Paper:** "Software Architecture Recovery with Information Fusion," ESEC/FSE 2023.

SARIF fuses three information sources: dependencies, code text (identifiers, comments), and folder structure. It adaptively weights each source based on its relevance and quality for a given system. **SARIF achieved 36.1% higher accuracy than the best previous technique on average**, evaluated against nine state-of-the-art techniques on nine projects (six with published ground truths, three labeled by industrial collaborators). This is the current state of the art for monolithic system recovery. [Source](https://dl.acm.org/doi/10.1145/3611643.3616285)

---

## 3. Microservice-Specific Recovery (2020-2025)

### MicroART (Di Francesco et al., 2017)

**Paper:** "MicroART: A Software Architecture Recovery Tool for Maintaining Microservice-Based Systems," ICSA 2017.

The first dedicated microservice recovery tool. It uses model-driven engineering to extract service information from source code repositories and performs runtime log analysis to discover containers, network interfaces, and service interactions. It is semi-automatic -- the architect must manually identify service discovery services. [Source](https://ieeexplore.ieee.org/document/7958510/)

### MiSAR (2023)

**Paper:** "MiSAR: The MicroService Architecture Recovery Toolset," 2023.

Extends MicroART using model-driven architecture. MiSAR automatically recovers the architectural model from the platform-specific model with no human input (unlike MicroART, which requires identifying service discovery services). Generates UML-like representations. [Source](https://www.researchgate.net/publication/372907824_MiSARThe_MicroService_Architecture_Recovery_Toolset)

### Intra-Service / Inter-Service Feature Model (2023)

**Paper:** "Microservice architecture recovery based on intra-service and inter-service features," Journal of Systems and Software, 2023.

Parses source code to build a fine-grained dependency graph (SSLDG), distinguishing between design-time and runtime relationships. Recovers six key information components: modules, components, services, and their dependencies and interfaces. **Achieved MoJoSim score of 94% vs. 82% for DDPR**, a substantial improvement. This is among the highest accuracy reported for microservice recovery from source code. [Source](https://www.sciencedirect.com/science/article/abs/pii/S0164121223001498)

### Static Analysis Tool Comparison (Springer EMSE, 2024/2025)

**Paper:** "Comparison of Static Analysis Architecture Recovery Tools for Microservice Applications," Empirical Software Engineering, 2025 (registered report at MSR 2024).

Compared nine tools (Code2DFD, MicroDepGraph, MicroGraal, microMiner, Prophet, RAD, RAD-source, ContextMap, Attack Graph Generator) on a common benchmark dataset. Key findings:

| Tool | Components F1 | Connections F1 |
|------|--------------|----------------|
| **Code2DFD** | **0.98** | **0.87** |
| MicroDepGraph | 0.87 | 0.67 |
| Attack Graph Generator | 0.80 | 0.54 |
| microMiner | 0.71 | N/A |
| Prophet | 0.23 | N/A |
| MicroGraal | N/A | 0.00 |
| RAD/RAD-source | N/A | 0.00 |
| ContextMap | N/A | 0.00 |

**Critical findings:**
- Three tools detected zero connections despite proper execution.
- A four-tool combination achieved F1 of 0.91, exceeding the best individual tool (0.86).
- Existing tools' reproducibility is limited -- significant obstacles encountered in running tools despite documentation.
- REST endpoint detection remains weak: Code2DFD achieved only 0.54 recall for REST endpoints.
- All tools were tested on Java/Spring Boot systems; polyglot systems remain an open problem.

[Source](https://link.springer.com/article/10.1007/s10664-025-10686-2)

### Microservice-Aware Static Analysis: Gaps (Dagstuhl, 2022)

**Paper:** "Microservice-Aware Static Analysis: Opportunities, Gaps, and Advancements," OASIcs, Schloss Dagstuhl, 2022.

Identified fundamental challenges:
- **Polyglot challenge:** Services in different languages (Python, Go, Java, PHP) require separate parsers and analysis frameworks.
- **Dynamic dispatch patterns:** Service discovery, load balancing, and API gateways create indirection that static analysis cannot resolve.
- **Configuration-driven architecture:** Kubernetes manifests, Docker Compose files, and infrastructure-as-code define architecture outside the application source.
- **Current tools prioritize dynamic analysis** due to polyglot challenges but dynamic analysis can only provide a black-box perspective.

[Source](https://drops.dagstuhl.de/entities/document/10.4230/OASIcs.Microservices.2020-2022.2)

### MiSAR Model-Driven Recovery (2025)

**Paper:** "A model-driven architecture approach for recovering microservice architectures: Defining and evaluating MiSAR," Information and Software Technology, 2025.

Extends the MDA approach to microservice recovery with formal model transformations. Evaluated on empirical systems with precision, recall, and F-measure metrics. [Source](https://www.sciencedirect.com/science/article/pii/S0950584925001478)

---

## 4. Feature Location / Concept Location

### Eisenbarth, Koschke, Simon (2001, 2003)

**Paper:** "Locating Features in Source Code," IEEE TSE, 2003.

Pioneered the use of formal concept analysis on execution traces to map features to code. The technique derives feature-component correspondence from dynamic information. This remains foundational -- most subsequent dynamic feature location techniques build on this work. [Source](https://ieeexplore.ieee.org/document/921740/)

### SNIAFL (Zhao, Zhang, Liu, Yang, 2004/2006)

**Paper:** "SNIAFL: Towards a Static Non-Interactive Approach to Feature Location," ACM TOSEM, vol. 15, no. 2, 2006.

A purely static approach using information retrieval to reveal initial connections between features and code, then a branch-reserving call graph (BRCG) to refine results. Two-phase approach: (1) IR to identify initial feature-element mappings from lexical descriptions, (2) call graph exploration to recover relevant and specific computational units. [Source](https://dl.acm.org/doi/10.1145/1131421.1131424)

### FLAT3 (Feature Location and Textual Tracing Tool)

Presented at ICSE 2010. Combines textual analysis with tracing capabilities for interactive feature location.

### Poshyvanyk et al. (2007): PROMESIR

**Paper:** "Feature Location Using Probabilistic Ranking of Methods Based on Execution Scenarios and Information Retrieval," IEEE TSE, 2007.

Combined execution traces with LSI-based information retrieval. PROMESIR outperformed either SPR or LSI alone. Case studies showed significant improvement by combining expert judgments with IR results. [Source](https://ieeexplore.ieee.org/document/1374321/)

### Dit, Revelle, Gethers, Poshyvanyk (2013): Comprehensive Survey

**Paper:** "Feature location in source code: a taxonomy and survey," Journal of Software: Evolution and Process, 2013.

Classified 89 feature location articles along nine dimensions. Key findings:
- **Static techniques** (IR-based): Lower precision but no execution overhead. LSI and LDA are most common.
- **Dynamic techniques** (trace-based): Higher precision but require executable scenarios and suffer from trace explosion.
- **Hybrid techniques** (combining static + dynamic): Generally outperform either alone.
- **LDA vs. LSI:** Results are mixed. LDA outperforms LSI by 16% on interpreted models but LSI outperforms LDA by 7% on code-generated models. Neither is universally superior.
- **All IR-based approaches** suffer from vocabulary mismatch: identifier names must correlate with feature descriptions for the technique to work.

[Source](https://onlinelibrary.wiley.com/doi/full/10.1002/smr.567)

### Liu, Marcus, Poshyvanyk, Rajlich (2007)

**Paper:** "Feature Location via Information Retrieval Based Filtering of a Single Scenario Execution Trace," ASE 2007.

Showed that filtering a single execution trace with IR significantly reduces the search space. [Source](https://www.cs.wm.edu/~denys/pubs/LiuMarPosRaj.SITIR.ASE07.pdf)

### How Well They Work at Scale

- IR-based techniques (LSI, LDA) scale to large codebases in terms of computation but their **precision degrades** as corpus size increases because more false positives appear.
- Dynamic techniques do not scale well because trace collection for large systems produces enormous data volumes.
- No feature location technique has been validated on systems with hundreds of microservices.

---

## 5. Program Comprehension at Scale

### Xia, Bao, Lo et al. (2017/2018): Large-Scale Field Study

**Paper:** "Measuring Program Comprehension: A Large-Scale Field Study with Professionals," IEEE TSE, 2017 (also ICSE 2018).

Collected 3,148 working hours from 78 professional developers. Key findings:
- **Developers spend approximately 58% of their time on program comprehension activities.**
- Developers frequently use web browsers and document editors (not just IDEs) for comprehension.
- Programming language, experience level, and project phase all significantly affect comprehension time.

This is the largest field study on program comprehension to date and provides strong empirical evidence that comprehension dominates development effort. [Source](https://ieeexplore.ieee.org/document/7997917/)

### Sillito, Murphy, De Volder (2006/2008): Questions Programmers Ask

**Papers:**
- "Questions Programmers Ask During Software Evolution Tasks," SIGSOFT/FSE 2006.
- "Asking and Answering Questions during a Programming Change Task," IEEE TSE, vol. 34, pp. 434-451, 2008.

Identified a catalog of **44 types of questions** programmers ask during software evolution tasks. Studied both newcomers and experienced industrial programmers. Found that existing tools poorly support many of these question types, particularly questions about cross-cutting concerns, control flow across modules, and architectural rationale. [Source](https://dl.acm.org/doi/10.1145/1181775.1181779)

### Cognitive Models

Pennington (1987) established the cognitive process model for program comprehension, identifying that programmers use both top-down (hypothesis-driven) and bottom-up (reading-driven) strategies. Mental models include both static structure and dynamic behavior representations at multiple abstraction levels.

### What the Research Says About Hundreds of Services

There is **no published empirical study** that has validated automated program comprehension techniques on systems with hundreds of microservices. The closest work is on large monolithic systems (Chromium, ITK, OpenJDK), where scalability limits are already evident:

- Clustering techniques run out of memory or take days on systems with tens of thousands of files.
- Static analysis tools for microservices have only been tested on benchmark suites with 5-20 services.
- The Dagstuhl 2022 paper explicitly identifies that scaling static analysis to large cloud-native systems remains an unsolved problem.

### LLM-Based Approaches (Emerging, 2024-2025)

**ArchAgent (2025):**
Combines static analysis with LLM-powered synthesis. Uses adaptive grouping (partitioning repositories by token count with 10% overlap) and contextual pruning to handle context window limitations. Achieved F1 of 0.966 vs. 0.860 for DeepWiki on 8 large GitHub projects. Successfully recovered business-critical modules from a 621-file Java system. **Limitations:** Potential LLM hallucinations, sensitivity to entry point identification, reliance on documentation quality. [Source](https://arxiv.org/abs/2601.13007)

**Architecture Traceability (Fuchss et al., 2025):**
GPT-4o achieves weighted average F1-score of 0.86 in recovering trace links between architecture descriptions and code. [Source](https://fuchss.org/assets/pdf/2025/icsa-25.pdf)

**MDRE-LLM:**
Uses RAG to ground LLM outputs in actual source code, mitigating hallucination. [Source](https://figshare.le.ac.uk/ndownloader/files/51598856)

---

## 6. Applicable Standards

### ISO/IEC/IEEE 42010:2022 (Architecture Description)

Successor to IEEE 1471:2000 and ISO/IEC 42010:2007. Defines requirements for architecture descriptions of systems and software.

**Key constraints for recovery work:**
- Architecture descriptions must identify **stakeholders** and their **concerns**.
- Each concern must be addressed by one or more **architecture views**.
- Each view conforms to an **architecture viewpoint** (which defines the conventions for that type of view).
- The standard distinguishes between an **architecture** (the fundamental concepts or properties of an entity) and an **architecture description** (the work product expressing that architecture).
- Any recovered architecture should be expressible in terms of views, viewpoints, and stakeholder concerns to conform to this standard.

**Implication for recovery:** Recovery tools should produce outputs that can be organized into views addressing specific stakeholder concerns, not just flat dependency graphs. [Source](https://www.iso.org/standard/50508.html)

### ISO/IEC 25010:2023 (Product Quality Model)

Defines eight quality characteristics. The most relevant to architecture recovery are:

- **Maintainability** -- with sub-characteristics:
  - **Analysability:** Effectiveness of assessing impact of intended changes and diagnosing deficiencies. This is the quality attribute that architecture recovery directly supports.
  - **Modularity:** Degree to which components can be altered with minimal impact on others.
  - **Modifiability:** Ease of modification without introducing defects.
  - **Testability:** Effectiveness of establishing test criteria.
- **Reliability** and **Security** also benefit from recovered architecture understanding.

**Implication for recovery:** Recovery outputs should be validated against their ability to improve analysability -- specifically, whether they help developers correctly assess change impact. [Source](https://www.iso.org/standard/35733.html)

### ISO/IEC/IEEE 42030 (Architecture Evaluation)

Provides guidance on architecture evaluation, relevant for validating whether recovered architectures are accurate and useful.

---

## 7. What DOESN'T Work

### Fully Automated Bottom-Up Recovery

**Evidence:** Garcia et al. (2013) showed all six automated techniques achieved below 20% accuracy against ground truth. Lutellier et al. (2018) found MoJoFM scores of 38-59% even with improved dependency inputs. The design choices underlying most recovery methods mean none have a complete set of desirable qualities. [Source](https://ieeexplore.ieee.org/document/6693106/)

### Non-Deterministic Clustering

**Evidence:** Bunch's hill-climbing algorithms (NAHC, SAHC) use random initial partitions and may converge on different local optima across runs. Lutellier et al. (2018) specifically noted that "inconsistent results do not lend themselves well to tracking a system's course over several versions." This is a fundamental problem for any process that needs repeatable results.

### Include Dependencies as Primary Input

**Evidence:** Include dependencies miss many important semantic dependencies since non-header files are the main semantic components of a project. Symbol dependencies extracted from compiled code substantially improve recovery quality (Lutellier et al., 2015/2018).

### Single-Technique Recovery for Complex Systems

**Evidence:** SARIF (Zhang et al., 2023) demonstrated that combining three information sources (dependencies, code text, folder structure) outperforms any single-source technique by 36%. The microservice tool comparison (2024/2025) showed that combining four tools achieved F1 of 0.91 vs. 0.86 for the best individual tool.

### Techniques That Don't Scale

- **LIMBO:** Runs out of memory (40+ GB RAM) on large C/C++ projects.
- **ZBR:** Runs out of memory entirely on large projects.
- **Bunch-NAHC:** Takes 20-24 hours on Chromium-scale projects.
- **Inter-procedural data flow analysis:** Does not scale to millions of lines of code.
- **Dynamic trace-based feature location:** Trace explosion on large systems makes analysis impractical.

### Ignoring Input Quality

**Evidence:** Lutellier et al. (2018) found that "previous studies have not seriously considered how the quality of the input might affect the quality of the output." Using inaccurate dependencies (e.g., include-only) causes all downstream recovery techniques to produce worse results regardless of their algorithmic quality.

### Language-Specific Tool Assumptions

**Evidence:** The microservice tool comparison (2024/2025) found that all available tools target Java/Spring Boot. Polyglot systems -- the norm in microservice environments -- have no validated tooling. The Dagstuhl 2022 paper identifies this as a fundamental gap.

### Treating Recovery as a One-Time Activity

**Evidence:** Li et al. (2022) documented in a systematic mapping study that architecture erosion threatens projects through violations, structural degradation, quality deterioration, and evolutionary drift. Nearly 100 architectural erosion metrics were identified. Recovery must be continuous, not one-shot. [Source](https://onlinelibrary.wiley.com/doi/10.1002/smr.2423)

### Runtime Verification Without Static Foundation

**Evidence:** Service mesh observability and distributed tracing provide black-box perspectives only. They reveal runtime dependencies and latencies but cannot recover design intent, component boundaries, or architectural rationale. They are complementary to static analysis, not replacements.

---

## Summary of Key Takeaways

1. **No automated technique works reliably alone.** The best empirical evidence (Garcia 2013, Lutellier 2018) shows automated recovery accuracy tops out at ~60% MoJoFM without human involvement.

2. **Information fusion is the current frontier.** SARIF (2023) demonstrated 36% improvement by combining dependencies, text, and structure. Tool combinations in microservice recovery achieve higher F1 than any individual tool.

3. **Human-in-the-loop approaches (Reflexion Models) remain the most industrially validated.** They trade automation for accuracy by leveraging domain expertise.

4. **Microservice recovery is immature but advancing rapidly.** Code2DFD (0.98 component F1) and the intra/inter-service approach (94% MoJoSim) show promising results on benchmark systems, but validation on large-scale production systems is absent.

5. **LLM-based recovery is emerging (2025) with promising but unvalidated results.** ArchAgent and similar tools show high F1 on GitHub projects but face hallucination risks and have not been tested on proprietary, large-scale systems.

6. **Input quality matters as much as technique quality.** Symbol dependencies over include dependencies, accurate call graphs over approximated ones.

7. **Standards (ISO 42010, ISO 25010) provide the framework** for organizing recovered architecture into stakeholder-relevant views and validating whether recovery improves analysability.

8. **Scale remains the fundamental unsolved problem.** No technique has been empirically validated on systems with hundreds of services and millions of lines of polyglot code.
