/**
 * `mma validate` — Statistical validation of SARIF findings.
 *
 * Samples findings from the DB, independently verifies each against raw graph
 * edges and (optionally) source code, and reports precision/recall per rule.
 *
 * The same check functions are shared with the vitest validation suite in
 * validation/models/sarif-findings.validation.test.ts.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import type { KVStore, GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import { computePageRank } from "@mma/query";
import { getFileContent, getHeadCommit } from "@mma/ingestion";

// ─── Seeded PRNG (mulberry32) ──────────────────────────────

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleN<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  if (arr.length <= n) return [...arr];
  const copy = [...arr] as T[];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

// ─── SARIF helpers ─────────────────────────────────────────

export interface SarifFinding {
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

export async function getAllFindings(
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

export function flattenFindings(
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

export function fqn(finding: SarifFinding): string {
  return finding.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? "";
}

// ─── Independent instability computation ───────────────────

export interface ModuleInstability {
  ca: number;
  ce: number;
  instability: number;
}

export function computeInstabilityFromEdges(
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

// ─── Per-run caches (cleared each validateCommand call) ────

let edgesCache: Map<string, GraphEdge[]> = new Map();
let instabilityCache: Map<string, Map<string, ModuleInstability>> = new Map();

/** Reset per-run caches. Called automatically by validateCommand; exported for testing. */
export function resetCaches(): void {
  edgesCache = new Map();
  instabilityCache = new Map();
}

export async function getImportEdges(graphStore: GraphStore, repo: string): Promise<GraphEdge[]> {
  let cached = edgesCache.get(repo);
  if (!cached) {
    cached = await graphStore.getEdgesByKind("imports", repo);
    edgesCache.set(repo, cached);
  }
  return cached;
}

export function getInstability(edges: readonly GraphEdge[], repo: string): Map<string, ModuleInstability> {
  let cached = instabilityCache.get(repo);
  if (!cached) {
    cached = computeInstabilityFromEdges(edges);
    instabilityCache.set(repo, cached);
  }
  return cached;
}

// ─── ValidationReporter ────────────────────────────────────

