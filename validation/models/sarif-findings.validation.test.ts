/**
 * Statistical validation of SARIF findings against live indexed data.
 *
 * Reads real findings from the DB produced by `mma index`, samples them,
 * and independently verifies each against raw graph edges and source code.
 *
 * Run: npm run validate:models
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { KVStore, GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import { openValidationDb, closeValidationDb } from "../helpers/db.js";
import { ValidationReporter } from "../helpers/reporter.js";
import { computePageRank } from "@mma/query";
import { getFileContent, getHeadCommit } from "@mma/ingestion";

const SAMPLE_SIZE = 50;
const SEED = 42;
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const MIRRORS_DIR = resolve(PROJECT_ROOT, "data/mirrors");

// ─── Seeded PRNG (mulberry32) ──────────────────────────────

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  if (arr.length <= n) return [...arr];
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ─── SARIF helpers ─────────────────────────────────────────

interface SarifFinding {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: Array<{
    logicalLocations?: Array<{
      fullyQualifiedName?: string;
      kind?: string;
      properties?: Record<string, unknown>;
    }>;
  }>;
  properties?: Record<string, unknown>;
}

async function getAllFindings(
  kvStore: KVStore,
  sarifKey: string,
): Promise<Map<string, SarifFinding[]>> {
  const byRepo = new Map<string, SarifFinding[]>();
  const keys = await kvStore.keys(`sarif:${sarifKey}:`);
  for (const key of keys) {
    const repo = key.slice(`sarif:${sarifKey}:`.length);
    const raw = await kvStore.get(key);
    if (raw) {
      byRepo.set(repo, JSON.parse(raw) as SarifFinding[]);
    }
  }
  return byRepo;
}

function flattenFindings(
  byRepo: Map<string, SarifFinding[]>,
): Array<{ repo: string; finding: SarifFinding }> {
  const flat: Array<{ repo: string; finding: SarifFinding }> = [];
  for (const [repo, findings] of byRepo) {
    for (const finding of findings) {
      flat.push({ repo, finding });
    }
  }
  return flat;
}

function fqn(finding: SarifFinding): string {
  return finding.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? "";
}

// ─── Independent instability computation ───────────────────

interface ModuleInstability {
  ca: number;
  ce: number;
  instability: number;
}

function computeInstabilityFromEdges(
  edges: readonly GraphEdge[],
): Map<string, ModuleInstability> {
  const caCount = new Map<string, Set<string>>();
  const ceCount = new Map<string, Set<string>>();
  const modules = new Set<string>();

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;

    let ce = ceCount.get(edge.source);
    if (!ce) { ce = new Set(); ceCount.set(edge.source, ce); }
    ce.add(edge.target);

    let ca = caCount.get(edge.target);
    if (!ca) { ca = new Set(); caCount.set(edge.target, ca); }
    ca.add(edge.source);

    modules.add(edge.source);
    modules.add(edge.target);
  }

  const result = new Map<string, ModuleInstability>();
  for (const mod of modules) {
    const ca = caCount.get(mod)?.size ?? 0;
    const ce = ceCount.get(mod)?.size ?? 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    result.set(mod, { ca, ce, instability });
  }
  return result;
}

function bareRepoPath(repo: string): string {
  return resolve(MIRRORS_DIR, `${repo}.git`);
}

// Cache for expensive per-repo computations
const edgesCache = new Map<string, GraphEdge[]>();
const instabilityCache = new Map<string, Map<string, ModuleInstability>>();

async function getImportEdges(graphStore: GraphStore, repo: string): Promise<GraphEdge[]> {
  let cached = edgesCache.get(repo);
  if (!cached) {
    cached = await graphStore.getEdgesByKind("imports", repo);
    edgesCache.set(repo, cached);
  }
  return cached;
}

function getInstability(edges: readonly GraphEdge[], repo: string): Map<string, ModuleInstability> {
  let cached = instabilityCache.get(repo);
  if (!cached) {
    cached = computeInstabilityFromEdges(edges);
    instabilityCache.set(repo, cached);
  }
  return cached;
}

// ─── Main test suite ───────────────────────────────────────

describe("SARIF Findings Statistical Validation", () => {
  let kvStore: KVStore;
  let graphStore: GraphStore;
  const reporter = new ValidationReporter();
  const rng = mulberry32(SEED);

  beforeAll(() => {
    const stores = openValidationDb();
    if (!stores) throw new Error("Validation DB not found — run mma index first");
    kvStore = stores.kvStore;
    graphStore = stores.graphStore;
  });

  afterAll(() => {
    reporter.printSummary();
    closeValidationDb();
  });

  // ─────────────────────────────────────────────────────────
  // 1. structural/dead-export
  // ─────────────────────────────────────────────────────────

  describe("structural/dead-export", () => {
    let allDeadExports: Map<string, SarifFinding[]>;

    beforeAll(async () => {
      allDeadExports = await getAllFindings(kvStore, "deadExports");
    });

    describe("precision", () => {
      it("sampled dead exports are not import targets", async () => {
        const flat = flattenFindings(allDeadExports);
        if (flat.length === 0) {
          reporter.skip("dead-export", "*", "precision", "no findings");
          return;
        }

        const sampled = sampleN(flat, SAMPLE_SIZE, rng);
        let tp = 0;
        let fp = 0;

        for (const { repo, finding } of sampled) {
          const filePath = fqn(finding).split("#")[0];
          if (!filePath) continue;

          const edges = await getImportEdges(graphStore, repo);
          const importTargets = new Set(edges.map((e) => e.target));

          if (importTargets.has(filePath)) {
            fp++;
            reporter.fail("dead-export", repo, `precision: ${fqn(finding)}`,
              "file IS an import target");
          } else {
            tp++;
            reporter.pass("dead-export", repo, `precision: ${fqn(finding)}`);
          }
        }

        const total = tp + fp;
        console.log(`\n  dead-export precision: ${tp}/${total} (${pct(tp, total)})`);
        expect(fp, `${fp} false positives`).toBe(0);
      });
    });

    describe("recall", () => {
      it("files that are import sources but never targets are checked", async () => {
        const repos = [...allDeadExports.keys()];
        const sampledRepos = sampleN(repos, 3, rng);
        let candidates = 0;
        let unflagged = 0;

        for (const repo of sampledRepos) {
          const edges = await getImportEdges(graphStore, repo);
          const sources = new Set(edges.map((e) => e.source));
          const targets = new Set(edges.map((e) => e.target));

          // Files that import others but are never imported
          const neverImported = [...sources].filter((s) => !targets.has(s));

          const findings = allDeadExports.get(repo) ?? [];
          const flaggedFiles = new Set(
            findings.map((f) => fqn(f).split("#")[0]),
          );

          const sampled = sampleN(neverImported, 5, rng);
          for (const file of sampled) {
            candidates++;
            if (!flaggedFiles.has(file)) {
              unflagged++;
            }
          }
        }

        // Informational — unflagged files may simply not have exports
        console.log(`\n  dead-export recall: ${candidates - unflagged}/${candidates} never-imported files flagged`);
        console.log(`  (${unflagged} unflagged — may lack exports, which is correct)`);
      });
    });

    describe("cross-repo", () => {
      it("sampled dead exports are not referenced in other repos", async () => {
        const flat = flattenFindings(allDeadExports);
        if (flat.length === 0) return;

        const sampled = sampleN(flat, 5, rng);
        for (const { repo, finding } of sampled) {
          const symbolName = fqn(finding).split("#")[1] ?? "";
          if (!symbolName) continue;

          let crossRepoRef = false;
          for (const [otherRepo] of allDeadExports) {
            if (otherRepo === repo) continue;
            const otherEdges = await getImportEdges(graphStore, otherRepo);
            if (otherEdges.some((e) => e.target.includes(symbolName))) {
              crossRepoRef = true;
              break;
            }
          }

          reporter.record({
            category: "dead-export",
            repo,
            label: `cross-repo: ${symbolName}`,
            status: crossRepoRef ? "skip" : "pass",
            detail: crossRepoRef
              ? "symbol name found in another repo (may be coincidental)"
              : undefined,
          });
        }
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. structural/unstable-dependency
  // ─────────────────────────────────────────────────────────

  describe("structural/unstable-dependency", () => {
    let allInstability: Map<string, SarifFinding[]>;

    beforeAll(async () => {
      allInstability = await getAllFindings(kvStore, "instability");
    });

    describe("precision", () => {
      it("sampled SDP violations have instability delta > 0.3", async () => {
        const sdpFindings = flattenFindings(allInstability).filter(
          (f) => f.finding.ruleId === "structural/unstable-dependency",
        );
        if (sdpFindings.length === 0) {
          reporter.skip("unstable-dep", "*", "precision", "no findings");
          return;
        }

        const sampled = sampleN(sdpFindings, SAMPLE_SIZE, rng);
        let tp = 0;
        let fp = 0;

        for (const { repo, finding } of sampled) {
          // Message: "src/a.ts (I=0.20) depends on src/b.ts (I=0.80): ..."
          const match = finding.message.text.match(
            /^(.+?) \(I=([\d.]+)\) depends on (.+?) \(I=([\d.]+)\)/,
          );
          if (!match) {
            reporter.skip("unstable-dep", repo, "precision: parse fail",
              finding.message.text.slice(0, 80));
            continue;
          }

          const [, srcPath, srcIStr, tgtPath, tgtIStr] = match;
          const reportedSrcI = parseFloat(srcIStr);
          const reportedTgtI = parseFloat(tgtIStr);

          const edges = await getImportEdges(graphStore, repo);
          const metrics = getInstability(edges, repo);
          const srcMetric = metrics.get(srcPath);
          const tgtMetric = metrics.get(tgtPath);

          if (!srcMetric || !tgtMetric) {
            reporter.skip("unstable-dep", repo,
              `precision: ${srcPath}->${tgtPath}`, "module not in edge graph");
            continue;
          }

          const computedDelta = tgtMetric.instability - srcMetric.instability;
          const srcMatch = Math.abs(reportedSrcI - srcMetric.instability) < 0.015;
          const tgtMatch = Math.abs(reportedTgtI - tgtMetric.instability) < 0.015;

          if (computedDelta > 0.3 && srcMatch && tgtMatch) {
            tp++;
            reporter.pass("unstable-dep", repo, `precision: ${srcPath}->${tgtPath}`);
          } else {
            fp++;
            const reasons: string[] = [];
            if (computedDelta <= 0.3) reasons.push(`delta=${computedDelta.toFixed(2)} <= 0.3`);
            if (!srcMatch) reasons.push(`I(src): reported=${reportedSrcI} computed=${srcMetric.instability.toFixed(2)}`);
            if (!tgtMatch) reasons.push(`I(tgt): reported=${reportedTgtI} computed=${tgtMetric.instability.toFixed(2)}`);
            reporter.fail("unstable-dep", repo,
              `precision: ${srcPath}->${tgtPath}`, reasons.join("; "));
          }
        }

        const total = tp + fp;
        console.log(`\n  unstable-dep precision: ${tp}/${total} (${pct(tp, total)})`);
        expect.soft(fp, `${fp} false positives`).toBe(0);
      });
    });

    describe("recall", () => {
      it("all import edges with delta > 0.3 have corresponding findings", async () => {
        const repos = [...allInstability.keys()];
        const sampledRepos = sampleN(repos, 3, rng);
        let totalMissed = 0;
        let totalChecked = 0;

        for (const repo of sampledRepos) {
          const edges = await getImportEdges(graphStore, repo);
          const metrics = getInstability(edges, repo);

          const findings = (allInstability.get(repo) ?? []).filter(
            (f) => f.ruleId === "structural/unstable-dependency",
          );
          const reportedPairs = new Set(findings.map((f) => fqn(f)));

          for (const edge of edges) {
            if (edge.kind !== "imports") continue;
            const src = metrics.get(edge.source);
            const tgt = metrics.get(edge.target);
            if (!src || !tgt) continue;

            const delta = tgt.instability - src.instability;
            if (delta > 0.3) {
              totalChecked++;
              const key = `${edge.source}->${edge.target}`;
              if (!reportedPairs.has(key)) {
                totalMissed++;
                reporter.fail("unstable-dep", repo, `recall: ${key}`,
                  `delta=${delta.toFixed(2)} > 0.3 but not in findings`);
              }
            }
          }
        }

        console.log(`\n  unstable-dep recall: ${totalChecked - totalMissed}/${totalChecked} violations captured`);
        expect.soft(totalMissed, `${totalMissed} false negatives`).toBe(0);
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. structural/pain-zone-module
  // ─────────────────────────────────────────────────────────

  describe("structural/pain-zone-module", () => {
    let allInstability: Map<string, SarifFinding[]>;

    beforeAll(async () => {
      allInstability = await getAllFindings(kvStore, "instability");
    });

    describe("precision", () => {
      it("sampled pain-zone findings have I < 0.3, A < 0.3, ca > 0", async () => {
        const painFindings = flattenFindings(allInstability).filter(
          (f) => f.finding.ruleId === "structural/pain-zone-module",
        );
        if (painFindings.length === 0) {
          reporter.skip("pain-zone", "*", "precision", "no findings");
          return;
        }

        const sampled = sampleN(painFindings, SAMPLE_SIZE, rng);
        let tp = 0;
        let fp = 0;

        for (const { repo, finding } of sampled) {
          // Message: "module is in the pain zone (I=0.20, A=0.10): ..."
          const match = finding.message.text.match(/\(I=([\d.]+), A=([\d.]+)\)/);
          if (!match) {
            reporter.skip("pain-zone", repo, "precision: parse fail",
              finding.message.text.slice(0, 80));
            continue;
          }

          const reportedI = parseFloat(match[1]);
          const reportedA = parseFloat(match[2]);
          const modulePath = fqn(finding);

          const edges = await getImportEdges(graphStore, repo);
          const metrics = getInstability(edges, repo);
          const modMetric = metrics.get(modulePath);

          const checks = {
            instabilityLow: reportedI < 0.3,
            abstractnessLow: reportedA < 0.3,
            hasDependents: modMetric ? modMetric.ca > 0 : true,
            instabilityMatch: modMetric
              ? Math.abs(reportedI - modMetric.instability) < 0.015
              : true,
          };

          if (checks.instabilityLow && checks.abstractnessLow &&
              checks.hasDependents && checks.instabilityMatch) {
            tp++;
            reporter.pass("pain-zone", repo, `precision: ${modulePath}`);
          } else {
            fp++;
            const reasons: string[] = [];
            if (!checks.instabilityLow) reasons.push(`I=${reportedI} >= 0.3`);
            if (!checks.abstractnessLow) reasons.push(`A=${reportedA} >= 0.3`);
            if (!checks.hasDependents) reasons.push("ca=0");
            if (!checks.instabilityMatch) {
              reasons.push(`I mismatch: reported=${reportedI}, computed=${modMetric!.instability.toFixed(2)}`);
            }
            reporter.fail("pain-zone", repo, `precision: ${modulePath}`,
              reasons.join("; "));
          }
        }

        const total = tp + fp;
        console.log(`\n  pain-zone precision: ${tp}/${total} (${pct(tp, total)})`);
        expect.soft(fp, `${fp} false positives`).toBe(0);
      });
    });

    describe("recall", () => {
      it("modules with I < 0.3 and ca > 0 are checked for coverage", async () => {
        const repos = [...allInstability.keys()];
        const sampledRepos = sampleN(repos, 3, rng);
        let edgeCandidates = 0;
        let flagged = 0;

        for (const repo of sampledRepos) {
          const edges = await getImportEdges(graphStore, repo);
          const metrics = getInstability(edges, repo);

          const findings = (allInstability.get(repo) ?? []).filter(
            (f) => f.ruleId === "structural/pain-zone-module",
          );
          const flaggedModules = new Set(findings.map((f) => fqn(f)));

          for (const [mod, m] of metrics) {
            if (m.instability < 0.3 && m.ca > 0) {
              edgeCandidates++;
              if (flaggedModules.has(mod)) flagged++;
            }
          }
        }

        // Can't verify abstractness < 0.3 from edges alone,
        // so unflagged modules may have abstractness >= 0.3 (correctly excluded)
        console.log(`\n  pain-zone recall: ${flagged}/${edgeCandidates} edge-candidates flagged`);
        console.log("  (unflagged modules may have abstractness >= 0.3 — correct exclusion)");
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // 4. structural/uselessness-zone-module
  // ─────────────────────────────────────────────────────────

  describe("structural/uselessness-zone-module", () => {
    let allInstability: Map<string, SarifFinding[]>;

    beforeAll(async () => {
      allInstability = await getAllFindings(kvStore, "instability");
    });

    describe("precision", () => {
      it("sampled uselessness-zone findings have I > 0.7, A > 0.7", async () => {
        const findings = flattenFindings(allInstability).filter(
          (f) => f.finding.ruleId === "structural/uselessness-zone-module",
        );
        if (findings.length === 0) {
          reporter.skip("uselessness", "*", "precision", "no findings");
          return;
        }

        const sampled = sampleN(findings, SAMPLE_SIZE, rng);
        let tp = 0;
        let fp = 0;

        for (const { repo, finding } of sampled) {
          const match = finding.message.text.match(/\(I=([\d.]+), A=([\d.]+)\)/);
          if (!match) {
            reporter.skip("uselessness", repo, "precision: parse fail",
              finding.message.text.slice(0, 80));
            continue;
          }

          const reportedI = parseFloat(match[1]);
          const reportedA = parseFloat(match[2]);
          const modulePath = fqn(finding);

          const edges = await getImportEdges(graphStore, repo);
          const metrics = getInstability(edges, repo);
          const modMetric = metrics.get(modulePath);

          const checks = {
            instabilityHigh: reportedI > 0.7,
            abstractnessHigh: reportedA > 0.7,
            instabilityMatch: modMetric
              ? Math.abs(reportedI - modMetric.instability) < 0.015
              : true,
          };

          if (checks.instabilityHigh && checks.abstractnessHigh && checks.instabilityMatch) {
            tp++;
            reporter.pass("uselessness", repo, `precision: ${modulePath}`);
          } else {
            fp++;
            const reasons: string[] = [];
            if (!checks.instabilityHigh) reasons.push(`I=${reportedI} <= 0.7`);
            if (!checks.abstractnessHigh) reasons.push(`A=${reportedA} <= 0.7`);
            if (!checks.instabilityMatch) {
              reasons.push(`I mismatch: ${reportedI} vs ${modMetric!.instability.toFixed(2)}`);
            }
            reporter.fail("uselessness", repo, `precision: ${modulePath}`,
              reasons.join("; "));
          }
        }

        const total = tp + fp;
        console.log(`\n  uselessness precision: ${tp}/${total} (${pct(tp, total)})`);
        expect.soft(fp, `${fp} false positives`).toBe(0);
      });
    });

    describe("recall", () => {
      it("modules with I > 0.7 are checked for coverage", async () => {
        const repos = [...allInstability.keys()];
        const sampledRepos = sampleN(repos, 3, rng);
        let edgeCandidates = 0;
        let flaggedCount = 0;

        for (const repo of sampledRepos) {
          const edges = await getImportEdges(graphStore, repo);
          const metrics = getInstability(edges, repo);

          const findings = (allInstability.get(repo) ?? []).filter(
            (f) => f.ruleId === "structural/uselessness-zone-module",
          );
          const flaggedModules = new Set(findings.map((f) => fqn(f)));

          for (const [mod, m] of metrics) {
            if (m.instability > 0.7) {
              edgeCandidates++;
              if (flaggedModules.has(mod)) flaggedCount++;
            }
          }
        }

        console.log(`\n  uselessness recall: ${flaggedCount}/${edgeCandidates} edge-candidates flagged`);
        console.log("  (unflagged modules may have abstractness <= 0.7 — correct exclusion)");
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // 5. fault/unhandled-error-path
  // ─────────────────────────────────────────────────────────

  describe("fault/unhandled-error-path", () => {
    const hasMirrors = existsSync(MIRRORS_DIR);
    let allFault: Map<string, SarifFinding[]>;

    beforeAll(async () => {
      allFault = await getAllFindings(kvStore, "fault");
    });

    describe("precision", () => {
      it.skipIf(!hasMirrors)(
        "sampled fault findings have catch blocks without logging/re-throw",
        async () => {
          const flat = flattenFindings(allFault);
          if (flat.length === 0) {
            reporter.skip("fault", "*", "precision", "no findings");
            return;
          }

          const sampled = sampleN(flat, SAMPLE_SIZE, rng);
          let tp = 0;
          let fp = 0;
          let skipped = 0;

          const loggingRe =
            /\b(console\.(log|warn|error|info|debug)|logger\.|log\.|logging\.|this\.logger|throw\b)/i;

          for (const { repo, finding } of sampled) {
            const modulePath = fqn(finding);
            if (!modulePath) { skipped++; continue; }

            const repoDir = bareRepoPath(repo);
            if (!existsSync(repoDir)) { skipped++; continue; }

            try {
              const commit = await getHeadCommit(repoDir);
              const source = await getFileContent(repoDir, commit, modulePath);

              // Heuristic: find catch blocks and check for logging/re-throw
              const catchRe = /catch\s*\([^)]*\)\s*\{/g;
              let hasSilentCatch = false;
              let catchIdx;

              while ((catchIdx = catchRe.exec(source)) !== null) {
                // Extract a rough catch body (up to 500 chars after the opening brace)
                const bodyStart = catchIdx.index + catchIdx[0].length;
                const bodySlice = source.slice(bodyStart, bodyStart + 500);
                // Find matching closing brace (simple nesting)
                let depth = 1;
                let end = 0;
                for (let i = 0; i < bodySlice.length && depth > 0; i++) {
                  if (bodySlice[i] === "{") depth++;
                  else if (bodySlice[i] === "}") depth--;
                  end = i;
                }
                const catchBody = bodySlice.slice(0, end);

                if (!loggingRe.test(catchBody)) {
                  hasSilentCatch = true;
                  break;
                }
              }

              if (hasSilentCatch) {
                tp++;
                reporter.pass("fault", repo, `precision: ${modulePath}`);
              } else {
                // CFG-based detection may find paths our regex heuristic misses
                fp++;
                reporter.fail("fault", repo, `precision: ${modulePath}`,
                  "catch blocks appear to have logging (regex heuristic — may be CFG-only path)");
              }
            } catch {
              skipped++;
              reporter.skip("fault", repo, `precision: ${modulePath}`, "could not read source");
            }
          }

          const total = tp + fp;
          console.log(`\n  fault precision: ${tp}/${total} (${pct(tp, total)}), ${skipped} skipped`);
          // Soft expect: regex heuristic may disagree with CFG analysis
          expect.soft(fp, `${fp} possible false positives (regex vs CFG)`).toBeLessThanOrEqual(
            Math.ceil(total * 0.3),
          );
        },
      );
    });

    describe("recall", () => {
      it.skipIf(!hasMirrors)(
        "files with silent catch blocks are in findings",
        async () => {
          const repos = [...allFault.keys()];
          const sampledRepos = sampleN(repos, 2, rng);
          let checked = 0;
          let missed = 0;

          for (const repo of sampledRepos) {
            const repoDir = bareRepoPath(repo);
            if (!existsSync(repoDir)) continue;

            const findings = allFault.get(repo) ?? [];
            const flaggedPaths = new Set(findings.map((f) => fqn(f)));

            const edges = await getImportEdges(graphStore, repo);
            const allFiles = new Set([
              ...edges.map((e) => e.source),
              ...edges.map((e) => e.target),
            ]);
            const unflaggedTs = [...allFiles].filter(
              (f) => !flaggedPaths.has(f) && f.endsWith(".ts"),
            );

            const sampled = sampleN(unflaggedTs, 5, rng);
            for (const filePath of sampled) {
              try {
                const commit = await getHeadCommit(repoDir);
                const source = await getFileContent(repoDir, commit, filePath);
                if (!source.includes("catch")) continue;

                checked++;
                const catchRe = /catch\s*\([^)]*\)\s*\{/g;
                const loggingRe =
                  /\b(console\.(log|warn|error|info|debug)|logger\.|log\.|logging\.|this\.logger|throw\b)/i;
                let catchIdx;

                while ((catchIdx = catchRe.exec(source)) !== null) {
                  const bodyStart = catchIdx.index + catchIdx[0].length;
                  const bodySlice = source.slice(bodyStart, bodyStart + 500);
                  let depth = 1;
                  let end = 0;
                  for (let i = 0; i < bodySlice.length && depth > 0; i++) {
                    if (bodySlice[i] === "{") depth++;
                    else if (bodySlice[i] === "}") depth--;
                    end = i;
                  }
                  const catchBody = bodySlice.slice(0, end);

                  if (!loggingRe.test(catchBody)) {
                    missed++;
                    reporter.fail("fault", repo, `recall: ${filePath}`,
                      "has silent catch block but not in findings");
                    break;
                  }
                }
              } catch {
                // File may not exist at HEAD
              }
            }
          }

          console.log(`\n  fault recall: ${checked - missed}/${checked} files with catch blocks verified`);
        },
      );
    });
  });

  // ─────────────────────────────────────────────────────────
  // 6. blast-radius/high-pagerank
  // ─────────────────────────────────────────────────────────

  describe("blast-radius/high-pagerank", () => {
    let allBlastRadius: Map<string, SarifFinding[]>;

    beforeAll(async () => {
      allBlastRadius = await getAllFindings(kvStore, "blastRadius");
    });

    describe("precision", () => {
      it("sampled blast-radius findings are in independently computed top-10", async () => {
        const flat = flattenFindings(allBlastRadius);
        if (flat.length === 0) {
          reporter.skip("pagerank", "*", "precision", "no findings");
          return;
        }

        const sampled = sampleN(flat, SAMPLE_SIZE, rng);
        let tp = 0;
        let fp = 0;

        const prCache = new Map<string, Set<string>>();

        for (const { repo, finding } of sampled) {
          let top10 = prCache.get(repo);
          if (!top10) {
            const edges = await getImportEdges(graphStore, repo);
            const prResult = computePageRank(edges);
            top10 = new Set(prResult.ranked.slice(0, 10).map((r) => r.path));
            prCache.set(repo, top10);
          }

          const modulePath = fqn(finding);
          if (top10.has(modulePath)) {
            tp++;
            reporter.pass("pagerank", repo, `precision: ${modulePath}`);
          } else {
            fp++;
            reporter.fail("pagerank", repo, `precision: ${modulePath}`,
              "not in independently computed top-10");
          }
        }

        const total = tp + fp;
        console.log(`\n  pagerank precision: ${tp}/${total} (${pct(tp, total)})`);
        expect.soft(fp, `${fp} false positives`).toBe(0);
      });
    });

    describe("recall", () => {
      it("independently computed top-10 modules are in findings", async () => {
        const repos = [...allBlastRadius.keys()];
        const sampledRepos = sampleN(repos, 3, rng);
        let totalMissed = 0;
        let totalChecked = 0;

        for (const repo of sampledRepos) {
          const edges = await getImportEdges(graphStore, repo);
          const prResult = computePageRank(edges);
          const top10 = prResult.ranked.slice(0, 10);

          const findings = allBlastRadius.get(repo) ?? [];
          const flaggedPaths = new Set(findings.map((f) => fqn(f)));

          for (const ranked of top10) {
            totalChecked++;
            if (!flaggedPaths.has(ranked.path)) {
              totalMissed++;
              reporter.fail("pagerank", repo, `recall: ${ranked.path}`,
                `rank=${ranked.rank}, score=${ranked.score.toFixed(4)} but not in findings`);
            }
          }
        }

        console.log(`\n  pagerank recall: ${totalChecked - totalMissed}/${totalChecked} top-10 modules flagged`);
        expect.soft(totalMissed, `${totalMissed} false negatives`).toBe(0);
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // Horizontal: threshold consistency
  // ─────────────────────────────────────────────────────────

  describe("threshold consistency", () => {
    it("SDP threshold 0.3 is uniform across all repos", async () => {
      const allInstability = await getAllFindings(kvStore, "instability");
      const sdpFindings = flattenFindings(allInstability).filter(
        (f) => f.finding.ruleId === "structural/unstable-dependency",
      );

      let inconsistent = 0;
      for (const { finding } of sdpFindings) {
        const match = finding.message.text.match(/threshold=([\d.]+)/);
        if (match) {
          const threshold = parseFloat(match[1]);
          if (Math.abs(threshold - 0.3) > 0.001) {
            inconsistent++;
          }
        }
      }

      if (inconsistent > 0) {
        reporter.fail("consistency", "*", "SDP threshold",
          `${inconsistent} findings with non-0.3 threshold`);
      } else {
        reporter.pass("consistency", "*", "SDP threshold uniformity");
      }

      expect(inconsistent, "non-0.3 thresholds found").toBe(0);
    });
  });
});

// ─── Utility ───────────────────────────────────────────────

function pct(n: number, total: number): string {
  if (total === 0) return "N/A";
  return `${((n / total) * 100).toFixed(1)}%`;
}
