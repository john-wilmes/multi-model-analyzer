# Software Fault Tree Analysis (SFTA): Deep Research Report

## 1. Software Fault Tree Analysis Foundations

### Original Work: Leveson & Harvey (1983)

The foundational work on Software Fault Tree Analysis was published in two papers:

- **Leveson, N.G. & Harvey, P.R.** (1983). "Software Fault Tree Analysis." *Journal of Systems and Software*, Vol. 3, pp. 173-181.
- **Leveson, N.G. & Harvey, P.R.** (1983). "Analyzing Software Safety." *IEEE Transactions on Software Engineering*, Vol. 9, No. 5, pp. 569-579.

**Core methodology**: SFTA adapts traditional hardware FTA to software by treating any incorrect software output as the undesired top-level event, then starting from the instructions that produce those outputs and **tracing backward** through all instructions that contribute to them. This generates a hierarchical structure representable as a fault tree. Language constructs (if-statements, while-loops, assignments) are transformed into templates using preconditions, postconditions, and logical connectives (AND/OR gates).

**Key adaptation from hardware FTA**: Traditional FTA models component failures with probabilistic independence. Software does not "fail" randomly -- it fails deterministically given specific inputs and states. Leveson's adaptation therefore focuses on **logic faults** (incorrect conditions, wrong variable assignments, missing guards) rather than stochastic failure rates.

### IEC 61025: Fault Tree Analysis Standard