export interface AssertionResult {
  category: string;
  repo: string;
  label: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export class ValidationReporter {
  private results: AssertionResult[] = [];

  record(result: AssertionResult): void {
    this.results.push(result);
  }

  pass(category: string, repo: string, label: string): void {
    this.results.push({ category, repo, label, status: "pass" });
  }

  fail(category: string, repo: string, label: string, detail?: string): void {
    this.results.push({ category, repo, label, status: "fail", detail });
  }

  skip(category: string, repo: string, label: string, detail?: string): void {
    this.results.push({ category, repo, label, status: "skip", detail });
  }

  get counts() {
    const pass = this.results.filter((r) => r.status === "pass").length;
    const fail = this.results.filter((r) => r.status === "fail").length;
    const skip = this.results.filter((r) => r.status === "skip").length;
    return { pass, fail, skip, total: this.results.length };
  }

  get failures(): AssertionResult[] {
    return this.results.filter((r) => r.status === "fail");
  }

  /** Group results by category for the per-rule summary. */
  byCategory(): Map<string, { pass: number; fail: number; skip: number }> {
    const cats = new Map<string, { pass: number; fail: number; skip: number }>();
    for (const r of this.results) {
      let c = cats.get(r.category);
      if (!c) { c = { pass: 0, fail: 0, skip: 0 }; cats.set(r.category, c); }
      c[r.status]++;
    }
    return cats;
  }

  toJSON(): ValidateResult {
    const { pass, fail, skip } = this.counts;
    const checks: ValidateResult["checks"] = [];
    for (const [rule, c] of this.byCategory()) {
      checks.push({ rule, ...c });
    }
    return {
      summary: { pass, fail, skip, total: pass + fail + skip },
      checks,
      failures: this.failures.map((f) => ({
        category: f.category,
        repo: f.repo,
        label: f.label,
        detail: f.detail,
      })),
    };
  }
}

// ─── Check functions ───────────────────────────────────────

export async function checkDeadExport(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
): Promise<void> {
  const allDeadExports = await getAllFindings(kvStore, "deadExports");

  // --- Precision ---
  const flat = flattenFindings(allDeadExports);
  if (flat.length === 0) {
    reporter.skip("dead-export", "*", "precision", "no findings");
  } else {
    const sampled = sampleN(flat, sampleSize, rng);
    for (const { repo, finding } of sampled) {
      const filePath = fqn(finding).split("#")[0];
      if (!filePath) continue;

      const edges = await getImportEdges(graphStore, repo);
      const importTargets = new Set(edges.map((e) => e.target));

      if (importTargets.has(filePath)) {
        reporter.skip("dead-export", repo, `precision: ${fqn(finding)}`,
          "file-level import found — cannot verify symbol-level");
      } else {
        reporter.pass("dead-export", repo, `precision: ${fqn(finding)}`);
      }
    }
  }

  // --- Recall ---
  const repos = [...allDeadExports.keys()];
  const sampledRepos = sampleN(repos, 3, rng);
  for (const repo of sampledRepos) {
    const edges = await getImportEdges(graphStore, repo);
    const sources = new Set(edges.map((e) => e.source));
    const targets = new Set(edges.map((e) => e.target));
    const neverImported = [...sources].filter((s) => !targets.has(s));

    const findings = allDeadExports.get(repo) ?? [];
    const flaggedFiles = new Set(findings.map((f) => fqn(f).split("#")[0]));
    const sampled = sampleN(neverImported, 5, rng);
    for (const file of sampled) {
      if (flaggedFiles.has(file)) {
        reporter.pass("dead-export", repo, `recall: ${file}`);
      } else {
        // Unflagged files may simply not have exports — informational skip
        reporter.skip("dead-export", repo, `recall: ${file}`, "may lack exports");
      }
    }
  }

  // --- Cross-repo ---
  if (flat.length > 0) {
    const crossSample = sampleN(flat, 5, rng);
    for (const { repo, finding } of crossSample) {
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
  }
}

export async function checkUnstableDependency(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
): Promise<void> {
  const allInstability = await getAllFindings(kvStore, "instability");

  // --- Precision ---
  const sdpFindings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/unstable-dependency",
  );
  if (sdpFindings.length === 0) {
    reporter.skip("unstable-dep", "*", "precision", "no findings");
  } else {
    const sampled = sampleN(sdpFindings, sampleSize, rng);
    for (const { repo, finding } of sampled) {
      const match = finding.message.text.match(
        /^(.+?) \(I=([\d.]+)\) depends on (.+?) \(I=([\d.]+)\)/,
      );
      if (!match) {
        reporter.skip("unstable-dep", repo, "precision: parse fail",
          finding.message.text.slice(0, 80));
        continue;
      }

      const [, srcPath, srcIStr, tgtPath, tgtIStr] = match;
      const reportedSrcI = parseFloat(srcIStr!);
      const reportedTgtI = parseFloat(tgtIStr!);

      const edges = await getImportEdges(graphStore, repo);
      const metrics = getInstability(edges, repo);
      const srcMetric = metrics.get(srcPath!);
      const tgtMetric = metrics.get(tgtPath!);

      if (!srcMetric || !tgtMetric) {
        reporter.skip("unstable-dep", repo,
          `precision: ${srcPath}->${tgtPath}`, "module not in edge graph");
        continue;
      }

      const computedDelta = tgtMetric.instability - srcMetric.instability;
      const srcMatch = Math.abs(reportedSrcI - srcMetric.instability) < 0.015;
      const tgtMatch = Math.abs(reportedTgtI - tgtMetric.instability) < 0.015;

      if (computedDelta > 0.3 && srcMatch && tgtMatch) {
        reporter.pass("unstable-dep", repo, `precision: ${srcPath}->${tgtPath}`);
      } else {
        const reasons: string[] = [];
        if (computedDelta <= 0.3) reasons.push(`delta=${computedDelta.toFixed(2)} <= 0.3`);
        if (!srcMatch) reasons.push(`I(src): reported=${reportedSrcI} computed=${srcMetric.instability.toFixed(2)}`);
        if (!tgtMatch) reasons.push(`I(tgt): reported=${reportedTgtI} computed=${tgtMetric.instability.toFixed(2)}`);
        reporter.fail("unstable-dep", repo,
          `precision: ${srcPath}->${tgtPath}`, reasons.join("; "));
      }
    }
  }

  // --- Recall ---
  const allInstabilityForRecall = await getAllFindings(kvStore, "instability");
  const repos = [...allInstabilityForRecall.keys()];
  const sampledRepos = sampleN(repos, 3, rng);
  for (const repo of sampledRepos) {
    const edges = await getImportEdges(graphStore, repo);
    const metrics = getInstability(edges, repo);

    const findings = (allInstabilityForRecall.get(repo) ?? []).filter(
      (f) => f.ruleId === "structural/unstable-dependency",
    );
    // Findings are grouped by source module (one finding per source with violations),
    // so recall checks at the source level, not the edge-pair level.
    const reportedSources = new Set(findings.map((f) => fqn(f)));
    const checkedSources = new Set<string>();

    for (const edge of edges) {
      if (edge.kind !== "imports") continue;
      const src = metrics.get(edge.source);
      const tgt = metrics.get(edge.target);
      if (!src || !tgt) continue;

      const delta = tgt.instability - src.instability;
      if (delta > 0.3 && !checkedSources.has(edge.source)) {
        checkedSources.add(edge.source);
        if (reportedSources.has(edge.source)) {
          reporter.pass("unstable-dep", repo, `recall: ${edge.source}`);
        } else {
          reporter.fail("unstable-dep", repo, `recall: ${edge.source}`,
            `delta=${delta.toFixed(2)} > 0.3 but not in findings`);
        }
      }
    }
  }
}

export async function checkPainZone(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
): Promise<void> {
  const allInstability = await getAllFindings(kvStore, "instability");

  // --- Precision ---
  const painFindings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/pain-zone-module",
  );
  if (painFindings.length === 0) {
    reporter.skip("pain-zone", "*", "precision", "no findings");
  } else {
    const sampled = sampleN(painFindings, sampleSize, rng);
    for (const { repo, finding } of sampled) {
      const match = finding.message.text.match(/\(I=([\d.]+), A=([\d.]+)\)/);
      if (!match) {
        reporter.skip("pain-zone", repo, "precision: parse fail",
          finding.message.text.slice(0, 80));
        continue;
      }

      const reportedI = parseFloat(match[1]!);
      const reportedA = parseFloat(match[2]!);
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
        reporter.pass("pain-zone", repo, `precision: ${modulePath}`);
      } else {
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
  }

  // --- Recall ---
  const repos = [...allInstability.keys()];
  const sampledRepos = sampleN(repos, 3, rng);
  for (const repo of sampledRepos) {
    const edges = await getImportEdges(graphStore, repo);
    const metrics = getInstability(edges, repo);

    const findings = (allInstability.get(repo) ?? []).filter(
      (f) => f.ruleId === "structural/pain-zone-module",
    );
    const flaggedModules = new Set(findings.map((f) => fqn(f)));

    for (const [mod, m] of metrics) {
      if (m.instability < 0.3 && m.ca > 0) {
        if (flaggedModules.has(mod)) {
          reporter.pass("pain-zone", repo, `recall: ${mod}`);
        } else {
          // Unflagged — may have abstractness >= 0.3 (correctly excluded)
          reporter.skip("pain-zone", repo, `recall: ${mod}`,
            "may have abstractness >= 0.3");
        }
      }
    }
  }
}

export async function checkUselessnessZone(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
): Promise<void> {
  const allInstability = await getAllFindings(kvStore, "instability");

  // --- Precision ---
  const findings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/uselessness-zone-module",
  );
  if (findings.length === 0) {
    reporter.skip("uselessness", "*", "precision", "no findings");
  } else {
    const sampled = sampleN(findings, sampleSize, rng);
    for (const { repo, finding } of sampled) {
      const match = finding.message.text.match(/\(I=([\d.]+), A=([\d.]+)\)/);
      if (!match) {
        reporter.skip("uselessness", repo, "precision: parse fail",
          finding.message.text.slice(0, 80));
        continue;
      }

      const reportedI = parseFloat(match[1]!);
      const reportedA = parseFloat(match[2]!);
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
        reporter.pass("uselessness", repo, `precision: ${modulePath}`);
      } else {
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
  }

  // --- Recall ---
  const repos = [...allInstability.keys()];
  const sampledRepos = sampleN(repos, 3, rng);
  for (const repo of sampledRepos) {
    const edges = await getImportEdges(graphStore, repo);
    const metrics = getInstability(edges, repo);

    const repoFindings = (allInstability.get(repo) ?? []).filter(
      (f) => f.ruleId === "structural/uselessness-zone-module",
    );
    const flaggedModules = new Set(repoFindings.map((f) => fqn(f)));

    for (const [mod, m] of metrics) {
      if (m.instability > 0.7) {
        if (flaggedModules.has(mod)) {
          reporter.pass("uselessness", repo, `recall: ${mod}`);
        } else {
          // May have abstractness <= 0.7 (correctly excluded)
          reporter.skip("uselessness", repo, `recall: ${mod}`,
            "may have abstractness <= 0.7");
        }
      }
    }
  }
}

// ─── Catch-block heuristic helper ─────────────────────────

function hasSilentCatchBlock(source: string): boolean {
  const loggingRe =
    /\b(console\.(log|warn|error|info|debug)|logger\.|log\.|logging\.|this\.logger|throw\b)/i;
  const intentionalHandlingRe =
    /\b(return\s+[^;]+;|expect\s*[\s.(])/;
  const catchRe = /catch\s*(?:\([^)]*\))?\s*\{/g;
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
    if (!loggingRe.test(catchBody) && !intentionalHandlingRe.test(catchBody)) {
      return true;
    }
  }
  return false;
}

export async function checkFault(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
  mirrorsDir?: string,
): Promise<void> {
  const hasMirrors = mirrorsDir ? existsSync(mirrorsDir) : false;
  const allFault = await getAllFindings(kvStore, "fault");

  if (!hasMirrors) {
    reporter.skip("fault", "*", "precision", "no mirrors directory");
    reporter.skip("fault", "*", "recall", "no mirrors directory");
    return;
  }

  // Cache of indexed commit hashes per repo
  const commitCache = new Map<string, string>();
  async function getIndexedCommit(repo: string, repoDir: string): Promise<string> {
    let commit = commitCache.get(repo);
    if (!commit) {
      const stored = await kvStore.get(`commit:${repo}`);
      commit = stored ?? await getHeadCommit(repoDir);
      commitCache.set(repo, commit);
    }
    return commit;
  }

  // --- Precision ---
  const flat = flattenFindings(allFault);
  if (flat.length === 0) {
    reporter.skip("fault", "*", "precision", "no findings");
  } else {
    const sampled = sampleN(flat, sampleSize, rng);
    for (const { repo, finding } of sampled) {
      const modulePath = fqn(finding).split("#")[0];
      if (!modulePath) {
        reporter.skip("fault", repo, `precision: ${fqn(finding)}`, "no module path");
        continue;
      }

      const repoDir = resolve(mirrorsDir!, `${repo}.git`);
      if (!existsSync(repoDir)) {
        reporter.skip("fault", repo, `precision: ${modulePath}`, "repo mirror not found");
        continue;
      }

      try {
        const commit = await getIndexedCommit(repo, repoDir);
        const source = await getFileContent(repoDir, commit, modulePath);

        if (hasSilentCatchBlock(source)) {
          reporter.pass("fault", repo, `precision: ${modulePath}`);
        } else {
          reporter.fail("fault", repo, `precision: ${modulePath}`,
            "catch blocks appear to have logging (regex heuristic — may be CFG-only path)");
        }
      } catch {
        reporter.skip("fault", repo, `precision: ${modulePath}`, "could not read source");
      }
    }
  }

  // --- Recall ---
  const repos = [...allFault.keys()];
  const sampledRepos = sampleN(repos, 2, rng);
  for (const repo of sampledRepos) {
    const repoDir = resolve(mirrorsDir!, `${repo}.git`);
    if (!existsSync(repoDir)) continue;

    const findings = allFault.get(repo) ?? [];
    const flaggedPaths = new Set(findings.map((f) => fqn(f).split("#")[0]));

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
        const commit = await getIndexedCommit(repo, repoDir);
        const source = await getFileContent(repoDir, commit, filePath);
        if (!source.includes("catch")) continue;

        if (hasSilentCatchBlock(source)) {
          reporter.fail("fault", repo, `recall: ${filePath}`,
            "has silent catch block but not in findings");
        } else {
          reporter.pass("fault", repo, `recall: ${filePath}`);
        }
      } catch {
        // File may not exist at indexed commit
      }
    }
  }
}

