# Reference Verification Report

A verification agent visited and read 8 key references from the fault tree and log analysis domain. Below are the results.

---

## Reference 1: Leveson & Harvey 1983 "Software Fault Tree Analysis"

**URL:** https://www.sciencedirect.com/science/article/abs/pii/0164121283900304

- **URL works:** Yes
- **Claims match:** Yes
- **Title:** "Software fault tree analysis"
- **Authors:** Nancy G. Leveson, Peter R. Harvey
- **Venue:** Journal of Systems and Software, Vol 3, Issue 2, June 1983, pp 173-181
- **Corrections needed:** None

---

## Reference 2: NASA Software Engineering Handbook - SFTA

**URL:** https://swehb.nasa.gov/display/SWEHBVD/8.07+-+Software+Fault+Tree+Analysis

- **URL works:** Yes
- **Claims match:** Yes
- **Key claim verified:** "Canadian nuclear power plant shutdown system (6,000 lines) analyzed via SFTA in 3 work-months; full functional verification took 30 work-years" -- exact match with page content ("6K lines of code", "three work months", "30 work years")
- **Corrections needed:** None (minor: page says "6K" not "6,000")

---

## Reference 3: Xu et al. SOSP 2009

**URL:** https://www.sigops.org/s/conferences/sosp/2009/papers/xu-sosp09.pdf

- **URL works:** Yes (PDF loads)
- **Title confirmed:** "Detecting Large-Scale System Problems by Mining Console Logs"
- **Authors:** Wei Xu, Ling Huang, Armando Fox, David Patterson, Michael I. Jordan
- **PCA usage:** Confirmed
- **Correction:** The characterization "first work to apply PCA systematically to console log mining" is editorial, not a direct claim from the paper. The paper does not use that exact phrase. It is a reasonable characterization but should be presented as such.

---

## Reference 4: He et al. 2021 Survey

**URL:** https://netman.aiops.org/~peidan/ANM2023/6.LogAnomalyDetection/A%20Survey%20on%20Automated%20Log%20Analysis%20for%20Reliability%20Engineering.pdf

- **URL works:** Yes (PDF loads, arXiv preprint hosted on course page)
- **Title confirmed:** "A Survey on Automated Log Analysis for Reliability Engineering"
- **Authors:** Shilin He, Pinjia He, Zhuangbin Chen, Tianyi Yang, Yuxin Su, Michael R. Lyu
- **Year:** Published ACM Computing Surveys, Vol 54, No 6, Article 130, July 2021 (arXiv preprint September 2020). Citing as "He et al. 2021" is correct.
- **Corrections needed:** None significant. "Most comprehensive" is editorial but defensible.

---

## Reference 5: Soremekun et al. 2021 Program Slicing

**URL:** https://link.springer.com/article/10.1007/s10664-020-09931-7

- **URL works:** Yes
- **Title confirmed:** "Locating faults with program slicing: an empirical analysis"
- **Authors:** Ezekiel Soremekun, Lukas Kirschner, Marcel Bohme, Andreas Zeller
- **Venue:** Empirical Software Engineering 26, 51 (2021)
- **Key claim verified exactly:** Abstract states "For single faults, we find that dynamic slicing was eight percentage points more effective than the best performing statistical debugging formula" and "for 66% of the bugs, dynamic slicing finds the fault earlier"
- **Corrections needed:** None. Claims match abstract verbatim.

---

## Reference 6: Yin et al. SOSP 2011

**URL:** https://www.sigops.org/s/conferences/sosp/2011/current/2011-Cascais/printable/12-yin.pdf

- **URL works:** Yes (14-page PDF)
- **Full title:** "An Empirical Study on Configuration Errors in Commercial and Open Source Systems" (research reports truncated to just "An Empirical Study on Configuration Errors")
- **Authors:** Zuoning Yin, Xiao Ma, Jing Zheng, Yuanyuan Zhou, Lakshmi N. Bairavasundaram, Shankar Pasupathy
- **70-85.5% parameter mistakes:** Confirmed from abstract
- **38.1-53.7% mechanically detectable:** Confirmed from abstract
- **31% of high-severity support requests:** The introduction says "around 27%" for configuration-related issues in COMP-A's customer-support database. The 31% figure may refer to a specific severity tier. Needs precise sourcing within the paper.
- **Corrections needed:** Use full title. Verify 31% vs 27% distinction.

---

## Reference 7: Drain3 Log Parser

**URL:** https://github.com/logpai/Drain3

- **URL works:** Yes
- **Description confirmed:** "A robust streaming log template miner based on the Drain algorithm"
- **"One of the most widely adopted":** Editorial characterization supported by evidence (751 stars, 167 forks, highest average accuracy across 16 benchmark datasets per ICSE 2019 study, production use by IBM and UK Government BEIS)
- **Corrections needed:** Characterization is defensible but editorial. Parent project logpai/logparser has ~1,800+ stars.

---

## Reference 8: Microservice Failure Diagnosis Survey -- SIGNIFICANT ERROR

**URL:** https://dl.acm.org/doi/10.1145/3715005

- **URL works:** Yes
- **ERRORS FOUND:**
  - **Wrong authors:** Cited as "Li et al. 2024" but actual authors are **Shenglin Zhang, Sibo Xia, Wenzhao Fan, Binpeng Shi, Xiao Xiong, Zhenyu Zhong, Minghua Ma, Yongqian Sun, Dan Pei**. There is no "Li" among the authors.
  - **Wrong year:** Published 11 December 2025 in ACM TOSEM Vol 35, Issue 1, Article 2, pp 1-55. Not 2024.
  - **Truncated title:** Full title is "Failure Diagnosis in Microservice Systems: A Comprehensive Survey and Analysis"
- **"Reviews 98 papers":** Confirmed from abstract
- **Corrections:** Must cite as **Zhang et al. 2025**, not Li et al. 2024

---

## Summary

| # | Reference | URL Works | Claims Match | Corrections |
|---|-----------|-----------|-------------|-------------|
| 1 | Leveson & Harvey 1983 | Yes | Yes | None |
| 2 | NASA SWEHB SFTA | Yes | Yes | None |
| 3 | Xu et al. SOSP 2009 | Yes | Mostly | "First PCA" is editorial |
| 4 | He et al. 2021 survey | Yes | Yes | None significant |
| 5 | Soremekun et al. 2021 | Yes | Exact | None |
| 6 | Yin et al. SOSP 2011 | Yes | Mostly | Full title; 31% vs 27% |
| 7 | Drain3 | Yes | Mostly | "Most widely adopted" is editorial |
| 8 | Zhang et al. 2025 | Yes | **No** | **Wrong authors, wrong year, truncated title** |