[IEC 61025:2006](https://webstore.iec.ch/en/publication/4311) (Edition 2.0) is the cross-industry international standard for fault tree analysis. It covers:

- Definition of terms and symbols (AND, OR, inhibit gates, basic events, undeveloped events)
- Purpose, applications, and **limitations** of fault trees
- Steps for scoping, constructing, and developing fault trees
- Qualitative analysis (minimal cut sets) and quantitative analysis (unavailability, failure frequency, unreliability)
- Procedures for constant and time-dependent probabilities, repaired and non-repaired faults

**Applicability to software**: IEC 61025 is domain-agnostic -- it provides the formal framework but does not prescribe software-specific templates. Software applications of FTA must supplement IEC 61025 with domain-specific guidance such as NASA's SFTA methodology or the State/Event Fault Tree extensions (discussed below).

### NASA/Aerospace Applications

NASA has been a primary driver of SFTA adoption, documented in several key resources:

1. **NASA Fault Tree Handbook with Aerospace Applications** (Version 1.1, 2002), by Stamatelatos et al. A comprehensive handbook covering FTA principles, construction methods, and aerospace case studies. Available at: [NASA FTA Handbook PDF](https://www.mwftr.com/CS2/Fault%20Tree%20Handbook_NASA.pdf)

2. **[NASA Software Engineering Handbook, Section 8.07](https://swehb.nasa.gov/display/SWEHBVD/8.07+-+Software+Fault+Tree+Analysis)**: Codifies the SFTA process for NASA software projects. Key points:
   - SFTA must be preceded by a preliminary hazard analysis
   - The top event is a known system hazard, not an arbitrary software bug
   - Code is traced backward from output statements to input statements
   - Language construct templates (if, while, assignment) formalize the decomposition
   - SFTA makes **no claim** about software reliability -- it identifies specific logic conditions under which hazards can occur
   - It complements, not replaces, testing
   - A Canadian nuclear power plant shutdown system (6,000 lines) was analyzed via SFTA in 3 work-months; full functional verification of the same code took 30 work-years

3. **DO-178C** (RTCA): The principal certification standard for commercial airborne software. While DO-178C itself does not mandate FTA directly at the software level, it operates within a system safety framework where **ARP4761** provides guidelines for conducting FTA and FMEA at the system level, which then flow down as software requirements.

---

## 2. Log-Based Fault Analysis

### Foundational Work: Xu et al. (2009)

**Xu, W., Huang, L., Fox, A., Patterson, D., & Jordan, M.I.** (2009). "Detecting Large-Scale System Problems by Mining Console Logs." *Proceedings of the ACM SIGOPS 22nd Symposium on Operating Systems Principles (SOSP '09)*, pp. 117-132. [PDF available](https://www.sigops.org/s/conferences/sosp/2009/papers/xu-sosp09.pdf)

**Key contribution**: Proposed a general framework combining program analysis, information retrieval, and machine learning to build a fully automatic problem detection system from console logs. Used PCA (Principal Component Analysis) on log-derived feature matrices to detect anomalies. This was the first work to apply PCA systematically to console log mining for system problem detection.

### He, Zhu et al. -- Log Analysis Research Group

This group at the Chinese University of Hong Kong has produced the most extensive body of work on automated log analysis:

- **He, S., Zhu, J., He, P., & Lyu, M.R.** (2016). "[Experience Report: System Log Analysis for Anomaly Detection](https://jiemingzhu.github.io/pub/slhe_issre2016.pdf)." *IEEE International Symposium on Software Reliability Engineering (ISSRE)*. Evaluated 6 state-of-the-art log-based anomaly detection methods (3 supervised, 3 unsupervised) on real-world datasets.

- **He, S., He, P., Chen, Z., Yang, T., Su, Y., & Lyu, M.R.** (2021). "[A Survey on Automated Log Analysis for Reliability Engineering](https://netman.aiops.org/~peidan/ANM2023/6.LogAnomalyDetection/A%20Survey%20on%20Automated%20Log%20Analysis%20for%20Reliability%20Engineering.pdf)." *ACM Computing Surveys*. The most comprehensive survey of the field covering log collection, parsing, analysis, and anomaly detection.

- **Zhu, J., He, S., et al.** (2023). "[Loghub: A Large Collection of System Log Datasets for AI-driven Log Analytics](https://www.semanticscholar.org/paper/Loghub:-A-Large-Collection-of-System-Log-Datasets-Zhu-He/c3bdc6149097fa186a17d07cff6ce210d468bdf3)." *ISSRE 2023*. Provides 19 real-world log datasets from distributed systems, supercomputers, operating systems, and mobile systems.

- **Zhu, J., He, S., et al.** (2019). "Tools and Benchmarks for Automated Log Parsing." *ICSE-SEIP 2019*. Benchmarked 13 automated log parsers.

### Log Parsing Techniques

**Drain** (He, P., Zhu, J., et al., 2017): An online log parsing approach using a fixed-depth tree structure to match token-aligned logs. It is one of the most widely adopted log parsers. Open-source implementation: [Drain3 on GitHub](https://github.com/logpai/Drain3).

### Deep Learning for Log Anomaly Detection

- **DeepLog** (Du, M., Li, F., Zheng, G., & Srikumar, V., 2017): "DeepLog: Anomaly Detection and Diagnosis from System Logs Using Deep Learning." *CCS 2017*. Models log event sequences using LSTM networks; treats the sequence of log keys as a natural language sequence.

- **LogAnomaly** (Meng, W., et al., 2019): Uses log count vectors with synonym/antonym-based word embeddings to detect anomalies without requiring labeled data.

**Critical empirical finding**: Log parsing quality significantly impacts anomaly detection accuracy. A 2024 study in [Empirical Software Engineering](https://link.springer.com/article/10.1007/s10664-024-10533-w) found that the choice of log parser materially affects downstream deep-learning-based anomaly detection results.

### Using Log Statements as Failure Mode Indicators

Log statements in source code are not merely debugging aids -- they encode developer knowledge about failure modes. Each `log.error()` or `log.warn()` call represents a condition the developer considered anomalous. Static analysis of log statement placement, message content, and surrounding control flow can identify:

- **Error handling paths** that are never tested
- **Catch blocks** that swallow exceptions silently
- **Inconsistent error reporting** across similar code paths
- **Missing error handling** where similar patterns elsewhere include it

---

## 3. Static Analysis for Fault Localization

### Spectrum-Based Fault Localization (SBFL)

SBFL is the most extensively studied family of automated fault localization techniques.

**Core concept**: Collect "program spectra" -- records of which code elements execute during passing and failing test cases. Assign suspiciousness scores to each code element based on its correlation with test outcomes.

**Key formulas and papers**:

| Formula | Paper | Year | Key Finding |
|---------|-------|------|-------------|
| **Tarantula** | Jones, J.A., Harrold, M.J., & Stasko, J. "Visualization of test information to assist fault localization." *ICSE 2002* | 2002 | First visual SBFL technique; color-maps statement suspiciousness |
| **Ochiai** | [Abreu, R., Zoeteweij, P., & Van Gemund, A.J.](https://onlinelibrary.wiley.com/doi/10.1002/9781119880929.ch4) "On the accuracy of spectrum-based fault localization." *TAICPART-MUTATION 2007*, pp. 89-98 | 2007 | More accurate than Tarantula; became the de facto benchmark |
| **DStar (D\*)** | [Wong, W.E., Debroy, V., Gao, R., & Li, Y.](https://ieeexplore.ieee.org/abstract/document/6651713/) "The DStar Method for Effective Software Fault Localization." *IEEE Transactions on Reliability*, Vol. 63, pp. 290-308 | 2014 | Compared 16 techniques across 21 programs; DStar outperformed all |

**Empirical reality check**: An [empirical study](https://arxiv.org/pdf/1803.09939) found that DStar is better than Tarantula on **artificial faults** (mutants), but on **real faults** there is no significant difference between the two techniques. This is an important finding: artificial faults are not an adequate substitute for real faults when evaluating fault localization techniques.

**Fundamental limitation**: SBFL requires a test suite. Its effectiveness is directly proportional to test coverage quality. Without well-designed tests that actually exercise failure-inducing paths, SBFL produces inaccurate rankings.

### Program Slicing for Fault Analysis

**Weiser, M.** (1981). "Program Slicing." *Proceedings of the 5th International Conference on Software Engineering*, pp. 439-449.

This foundational paper introduced program slicing: extracting the subset of statements that can affect the value of a variable at a given program point. Two key variants:

- **Static backward slicing**: Identifies all statements that *may* affect the slicing criterion, without execution. Conservative (overapproximates).
- **Dynamic slicing**: Identifies statements that *did* affect the value in a specific execution. More precise but requires execution traces.

**Validated effectiveness**: [Soremekun, E.O., Kirschner, L., Bohme, M., & Zeller, A.](https://link.springer.com/article/10.1007/s10664-020-09931-7) (2021). "Locating Faults with Program Slicing: An Empirical Analysis." *Empirical Software Engineering*, Vol. 26.

Study of 457 bugs in 46 open-source C programs:
- **Dynamic slicing was 8 percentage points more effective** than the best SBFL formula for single faults
- For **66% of bugs**, dynamic slicing found the fault earlier than SBFL
- However, **SBFL performed better on multiple faults** (where slicing scope becomes too broad)

### Control Flow and Data Flow Analysis

Data flow analysis for fault detection operates by tracking def-use pairs (where variables are defined and where they are used). Static data-flow testing detects potential bugs through patterns of **data anomalies** without executing code:
- Variables defined but never used (dead stores)
- Variables used before definition (uninitialized reads)
- Variables redefined without intervening use (lost assignments)

These are well-validated and form the basis of warnings in tools like FindBugs, SonarQube, and compiler warnings.

---

## 4. Fault Trees from Code

### Automated/Semi-Automated Generation

This is the least mature area in the research. Most approaches generate fault trees from **design models**, not source code directly.

**Model-based approaches**:

1. **ArChes** (2021): [Arxiv 2105.15002](https://arxiv.org/abs/2105.15002). Automatically generates Component Fault Trees (CFTs) from Continuous Function Charts (CFCs). Creates a failure propagation model from the detailed software specification with no additional manual effort. The resulting CFT enables FTA of the overall system including software as a white box.

2. **SysML-based generation**: Research has represented SysML Internal Block Diagrams as directed graphs, using graph traversal and pattern recognition to automatically derive partial fault trees. These are assembled into complete fault trees with appropriate logic gates.

3. **AADL-based generation**: The EMFTA project (Carnegie Mellon SEI) aims to [automatically generate fault trees from AADL architecture models](https://www.sei.cmu.edu/blog/emfta-an-open-source-tool-for-fault-tree-analysis/).

4. **Formal specification-based**: Research on nuclear reactor protection systems developed [SFTA techniques for formal requirement specifications](https://www.sciencedirect.com/science/article/abs/pii/S0951832020305652), introducing software fault tree templates and redefined algorithms for minimal cut-set analysis.

**Code-level generation (limited)**:

Leveson's original technique IS a code-level approach: it defines templates for language constructs and builds fault trees by backward tracing through code. However, this has **not been fully automated** for modern programming languages at scale. The gap between this 1983 approach and modern polyglot, framework-heavy, asynchronous codebases is substantial.

### Software FMEA and Its Relationship to FTA

Software FMEA is a bottom-up complement to top-down SFTA. It evaluates each software function/requirement and identifies potential failures, effects, and causes with risk prioritization. [FMEA and FTA are complementary](https://asq.org/quality-resources/fmea): FMEA identifies failure modes at the component level; FTA traces how those modes propagate to system-level hazards. Some modern tools (e.g., ALD's SFMEA tool, Relyence) can automatically build FTA from FMEA data.

### Mapping Code Paths to Fault Tree Events

The practical approach (synthesized from literature):

1. **Identify top-level hazard** (system safety analysis output)
2. **Map hazard to software outputs** (which variables, return values, or state transitions could cause the hazard)
3. **Trace backward through control flow** from those outputs using Leveson's templates:
   - Assignment: incorrect value = wrong expression OR wrong precedent computation
   - If-statement: wrong branch taken = condition evaluates incorrectly (wrong variables OR wrong operator) OR correct branch has wrong logic
   - Loop: incorrect iteration count = wrong initialization OR wrong termination condition OR wrong increment
4. **Stop at**: input boundaries, hardware interfaces, or events already modeled elsewhere
5. **Identify minimal cut sets**: the smallest combinations of basic events that cause the top event

---

## 5. Root Cause Analysis Techniques

### Backward Slicing for Root Cause

Given an observed failure (e.g., a specific log line or crash), backward slicing from the failure point identifies all code that could have contributed. This is the most direct code-level RCA technique:

- **Static backward slicing**: Conservative; produces a superset of relevant code. Useful when no execution trace is available.
- **Dynamic backward slicing**: Precise for a specific execution. Identifies exactly which statements influenced the failure in that run.

### Taint Analysis

Backward taint analysis identifies the direct reason for a crash, then tracks the propagation of invalid data backward through the execution trace. Tainted instructions are ranked according to their behaviors. This is particularly effective for memory corruption, injection vulnerabilities, and data integrity failures.

### Causal Inference for Distributed Systems

**CausalRCA** (Wang et al., 2023). "[Causal inference based precise fine-grained root cause localization for microservice applications](https://www.sciencedirect.com/science/article/pii/S016412122300119X)." *Journal of Systems and Software*. Implements fine-grained, automated, real-time root cause localization using causal inference.

**Key finding from recent survey** ([Arxiv 2408.13729](https://arxiv.org/html/2408.13729v1)): Naive reliance on distributed tracing alone leads to spurious or incomplete conclusions. Causal inference tools help distinguish between true root causes and symptomatic side effects. Even with **partial** causal graphs, root causes can be identified with a linear number of invariance tests.

---

## 6. Microservice Failure Analysis

### Comprehensive Survey

**Li, Y., et al.** (2024). "[Failure Diagnosis in Microservice Systems: A Comprehensive Survey and Analysis](https://dl.acm.org/doi/10.1145/3715005)." *ACM Transactions on Software Engineering and Methodology*. Reviews 98 papers from 2003-2024, covering fundamental concepts, system architecture, and failure diagnosis methods.

### Cascading Failure Analysis

**Soldani, J., et al.** (2021-2025):
- "[What Went Wrong? Explaining Cascading Failures in Microservice-Based Applications](https://link.springer.com/chapter/10.1007/978-3-030-87568-8_9)." *ICSOC 2021*.
- "[yRCA: An explainable failure root cause analyser](https://www.sciencedirect.com/science/article/abs/pii/S0167642323000795)." *Science of Computer Programming*, 2023.
- "[Explaining Microservices' Cascading Failures From Their Logs](https://onlinelibrary.wiley.com/doi/full/10.1002/spe.3400)." *Software: Practice and Experience*, 2025.

yRCA is a prototype that declaratively determines cascading failures from application logs. It includes a logging methodology for instrumenting applications to capture failure and service interaction data. Controlled experiments assessed effectiveness using an existing chaos testbed.

### Saga Pattern Failures

**Garcia-Molina, H. & Salem, K.** (1987). "[Sagas](https://dl.acm.org/doi/10.1145/38713.38742)." *Proceedings of the 1987 ACM SIGMOD International Conference on Management of Data*, pp. 249-259.

The saga pattern addresses long-lived distributed transactions through compensating transactions. Key failure modes:
- **Isolation violations**: Saga lacks isolation; reading/writing from incomplete transactions is possible
- **Compensation failures**: If a compensating transaction itself fails, manual intervention is required
- **Debugging complexity**: Grows with the number of participating services
- **Non-reversible operations**: Some actions (sending emails, external API calls) cannot be compensated

Recent research ([Tsigkanos et al., 2022](https://www.mdpi.com/2076-3417/12/12/6242), MDPI Applied Sciences) proposes enhancements including idempotent compensation, timeout-based failure detection, and orchestration-level circuit breaking.

### Configuration-Induced Failures

**Yin, Z., Ma, X., et al.** (2011). "[An Empirical Study on Configuration Errors in Commercial and Open Source Systems](https://www.sigops.org/s/conferences/sosp/2011/current/2011-Cascais/printable/12-yin.pdf)." *SOSP 2011*.

Key statistics from studying MySQL, Apache HTTPD, OpenLDAP, and commercial systems:
- **70.0%-85.5%** of misconfigurations are parameter-setting mistakes
- **14.5%-30.0%** are caused by software compatibility issues
- **38.1%-53.7%** of parameter errors violate format or semantic rules (detectable by checkers)
- **12.2%-29.7%** are inconsistencies between different parameter values
- Configuration issues cause **31% of high-severity support requests**

A 2024 study ([Arxiv 2412.11121](https://arxiv.org/html/2412.11121)) reclassifies root causes as: constraint violation, resource unavailability, component-dependency error, and misunderstanding of configuration effects.

---

## 7. Applicable Standards

### Directly Applicable

| Standard | Domain | Relevance to SFTA |
|----------|--------|-------------------|
| **IEC 61025:2006** | Cross-industry | The foundational FTA standard. Defines symbols, gates, construction steps, qualitative/quantitative analysis. Does not prescribe software-specific methods but provides the formal framework. |
| **IEC 61508** | Generic functional safety | Parent standard for functional safety of E/E/PE systems. Part 3 covers software. Recommends FTA as a technique for software safety analysis at SIL 3 and SIL 4. |
| **ISO 26262** | Automotive | Adaptation of IEC 61508 for road vehicles. Mandates deductive analysis (including FTA) for ASIL C and ASIL D. Part 6 covers software; Part 9 covers ASIL-oriented analysis. |
| **DO-178C / ARP4761** | Avionics | DO-178C governs airborne software development. ARP4761 provides guidelines for safety assessments including FTA and FMEA at the system level. Results flow down as software requirements. |
| **IEC 62304:2015** | Medical devices | Software lifecycle processes for medical device software. Classifies software into safety classes A/B/C. Requires risk analysis per ISO 14971 (risk management for medical devices), which can include FTA. Does not mandate FTA specifically but recognizes it as an applicable technique. |

### Tangentially Applicable

| Standard | Domain | Relevance |
|----------|--------|-----------|
| **IEC 62443** | Industrial automation cybersecurity | Defines security levels (SL 1-4) for industrial control systems. Not a fault analysis standard per se, but its threat modeling and security assessment requirements can be supported by fault tree-style attack tree analysis. |
| **ISO 14971** | Medical device risk management | The risk management standard referenced by IEC 62304. FTA is listed as a recognized technique for hazard identification and risk analysis. |
| **IEC 60812** | Cross-industry | FMEA standard. Complementary to IEC 61025 (FTA). Bottom-up analysis that feeds into top-down fault trees. |

### Healthcare-Specific Standards

For healthcare software specifically:
- **IEC 62304** is the primary standard for medical device software lifecycle
- **ISO 14971** governs risk management for medical devices and explicitly recognizes FTA
- **FDA guidance** recognizes IEC 62304 and expects risk analysis including fault/failure analysis for Class II and Class III devices
- The combination of IEC 62304 (lifecycle) + ISO 14971 (risk management) + IEC 61025 (FTA methodology) provides a complete framework for healthcare software fault analysis

---

## 8. What DOESN'T Work: Known Limitations

### SFTA Scalability

- **State/path explosion**: For non-trivial software, the number of possible execution paths grows combinatorially. A function with N sequential if-statements has 2^N paths. Markov-based quantitative analysis methods [suffer from state-space explosion](https://www.researchgate.net/publication/336058830_Dynamic_Fault_Tree_Analysis_State-of-the-Art_in_Modelling_Analysis_and_Tools) when fault trees are large.
- **Manual effort**: Leveson's original code-tracing technique is fundamentally manual. The 3 work-month effort for 6,000 lines of nuclear shutdown code does not scale to modern systems with millions of lines.
- **Analyst dependency**: Results depend on the analyst's judgment about when to stop expanding, which hazards to analyze, and how to model environment interactions. Different analysts produce different fault trees.

### Static Analysis False Positive Problem

This is the single biggest validated limitation:

- In a **real-world dataset from Tencent**, the false positive rate of static analysis warnings was [higher than 90%](https://arxiv.org/html/2601.18844v1) (328 false positives out of 433 warnings in one study, with the rate increasing when incomplete code contexts are considered).
- An [empirical study of static analysis tools for security](https://arxiv.org/html/2407.12241v1) found that all tools had median recall values close to or **below 50%**, comparable to random guessing. At least 76% of warnings in vulnerable functions were irrelevant.
- Enterprise tools deliberately **prioritize recall over precision** to avoid missing real bugs, at the cost of overwhelming developers with false alarms.
- **This is a fundamental design tradeoff**: Overapproximated analyses detect nearly all errors but generate many false alarms; underapproximated analyses miss real bugs.

### SBFL Limitations

- **Requires test suites**: No tests = no spectrum = no localization. SBFL is useless without test infrastructure.
- **Test quality dependency**: Poorly designed tests produce inaccurate suspiciousness rankings. Test suites must cover both passing and failing behaviors across diverse inputs.
- **Artificial vs. real faults**: Studies show that **artificial faults (mutants) are not adequate substitutes for real faults** when evaluating SBFL techniques. Results that look good on mutation-based benchmarks may not transfer to real-world debugging.
- **Single fault assumption**: Most SBFL formulas assume a single fault. When multiple faults interact, SBFL effectiveness degrades.

### Program Slicing Limitations

- **Static slicing overapproximates**: For large programs, a static slice can include a large fraction of the codebase, reducing its usefulness.
- **Dynamic slicing requires execution**: Need a failing execution trace. Cannot be applied purely from source code without running the program.
- **Multiple faults**: Soremekun et al. (2021) showed that while dynamic slicing excels for single faults, it performs worse than SBFL for multiple concurrent faults.

### Log-Based Analysis Limitations

- **Log quality varies wildly**: Developer-written log messages are inconsistent, incomplete, and often misleading. No standard logging taxonomy exists across most systems.
- **Log parsing brittleness**: The choice of log parser materially affects anomaly detection accuracy. Parsing errors propagate through the entire analysis pipeline.
- **Rare event problem**: Anomalous events are rare by definition. Class imbalance makes both supervised and unsupervised approaches fragile.

### What Specifically Produces Too Many False Positives

1. **Generic static analysis tools applied without configuration**: SonarQube/FindBugs/ESLint with all rules enabled on a large codebase produce thousands of warnings, most not safety-relevant.
2. **Taint analysis without sources/sinks specification**: Tracking all data flows without specifying which sources and sinks matter produces combinatorial explosion.
3. **Fault tree construction without hazard scoping**: Building fault trees for "any possible error" rather than specific identified hazards produces unmanageable trees.
4. **SBFL on poorly-covered code**: Low test coverage produces near-random suspiciousness rankings.

### State/Event Fault Trees: An Attempted Solution

**Kaiser, B., Liggesmeyer, P., & Mackel, O.** (2003). "[A New Component Concept for Fault Trees](https://www.semanticscholar.org/paper/A-New-Component-Concept-for-Fault-Trees-Kaiser-Liggesmeyer/50226ad58579c00b7be9aacce3f1f1c704ee3f8a)." and **Kaiser, B. & Gramlich, C.** (2004). "[State-Event-Fault-Trees: A Safety Analysis Model for Software Controlled Systems](https://link.springer.com/chapter/10.1007/978-3-540-30138-7_17)."

SEFTs address one of the core SFTA limitations: traditional fault trees cannot express **temporal ordering**, **durations**, or **state dependencies** between components. SEFTs combine FTA elements with state-machine elements, distinguishing states from events visually. They can be translated to Deterministic and Stochastic Petri Nets (DSPNs) for analysis. However, SEFTs add complexity and are not widely adopted outside academic settings.

---

## Summary of Key Findings

**What is well-validated and works**:
- SFTA for small, well-scoped safety-critical code (nuclear, avionics) with experienced analysts
- SBFL with Ochiai/DStar formulas when good test suites exist
- Dynamic program slicing for single-fault localization (8% better than SBFL)
- Log template mining (Drain) combined with deep learning (DeepLog) for anomaly detection in production systems
- Causal inference for microservice RCA when service dependency graphs are available

**What is promising but immature**:
- Automated fault tree generation from code (only works from design models today, not raw source)
- LLM-based false positive reduction for static analysis (early results show F1 ~0.91)
- Configuration error detection by static checking against format/semantic rules (catches 38-54% of parameter errors)

**What does not work at scale**:
- Manual SFTA on codebases larger than a few thousand lines
- Generic static analysis without domain-specific configuration (90%+ false positive rates)
- SBFL without adequate test coverage
- Traditional static fault trees for temporally-dependent software behavior

Sources:
- [Leveson & Harvey, Software Fault Tree Analysis (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/0164121283900304)
- [NASA Software Engineering Handbook - SFTA](https://swehb.nasa.gov/display/SWEHBVD/8.07+-+Software+Fault+Tree+Analysis)
- [NASA Fault Tree Handbook with Aerospace Applications](https://www.mwftr.com/CS2/Fault%20Tree%20Handbook_NASA.pdf)
- [IEC 61025:2006 Standard](https://webstore.iec.ch/en/publication/4311)
- [Xu et al., Detecting Large-Scale System Problems by Mining Console Logs (SOSP 2009)](https://www.sigops.org/s/conferences/sosp/2009/papers/xu-sosp09.pdf)
- [He et al., Experience Report: System Log Analysis for Anomaly Detection (ISSRE 2016)](https://jiemingzhu.github.io/pub/slhe_issre2016.pdf)
- [He et al., Survey on Automated Log Analysis for Reliability Engineering](https://netman.aiops.org/~peidan/ANM2023/6.LogAnomalyDetection/A%20Survey%20on%20Automated%20Log%20Analysis%20for%20Reliability%20Engineering.pdf)
- [Zhu et al., Loghub (Semantic Scholar)](https://www.semanticscholar.org/paper/Loghub:-A-Large-Collection-of-System-Log-Datasets-Zhu-He/c3bdc6149097fa186a17d07cff6ce210d468bdf3)
- [Drain3 Log Parser (GitHub)](https://github.com/logpai/Drain3)
- [Abreu et al., SBFL (Wiley)](https://onlinelibrary.wiley.com/doi/10.1002/9781119880929.ch4)
- [SliceFL - SBFL Overview](https://slicefl.github.io/home/sbfl/)
- [Jones et al., Tarantula (ACM)](https://dl.acm.org/doi/10.1145/1101908.1101949)
- [Wong et al., DStar Method (IEEE)](https://ieeexplore.ieee.org/abstract/document/6651713/)
- [Soremekun et al., Locating Faults with Program Slicing (Springer)](https://link.springer.com/article/10.1007/s10664-020-09931-7)
- [ArChes - Automatic CFT Generation (ArXiv)](https://arxiv.org/abs/2105.15002)
- [EMFTA Tool (CMU SEI)](https://www.sei.cmu.edu/blog/emfta-an-open-source-tool-for-fault-tree-analysis/)
- [Kaiser & Liggesmeyer, State/Event Fault Trees (Springer)](https://link.springer.com/chapter/10.1007/978-3-540-30138-7_17)
- [Soldani et al., yRCA (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0167642323000795)
- [Soldani et al., Cascading Failures From Logs (Wiley)](https://onlinelibrary.wiley.com/doi/full/10.1002/spe.3400)
- [Li et al., Failure Diagnosis in Microservice Systems Survey (ACM)](https://dl.acm.org/doi/10.1145/3715005)
- [Garcia-Molina & Salem, Sagas (ACM)](https://dl.acm.org/doi/10.1145/38713.38742)
- [Yin et al., Configuration Errors Empirical Study (SOSP 2011)](https://www.sigops.org/s/conferences/sosp/2011/current/2011-Cascais/printable/12-yin.pdf)
- [CausalRCA (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S016412122300119X)
- [Root Cause Analysis Causal Inference Survey (ArXiv)](https://arxiv.org/html/2408.13729v1)
- [Static Analysis False Positives with LLMs (ArXiv)](https://arxiv.org/html/2601.18844v1)
- [Static Analysis Tools for Secure Code Review (ArXiv)](https://arxiv.org/html/2407.12241v1)
- [Dynamic FTA State-of-the-Art (ResearchGate)](https://www.researchgate.net/publication/336058830_Dynamic_Fault_Tree_Analysis_State-of-the-Art_in_Modelling_Analysis_and_Tools)
- [IEC 62304 - Medical Device Software (ISO)](https://www.iso.org/standard/38421.html)
- [IEC 62443 Standards (ISA)](https://www.isa.org/standards-and-publications/isa-standards/isa-iec-62443-series-of-standards)
- [DO-178C (Wikipedia)](https://en.wikipedia.org/wiki/DO-178C)
- [ISO 26262 and FTA (Embitel)](https://www.embitel.com/blog/embedded-blog/finding-the-role-of-fault-tree-analysis-in-iso-26262-compliance)
- [Misconfiguration Root Causes 2024 (ArXiv)](https://arxiv.org/html/2412.11121)
- [Log Parsing Impact on Anomaly Detection (Springer)](https://link.springer.com/article/10.1007/s10664-024-10533-w)
- [SFTA for Nuclear Reactor Protection (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0951832020305652)