export async function checkBlastRadius(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
): Promise<void> {
  const allBlastRadius = await getAllFindings(kvStore, "blastRadius");

  // --- Precision ---
  const flat = flattenFindings(allBlastRadius);
  if (flat.length === 0) {
    reporter.skip("pagerank", "*", "precision", "no findings");
  } else {
    const sampled = sampleN(flat, sampleSize, rng);
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
        reporter.pass("pagerank", repo, `precision: ${modulePath}`);
      } else {
        reporter.fail("pagerank", repo, `precision: ${modulePath}`,
          "not in independently computed top-10");
      }
    }
  }

  // --- Recall ---
  const repos = [...allBlastRadius.keys()];
  const sampledRepos = sampleN(repos, 3, rng);
  for (const repo of sampledRepos) {
    const edges = await getImportEdges(graphStore, repo);
    const prResult = computePageRank(edges);
    // pageRankToSarif() filters out nodes with score <= 0.03; align recall check
    const top10 = prResult.ranked.slice(0, 10).filter((r) => r.score > 0.03);

    const findings = allBlastRadius.get(repo) ?? [];
    const flaggedPaths = new Set(findings.map((f) => fqn(f)));

    for (const ranked of top10) {
      if (flaggedPaths.has(ranked.path)) {
        reporter.pass("pagerank", repo, `recall: ${ranked.path}`);
      } else {
        reporter.fail("pagerank", repo, `recall: ${ranked.path}`,
          `rank=${ranked.rank}, score=${ranked.score.toFixed(4)} but not in findings`);
      }
    }
  }
}

export async function checkThresholdConsistency(
  kvStore: KVStore,
  reporter: ValidationReporter,
): Promise<void> {
  const allInstability = await getAllFindings(kvStore, "instability");
  const sdpFindings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/unstable-dependency",
  );

  let inconsistent = 0;
  for (const { finding } of sdpFindings) {
    const match = finding.message.text.match(/threshold=([\d.]+)/);
    if (match) {
      const threshold = parseFloat(match[1]!);
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
}

// ─── Sanity checks ────────────────────────────────────────

export async function checkSanityEdges(
  _kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/edges";

  const importEdges = await graphStore.getEdgesByKind("imports");
  if (importEdges.length > 0) {
    reporter.pass(category, "*", "import edges exist");
  } else {
    reporter.fail(category, "*", "import edges exist", "no import edges found");
  }

  const callEdges = await graphStore.getEdgesByKind("calls");
  if (callEdges.length > 0) {
    reporter.pass(category, "*", "call edges exist");
  } else {
    reporter.fail(category, "*", "call edges exist", "no call edges found");
  }

  // Duplicate import edges (same source→target)
  const importPairs = new Set<string>();
  let dupImports = 0;
  for (const e of importEdges) {
    const key = `${e.source}\0${e.target}`;
    if (importPairs.has(key)) {
      dupImports++;
    } else {
      importPairs.add(key);
    }
  }
  if (dupImports === 0) {
    reporter.pass(category, "*", "no duplicate import edges");
  } else {
    reporter.fail(category, "*", "no duplicate import edges", `${dupImports} duplicate pairs`);
  }

  // Duplicate call edges (same source→target)
  const callPairs = new Set<string>();
  let dupCalls = 0;
  for (const e of callEdges) {
    const key = `${e.source}\0${e.target}`;
    if (callPairs.has(key)) {
      dupCalls++;
    } else {
      callPairs.add(key);
    }
  }
  if (dupCalls === 0) {
    reporter.pass(category, "*", "no duplicate call edges");
  } else {
    reporter.fail(category, "*", "no duplicate call edges", `${dupCalls} duplicate pairs`);
  }
}

export interface SarifDocument {
  runs?: Array<{
    tool?: unknown;
    results?: Array<{
      ruleId?: string;
      fingerprints?: Record<string, string>;
      [key: string]: unknown;
    }>;
  }>;
}

export async function checkSanitySarif(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/sarif";

  const raw = await kvStore.get("sarif:latest");
  if (!raw) {
    reporter.fail(category, "*", "sarif:latest exists", "key not found");
    return;
  }

  let doc: SarifDocument;
  try {
    doc = JSON.parse(raw) as SarifDocument;
  } catch {
    reporter.fail(category, "*", "sarif:latest parses", "invalid JSON");
    return;
  }

  const results = doc.runs?.[0]?.results ?? [];
  if (results.length > 0) {
    reporter.pass(category, "*", "results array non-empty");
  } else {
    reporter.fail(category, "*", "results array non-empty", "no results in sarif:latest");
  }

  // All results have ruleId
  const missingRuleId = results.filter((r) => !r.ruleId).length;
  if (missingRuleId === 0) {
    reporter.pass(category, "*", "all results have ruleId");
  } else {
    reporter.fail(category, "*", "all results have ruleId", `${missingRuleId} missing ruleId`);
  }

  // All results have fingerprints with at least one key
  const missingFingerprints = results.filter(
    (r) => !r.fingerprints || Object.keys(r.fingerprints).length === 0,
  ).length;
  if (missingFingerprints === 0) {
    reporter.pass(category, "*", "all results have fingerprints");
  } else {
    reporter.fail(category, "*", "all results have fingerprints",
      `${missingFingerprints} results missing fingerprints`);
  }

  // No duplicate fingerprints across results
  const fpValues = new Set<string>();
  let dupFingerprints = 0;
  for (const r of results) {
    if (!r.fingerprints) continue;
    for (const v of Object.values(r.fingerprints)) {
      if (fpValues.has(v)) {
        dupFingerprints++;
      } else {
        fpValues.add(v);
      }
    }
  }
  if (dupFingerprints === 0) {
    reporter.pass(category, "*", "no duplicate fingerprints");
  } else {
    reporter.fail(category, "*", "no duplicate fingerprints", `${dupFingerprints} duplicates`);
  }
}

export async function checkSanityT1Coverage(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/t1-coverage";

  const keys = await kvStore.keys("summary:t1:");
  if (keys.length === 0) {
    reporter.fail(category, "*", "T1 summaries exist", "no summary:t1:* keys found");
    return;
  }
  reporter.pass(category, "*", `T1 summaries exist (${keys.length})`);

  let mentionsInterface = 0;
  let mentionsEnum = 0;
  for (const key of keys) {
    const text = await kvStore.get(key);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (lower.includes("interface")) mentionsInterface++;
    if (lower.includes("enum")) mentionsEnum++;
  }

  if (mentionsInterface > 0) {
    reporter.pass(category, "*", `T1 summaries mention "interface" (${mentionsInterface})`);
  } else {
    reporter.skip(category, "*", `T1 summaries mention "interface"`, "none found — corpus may lack interfaces");
  }

  if (mentionsEnum > 0) {
    reporter.pass(category, "*", `T1 summaries mention "enum" (${mentionsEnum})`);
  } else {
    reporter.skip(category, "*", `T1 summaries mention "enum"`, "none found — corpus may lack enums");
  }
}

export async function checkSanityDrain(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/drain";

  const templateKeys = await kvStore.keys("logTemplates:");
  if (templateKeys.length === 0) {
    reporter.skip(category, "*", "log template findings", "no logTemplates:* keys");
    return;
  }

  // Strip <*> tokens and check for empty templates
  let emptyTemplates = 0;
  for (const key of templateKeys) {
    const raw = await kvStore.get(key);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    const templates = Array.isArray(parsed) ? parsed : (parsed?.templates ?? []);
    if (!Array.isArray(templates)) continue;
    for (const t of templates) {
      const tmpl = typeof t === "object" && t !== null ? (t as Record<string, unknown>)["template"] : undefined;
      if (typeof tmpl === "string") {
        const stripped = tmpl.replace(/<\*>/g, "").trim();
        if (stripped.length === 0) emptyTemplates++;
      }
    }
  }

  if (emptyTemplates === 0) {
    reporter.pass(category, "*", "no empty drain templates");
  } else {
    reporter.fail(category, "*", "no empty drain templates",
      `${emptyTemplates} findings with empty template after removing <*>`);
  }
}

export async function checkSanityAtdi(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/atdi";

  const systemRaw = await kvStore.get("atdi:system");
  if (!systemRaw) {
    reporter.fail(category, "*", "atdi:system exists", "key not found");
    return;
  }
  reporter.pass(category, "*", "atdi:system exists");

  let systemScore: unknown;
  try {
    systemScore = JSON.parse(systemRaw);
  } catch {
    reporter.fail(category, "*", "atdi:system is valid JSON", "parse error");
    return;
  }

  const score = typeof systemScore === "object" && systemScore !== null
    ? (systemScore as Record<string, unknown>)["score"]
    : systemScore;

  if (typeof score === "number" && score >= 0 && score <= 100) {
    reporter.pass(category, "*", `atdi:system score in [0,100] (${score})`);
  } else {
    reporter.fail(category, "*", "atdi:system score in [0,100]",
      `got ${JSON.stringify(score)}`);
  }

  // Per-repo scores (keys are atdi:<repoName>, exclude atdi:system)
  const repoKeys = (await kvStore.keys("atdi:")).filter(k => k !== "atdi:system");
  let outOfRange = 0;
  for (const key of repoKeys) {
    const raw = await kvStore.get(key);
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { outOfRange++; continue; }
    const repoScore = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["score"]
      : parsed;
    if (typeof repoScore !== "number" || repoScore < 0 || repoScore > 100) {
      outOfRange++;
    }
  }

  if (repoKeys.length === 0) {
    reporter.skip(category, "*", "per-repo atdi scores in [0,100]", "no atdi:repo:* keys");
  } else if (outOfRange === 0) {
    reporter.pass(category, "*", `per-repo atdi scores in [0,100] (${repoKeys.length} repos)`);
  } else {
    reporter.fail(category, "*", "per-repo atdi scores in [0,100]",
      `${outOfRange} of ${repoKeys.length} repos out of range`);
  }
}

export async function checkSanityCatalog(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/catalog";

  const raw = await kvStore.get("cross-repo:catalog");
  if (!raw) {
    reporter.skip(category, "*", "cross-repo:catalog exists", "key not found — single-repo or cross-repo disabled");
    return;
  }

  let catalog: unknown;
  try {
    catalog = JSON.parse(raw);
  } catch {
    reporter.fail(category, "*", "cross-repo:catalog parses", "invalid JSON");
    return;
  }

  const parsed = typeof catalog === "object" && catalog !== null && !Array.isArray(catalog)
    ? (catalog as Record<string, unknown>)["entries"]
    : catalog;
  const entries = Array.isArray(parsed) ? parsed : [];
  if (entries.length > 0) {
    reporter.pass(category, "*", `catalog has entries (${entries.length})`);
  } else {
    reporter.fail(category, "*", "catalog has entries", "empty array");
    return;
  }

  // Informational: at least some entries have apiSurface with endpoints
  // Catalog entries are {entry: {name, apiSurface: [...]}, repo, consumers, producers}
  const withEndpoints = entries.filter((e: unknown) => {
    if (typeof e !== "object" || e === null) return false;
    const rec = e as Record<string, unknown>;
    const entry = rec["entry"] as Record<string, unknown> | undefined;
    const api = entry?.["apiSurface"];
    return Array.isArray(api) && api.length > 0;
  }).length;

  if (withEndpoints > 0) {
    reporter.pass(category, "*", `catalog entries with apiSurface endpoints (${withEndpoints})`);
  } else {
    reporter.skip(category, "*", "catalog entries with apiSurface endpoints",
      "none found — informational");
  }
}

export async function checkSanityFeatureFlags(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/feature-flags";

  const allFlags = await getAllFindings(kvStore, "config");
  const flat = flattenFindings(allFlags);
  if (flat.length === 0) {
    reporter.skip(category, "*", "feature flag findings", "no sarif:config:* keys");
    return;
  }

  // Check for findings that look like interface declarations being flagged as implementations
  // Heuristic: message contains "interface" or name starts with "I" followed by uppercase
  const suspicious = flat.filter(({ finding }) => {
    const msg = finding.message.text.toLowerCase();
    const name = fqn(finding).split("#")[1] ?? fqn(finding);
    const looksLikeInterface =
      msg.includes("interface") ||
      /^I[A-Z]/.test(name);
    return looksLikeInterface;
  }).length;

  if (suspicious === 0) {
    reporter.pass(category, "*", "no suspicious interface-as-implementation findings");
  } else {
    reporter.pass(category, "*",
      `suspicious interface-as-implementation findings: ${suspicious} (informational)`);
  }
}

export async function checkSanityPainZoneFilter(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/pain-zone-filter";

  const allInstability = await getAllFindings(kvStore, "instability");
  const painFindings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/pain-zone-module",
  );

  if (painFindings.length === 0) {
    reporter.skip(category, "*", "pain-zone node: filter", "no pain-zone findings");
    return;
  }

  // Check that no pain-zone finding references a node: built-in in its logicalLocations
  const withNodeBuiltin = painFindings.filter(({ finding }) => {
    const locs = finding.locations ?? [];
    for (const loc of locs) {
      for (const ll of loc.logicalLocations ?? []) {
        if (ll.fullyQualifiedName?.startsWith("node:")) return true;
      }
    }
    return false;
  }).length;

  if (withNodeBuiltin === 0) {
    reporter.pass(category, "*", "pain-zone findings exclude node: builtins");
  } else {
    reporter.fail(category, "*", "pain-zone findings exclude node: builtins",
      `${withNodeBuiltin} pain-zone findings reference node: modules`);
  }
}

export async function checkSanityInstability(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/instability";

  const allInstability = await getAllFindings(kvStore, "instability");
  if (allInstability.size === 0) {
    reporter.fail(category, "*", "instability findings exist", "no sarif:instability:* keys");
    return;
  }
  reporter.pass(category, "*", `instability findings exist (${allInstability.size} repos)`);

  // pain-zone: I < 0.3 in message
  const painFindings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/pain-zone-module",
  );
  let painViolations = 0;
  for (const { finding } of painFindings) {
    const match = finding.message.text.match(/\bI=([\d.]+)/);
    if (match) {
      const i = parseFloat(match[1]!);
      if (i >= 0.3) painViolations++;
    }
  }
  if (painViolations === 0) {
    reporter.pass(category, "*", "pain-zone findings all have I < 0.3");
  } else {
    reporter.fail(category, "*", "pain-zone findings all have I < 0.3",
      `${painViolations} findings with I >= 0.3`);
  }

  // uselessness-zone: I > 0.7 in message
  const uselessFindings = flattenFindings(allInstability).filter(
    (f) => f.finding.ruleId === "structural/uselessness-zone-module",
  );
  let uselessViolations = 0;
  for (const { finding } of uselessFindings) {
    const match = finding.message.text.match(/\bI=([\d.]+)/);
    if (match) {
      const i = parseFloat(match[1]!);
      if (i <= 0.7) uselessViolations++;
    }
  }
  if (uselessViolations === 0) {
    reporter.pass(category, "*", "uselessness-zone findings all have I > 0.7");
  } else {
    reporter.fail(category, "*", "uselessness-zone findings all have I > 0.7",
      `${uselessViolations} findings with I <= 0.7`);
  }
}

// ─── Source-level sanity checks ───────────────────────────

export async function checkSanityPatternRecall(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
  mirrorsDir?: string,
): Promise<void> {
  const category = "sanity/pattern-recall";

  if (!mirrorsDir || !existsSync(mirrorsDir)) {
    reporter.skip(category, "*", "decorator recall", "no mirrors directory");
    return;
  }

  const patternKeys = await kvStore.keys("patterns:");
  const allPatterns = new Map<string, Array<{name: string; kind: string; locations: Array<{repo: string; module: string; fullyQualifiedName?: string}>}>>();
  for (const key of patternKeys) {
    const repo = key.slice("patterns:".length);
    const raw = await kvStore.get(key);
    if (raw) allPatterns.set(repo, JSON.parse(raw));
  }
  if (allPatterns.size === 0) {
    reporter.skip(category, "*", "decorator recall", "no pattern findings");
    return;
  }

  const commitCache = new Map<string, string>();
  async function getIndexedCommit(repo: string, repoDir: string): Promise<string> {
    let commit = commitCache.get(repo);
    if (!commit) {
      const stored = await kvStore.get(`commit:${repo}`);
      commit = stored ?? await getHeadCommit(repoDir);
      commitCache.set(repo, commit);
    }
    return commit;
  }

  const decoratorRe = /@(Controller|Injectable|Module|Get|Post|Put|Delete|Patch)\s*\(/g;

  for (const [repo] of allPatterns) {
    const repoDir = resolve(mirrorsDir, `${repo}.git`);
    if (!existsSync(repoDir)) {
      reporter.skip(category, repo, "decorator recall", "repo mirror not found");
      continue;
    }

    // Collect unique TS/TSX files from import edges
    const edges = await getImportEdges(graphStore, repo);
    const fileSet = new Set<string>();
    for (const e of edges) {
      if (e.source.endsWith(".ts") || e.source.endsWith(".tsx")) fileSet.add(e.source);
      if (e.target.endsWith(".ts") || e.target.endsWith(".tsx")) fileSet.add(e.target);
    }

    if (fileSet.size === 0) {
      reporter.skip(category, repo, "decorator recall", "no TS files in import edges");
      continue;
    }

    const maxFiles = Math.min(20, sampleSize);
    const sampled = sampleN([...fileSet], maxFiles, rng);

    // Build set of files appearing in pattern findings for this repo
    // Pattern entries use locations[].module, not SARIF fqn format
    const patternFindings = allPatterns.get(repo) ?? [];
    const filesInFindings = new Set<string>();
    for (const p of patternFindings) {
      for (const loc of p.locations ?? []) {
        if (loc.module) filesInFindings.add(loc.module);
      }
    }

    let filesWithDecorators = 0;
    let detectedFiles = 0;

    let commit: string | undefined;
    try {
      commit = await getIndexedCommit(repo, repoDir);
    } catch {
      reporter.skip(category, repo, "decorator recall", "could not get commit");
      continue;
    }

    for (const filePath of sampled) {
      try {
        const source = await getFileContent(repoDir, commit, filePath);
        decoratorRe.lastIndex = 0;
        const hasDecorators = decoratorRe.test(source);
        if (!hasDecorators) continue;

        filesWithDecorators++;
        if (filesInFindings.has(filePath)) {
          detectedFiles++;
          reporter.pass(category, repo, `decorator detected: ${filePath}`);
        } else {
          reporter.fail(category, repo, `decorator missed: ${filePath}`,
            "file has NestJS decorators but not in pattern findings");
        }
      } catch {
        // File may not exist at indexed commit — skip silently
      }
    }

    if (filesWithDecorators > 0) {
      reporter.pass(category, repo,
        `overall: ${detectedFiles}/${filesWithDecorators} files with decorators detected`);
    } else {
      reporter.skip(category, repo, "overall: decorator recall",
        "no files with NestJS decorators in sample");
    }
  }
}

export async function checkSanityFeatureFlagSource(
  kvStore: KVStore,
  _graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
  mirrorsDir?: string,
): Promise<void> {
  const category = "sanity/flag-source";

  if (!mirrorsDir || !existsSync(mirrorsDir)) {
    reporter.skip(category, "*", "flag source verification", "no mirrors directory");
    return;
  }

  const allFlags = await getAllFindings(kvStore, "config");
  if (allFlags.size === 0) {
    reporter.skip(category, "*", "flag source verification", "no config findings");
    return;
  }

  const commitCache = new Map<string, string>();
  async function getIndexedCommit(repo: string, repoDir: string): Promise<string> {
    let commit = commitCache.get(repo);
    if (!commit) {
      const stored = await kvStore.get(`commit:${repo}`);
      commit = stored ?? await getHeadCommit(repoDir);
      commitCache.set(repo, commit);
    }
    return commit;
  }

  const maxFindings = Math.min(10, sampleSize);

  for (const [repo, findings] of allFlags) {
    const repoDir = resolve(mirrorsDir, `${repo}.git`);
    if (!existsSync(repoDir)) {
      reporter.skip(category, repo, "flag source verification", "repo mirror not found");
      continue;
    }

    let commit: string | undefined;
    try {
      commit = await getIndexedCommit(repo, repoDir);
    } catch {
      reporter.skip(category, repo, "flag source verification", "could not get commit");
      continue;
    }

    const sampled = sampleN(findings, maxFindings, rng);
    for (const finding of sampled) {
      const filePath = fqn(finding).split("#")[0];
      if (!filePath) {
        reporter.skip(category, repo, `flag source: ${finding.message.text.slice(0, 40)}`,
          "no file path in finding");
        continue;
      }

      // Extract flag names from message text — messages like:
      //   "Flag interaction [FLAG_A, FLAG_B] has no test coverage"
      // Extract names from brackets, or fall back to first token
      const bracketMatch = finding.message.text.match(/\[([^\]]+)\]/);
      const flagNames = bracketMatch
        ? bracketMatch[1]!.split(/,\s*/).map(s => s.trim()).filter(Boolean)
        : [finding.message.text.split(/[\s:(]/)[0]?.trim() ?? ""].filter(Boolean);
      if (flagNames.length === 0) {
        reporter.skip(category, repo, `flag source: ${filePath}`, "could not extract flag names");
        continue;
      }

      try {
        const source = await getFileContent(repoDir, commit, filePath);
        const anyFound = flagNames.some(name => source.includes(name));
        if (anyFound) {
          reporter.pass(category, repo, `flag source: ${flagNames[0]} in ${filePath}`);
        } else {
          reporter.fail(category, repo, `flag source: ${flagNames[0]} in ${filePath}`,
            "flag name not found in source file");
        }
      } catch {
        reporter.skip(category, repo, `flag source: ${flagNames[0] ?? filePath} in ${filePath}`,
          "could not read source");
      }
    }
  }
}

export async function checkSanityCallGraphSource(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
  sampleSize: number,
  rng: () => number,
  mirrorsDir?: string,
): Promise<void> {
  const category = "sanity/callgraph-source";

  if (!mirrorsDir || !existsSync(mirrorsDir)) {
    reporter.skip(category, "*", "callgraph source verification", "no mirrors directory");
    return;
  }

  const allCallEdges = await graphStore.getEdgesByKind("calls");
  if (allCallEdges.length === 0) {
    reporter.skip(category, "*", "callgraph source verification", "no call edges");
    return;
  }

  // Group edges by repo (extract from edge metadata)
  const byRepo = new Map<string, GraphEdge[]>();
  for (const edge of allCallEdges) {
    const repo = edge.metadata?.["repo"];
    if (typeof repo !== "string") continue;
    let list = byRepo.get(repo);
    if (!list) { list = []; byRepo.set(repo, list); }
    list.push(edge);
  }

  if (byRepo.size === 0) {
    reporter.skip(category, "*", "callgraph source verification",
      "no call edges have repo metadata");
    return;
  }

  const commitCache = new Map<string, string>();
  async function getIndexedCommit(repo: string, repoDir: string): Promise<string> {
    let commit = commitCache.get(repo);
    if (!commit) {
      const stored = await kvStore.get(`commit:${repo}`);
      commit = stored ?? await getHeadCommit(repoDir);
      commitCache.set(repo, commit);
    }
    return commit;
  }

  const maxEdges = Math.min(10, sampleSize);
  const repos = [...byRepo.keys()];
  const sampledRepos = sampleN(repos, 3, rng);

  for (const repo of sampledRepos) {
    const repoDir = resolve(mirrorsDir, `${repo}.git`);
    if (!existsSync(repoDir)) {
      reporter.skip(category, repo, "callgraph source verification", "repo mirror not found");
      continue;
    }

    let commit: string | undefined;
    try {
      commit = await getIndexedCommit(repo, repoDir);
    } catch {
      reporter.skip(category, repo, "callgraph source verification", "could not get commit");
      continue;
    }

    const edges = byRepo.get(repo)!;
    const sampled = sampleN(edges, maxEdges, rng);

    for (const edge of sampled) {
      // source is caller file, target is callee file
      const callerPath = edge.source.includes("|") ? edge.source.split("|")[1]! : edge.source;
      const calleePath = edge.target.includes("|") ? edge.target.split("|")[1]! : edge.target;

      // Extract callee module name (basename without extension)
      const calleeParts = calleePath.replace(/\\/g, "/").split("/");
      const calleeBasename = calleeParts[calleeParts.length - 1] ?? "";
      const calleeName = calleeBasename.replace(/\.[^.]+$/, "");

      if (!calleeName) {
        reporter.skip(category, repo,
          `callgraph: ${edge.source}->${edge.target}`, "could not extract callee name");
        continue;
      }

      try {
        const callerSource = await getFileContent(repoDir, commit, callerPath);
        if (callerSource.includes(calleeName)) {
          reporter.pass(category, repo,
            `callgraph: ${callerPath} references ${calleeName}`);
        } else {
          reporter.fail(category, repo,
            `callgraph: ${callerPath} references ${calleeName}`,
            "callee name not found in caller source (loose heuristic)");
        }
      } catch {
        reporter.skip(category, repo,
          `callgraph: ${callerPath}->${calleeName}`, "could not read caller source");
      }
    }
  }
}

export async function checkSanityDashboard(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/dashboard";

  // ── 1. Repo discovery ────────────────────────────────────
  const metricsSummaryKeys = await kvStore.keys("metricsSummary:");
  const repos: string[] = metricsSummaryKeys.map((k) => k.slice("metricsSummary:".length));
  if (repos.length === 0) {
    reporter.fail(category, "*", "repos discoverable via metricsSummary:*", "no metricsSummary keys found");
    return;
  }
  reporter.pass(category, "*", `repos discoverable via metricsSummary:* (${repos.length})`);

  // ── 2. Metrics per repo ───────────────────────────────────
  let missingMetrics = 0;
  for (const repo of repos) {
    const raw = await kvStore.get(`metrics:${repo}`);
    if (!raw) { missingMetrics++; continue; }
    try { JSON.parse(raw); } catch { missingMetrics++; }
  }
  if (missingMetrics === 0) {
    reporter.pass(category, "*", `metrics:<repo> present for all repos (${repos.length})`);
  } else {
    reporter.fail(category, "*", "metrics:<repo> present for all repos",
      `${missingMetrics} of ${repos.length} repos missing metrics`);
  }

  // ── 3. Hotspots ───────────────────────────────────────────
  const hotspotKeys = await kvStore.keys("hotspots:");
  if (hotspotKeys.length === 0) {
    reporter.skip(category, "*", "hotspots data", "no hotspots:* keys — not computed");
  } else {
    let totalHotspots = 0;
    let badHotspots = 0;
    for (const key of hotspotKeys) {
      const raw = await kvStore.get(key);
      if (!raw) continue;
      let arr: unknown;
      try { arr = JSON.parse(raw); } catch { badHotspots++; continue; }
      if (!Array.isArray(arr)) { badHotspots++; continue; }
      for (const h of arr) {
        if (typeof h !== "object" || h === null ||
            typeof (h as Record<string, unknown>)["hotspotScore"] !== "number") {
          badHotspots++;
        }
      }
      totalHotspots += arr.length;
    }
    if (badHotspots === 0) {
      reporter.pass(category, "*", `hotspots data valid (${totalHotspots} total)`);
    } else {
      reporter.fail(category, "*", "hotspots data valid",
        `${badHotspots} entries missing hotspotScore`);
    }
  }

  // ── 4. Temporal coupling ──────────────────────────────────
  const tcKeys = await kvStore.keys("temporal-coupling:");
  if (tcKeys.length === 0) {
    reporter.skip(category, "*", "temporal-coupling data", "no temporal-coupling:* keys — not computed");
  } else {
    let totalPairs = 0;
    let badTc = 0;
    for (const key of tcKeys) {
      const raw = await kvStore.get(key);
      if (!raw) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { badTc++; continue; }
      if (typeof parsed !== "object" || parsed === null ||
          !Array.isArray((parsed as Record<string, unknown>)["pairs"])) {
        badTc++;
        continue;
      }
      totalPairs += ((parsed as Record<string, unknown>)["pairs"] as unknown[]).length;
    }
    if (badTc === 0) {
      reporter.pass(category, "*", `temporal-coupling data valid (${totalPairs} pairs)`);
    } else {
      reporter.fail(category, "*", "temporal-coupling data valid",
        `${badTc} keys missing pairs array`);
    }
  }

  // ── 5. Debt summaries ─────────────────────────────────────
  const debtSystemRaw = await kvStore.get("debt:system");
  if (!debtSystemRaw) {
    reporter.skip(category, "*", "debt:system exists", "not computed");
  } else {
    let debtSystemOk = false;
    try {
      const parsed = JSON.parse(debtSystemRaw) as Record<string, unknown>;
      debtSystemOk = typeof parsed["totalMinutes"] === "number";
    } catch { /* leave false */ }
    if (debtSystemOk) {
      reporter.pass(category, "*", "debt:system has numeric totalMinutes");
    } else {
      reporter.fail(category, "*", "debt:system has numeric totalMinutes", "field missing or non-numeric");
    }

    const allDebtKeys = await kvStore.keys("debt:");
    const perRepoDebtKeys = allDebtKeys.filter((k) => k !== "debt:system");
    if (perRepoDebtKeys.length > 0) {
      reporter.pass(category, "*", `per-repo debt:* keys present (${perRepoDebtKeys.length})`);
    } else {
      reporter.fail(category, "*", "per-repo debt:* keys present", "no per-repo debt keys");
    }
  }

  // ── 6. Blast radius data ──────────────────────────────────
  const blastKeys = await kvStore.keys("sarif:blastRadius:");
  if (blastKeys.length === 0) {
    reporter.skip(category, "*", "blast radius data", "no sarif:blastRadius:* keys — not computed");
  } else {
    let badBlast = 0;
    for (const key of blastKeys) {
      const raw = await kvStore.get(key);
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) badBlast++;
      } catch { badBlast++; }
    }
    if (badBlast === 0) {
      reporter.pass(category, "*", `sarif:blastRadius:* parses as arrays (${blastKeys.length} repos)`);
    } else {
      reporter.fail(category, "*", "sarif:blastRadius:* parses as arrays",
        `${badBlast} keys failed to parse as arrays`);
    }

    // Corresponding reachCounts:* should exist for the same repos
    const blastRepos = blastKeys.map((k) => k.slice("sarif:blastRadius:".length));
    let missingReach = 0;
    for (const repo of blastRepos) {
      const rc = await kvStore.get(`reachCounts:${repo}`);
      if (!rc) missingReach++;
    }
    if (missingReach === 0) {
      reporter.pass(category, "*", `reachCounts:* present for all blast-radius repos`);
    } else {
      reporter.fail(category, "*", "reachCounts:* present for all blast-radius repos",
        `${missingReach} repos missing reachCounts`);
    }
  }

  // ── 7. Cross-repo graph ───────────────────────────────────
  const corrGraphRaw = await kvStore.get("correlation:graph");
  if (!corrGraphRaw) {
    reporter.skip(category, "*", "correlation:graph exists", "not found — single-repo or cross-repo disabled");
  } else {
    let edgeCount = 0;
    let corrOk = false;
    try {
      const parsed = JSON.parse(corrGraphRaw) as Record<string, unknown>;
      if (Array.isArray(parsed["edges"])) {
        edgeCount = (parsed["edges"] as unknown[]).length;
        corrOk = true;
      }
    } catch { /* leave false */ }
    if (corrOk) {
      reporter.pass(category, "*", `correlation:graph parses with edges array (${edgeCount} edges)`);
    } else {
      reporter.fail(category, "*", "correlation:graph parses with edges array",
        "missing or non-array edges field");
    }
  }

  // ── 8. Patterns per repo ──────────────────────────────────
  const patternKeys = await kvStore.keys("patterns:");
  if (patternKeys.length === 0) {
    reporter.skip(category, "*", "patterns:* data", "no patterns:* keys — not computed");
  } else {
    let nonEmpty = 0;
    for (const key of patternKeys) {
      const raw = await kvStore.get(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
            Object.keys(parsed as object).length > 0) {
          nonEmpty++;
        } else if (Array.isArray(parsed) && (parsed as unknown[]).length > 0) {
          nonEmpty++;
        }
      } catch { /* skip */ }
    }
    reporter.pass(category, "*", `patterns:* keys with non-empty results: ${nonEmpty} of ${patternKeys.length}`);
  }

  // ── 9. Graph store edges for repos ───────────────────────
  const reposToCheck = repos.slice(0, 5);
  let missingEdges = 0;
  for (const repo of reposToCheck) {
    const edges = await graphStore.getEdgesByKind("imports", repo, { limit: 1 });
    if (edges.length === 0) missingEdges++;
  }
  if (missingEdges === 0) {
    reporter.pass(category, "*", `graph store has import edges for sampled repos (${reposToCheck.length} checked)`);
  } else {
    reporter.fail(category, "*", "graph store has import edges for sampled repos",
      `${missingEdges} of ${reposToCheck.length} repos have 0 import edges`);
  }

  // ── 10. Cross-consistency: metrics repos vs ATDI repos ───
  const atdiKeys = await kvStore.keys("atdi:");
  const atdiRepos = new Set(atdiKeys.map((k) => k.slice("atdi:".length)).filter((r) => r !== "system"));
  if (atdiRepos.size === 0) {
    reporter.skip(category, "*", "metrics/atdi repo cross-consistency", "ATDI not computed");
  } else {
    const metricsRepoSet = new Set(repos);
    const onlyInMetrics = repos.filter((r) => !atdiRepos.has(r));
    const onlyInAtdi = [...atdiRepos].filter((r) => !metricsRepoSet.has(r));
    if (onlyInMetrics.length === 0 && onlyInAtdi.length === 0) {
      reporter.pass(category, "*", `metrics and atdi repos match (${repos.length} repos)`);
    } else {
      reporter.fail(category, "*", "metrics and atdi repos match",
        `only-in-metrics: [${onlyInMetrics.join(", ")}]; only-in-atdi: [${onlyInAtdi.join(", ")}]`);
    }
  }
}

// ─── Output formatting ────────────────────────────────────

function formatTable(result: ValidateResult): string {
  const lines: string[] = [];
  lines.push("Validation Summary");
  lines.push("==================");
  lines.push("");

  // Per-rule table
  lines.push("Rule                Pass  Fail  Skip");
  lines.push("──────────────────  ────  ────  ────");
  for (const c of result.checks) {
    const rule = c.rule.padEnd(18);
    const pass = String(c.pass).padStart(4);
    const fail = String(c.fail).padStart(4);
    const skip = String(c.skip).padStart(4);
    lines.push(`${rule}  ${pass}  ${fail}  ${skip}`);
  }
  lines.push("");

  // Summary
  const { pass, fail, skip, total } = result.summary;
  lines.push(`Total: ${total}  Pass: ${pass}  Fail: ${fail}  Skip: ${skip}`);

  // Failures
  if (result.failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const f of result.failures) {
      const prefix = `  [${f.category}] ${f.repo}`;
      lines.push(`${prefix}: ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
    }
  }

  return lines.join("\n");
}

function formatMarkdown(result: ValidateResult): string {
  const lines: string[] = [];
  lines.push("## Validation Summary");
  lines.push("");

  lines.push("| Rule | Pass | Fail | Skip |");
  lines.push("|------|------|------|------|");
  for (const c of result.checks) {
    lines.push(`| ${c.rule} | ${c.pass} | ${c.fail} | ${c.skip} |`);
  }
  lines.push("");

  const { pass, fail, skip, total } = result.summary;
  lines.push(`**Total:** ${total} — Pass: ${pass}, Fail: ${fail}, Skip: ${skip}`);

  if (result.failures.length > 0) {
    lines.push("");
    lines.push("### Failures");
    lines.push("");
    lines.push("| Category | Repo | Label | Detail |");
    lines.push("|----------|------|-------|--------|");
    for (const f of result.failures) {
      lines.push(`| ${f.category} | ${f.repo} | ${f.label} | ${f.detail ?? ""} |`);
    }
  }

  return lines.join("\n");
}

// ─── Main entry point ──────────────────────────────────────

export interface ValidateOptions {
  kvStore: KVStore;
  graphStore: GraphStore;
  mirrorsDir?: string;
  sampleSize?: number;
  seed?: number;
  format?: "json" | "table" | "markdown";
  output?: string;
}

export interface ValidateResult {
  summary: { pass: number; fail: number; skip: number; total: number };
  checks: Array<{ rule: string; pass: number; fail: number; skip: number }>;
  failures: Array<{ category: string; repo: string; label: string; detail?: string }>;
}

export async function validateCommand(opts: ValidateOptions): Promise<ValidateResult> {
  const sampleSize = opts.sampleSize ?? 50;
  const seed = opts.seed ?? 42;
  const format = opts.format ?? "table";
  const rng = mulberry32(seed);
  const reporter = new ValidationReporter();

  // Reset per-run caches
  edgesCache = new Map();
  instabilityCache = new Map();

  // Run all checks
  await checkDeadExport(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkUnstableDependency(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkPainZone(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkUselessnessZone(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkFault(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkBlastRadius(opts.kvStore, opts.graphStore, reporter, sampleSize, rng);
  await checkThresholdConsistency(opts.kvStore, reporter);

  // Sanity checks (corpus-agnostic structural integrity)
  await checkSanityEdges(opts.kvStore, opts.graphStore, reporter);
  await checkSanitySarif(opts.kvStore, opts.graphStore, reporter);
  await checkSanityT1Coverage(opts.kvStore, opts.graphStore, reporter);
  await checkSanityDrain(opts.kvStore, opts.graphStore, reporter);
  await checkSanityAtdi(opts.kvStore, opts.graphStore, reporter);
  await checkSanityCatalog(opts.kvStore, opts.graphStore, reporter);
  await checkSanityFeatureFlags(opts.kvStore, opts.graphStore, reporter);
  await checkSanityPainZoneFilter(opts.kvStore, opts.graphStore, reporter);
  await checkSanityInstability(opts.kvStore, opts.graphStore, reporter);

  // Source-level sanity checks (require mirrorsDir)
  await checkSanityPatternRecall(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkSanityFeatureFlagSource(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkSanityCallGraphSource(opts.kvStore, opts.graphStore, reporter, sampleSize, rng, opts.mirrorsDir);
  await checkSanityDashboard(opts.kvStore, opts.graphStore, reporter);

  const result = reporter.toJSON();

  // Format and output
  let output: string;
  switch (format) {
    case "json":
      output = JSON.stringify(result, null, 2);
      break;
    case "markdown":
      output = formatMarkdown(result);
      break;
    default:
      output = formatTable(result);
      break;
  }

  if (opts.output) {
    await writeFile(opts.output, output + "\n", "utf-8");
  } else {
    console.log(output);
  }

  return result;
}
