import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KVStore, GraphStore } from "@mma/storage";
import { computePageRank } from "@mma/query";
import { getFileContent, getHeadCommit } from "@mma/ingestion";
import { sampleN } from "./sampling.js";
import { getAllFindings, flattenFindings, fqn } from "./sarif-helpers.js";
import { getImportEdges, getInstability } from "./instability.js";
import { isBarrelFile } from "./barrel-detection.js";
import type { ValidationReporter } from "./reporter.js";

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

      // Skip barrel files as dependency targets — matches the exclusion in
      // detectInstabilityViolations() in packages/structural/src/metrics.ts
      if (isBarrelFile(edge.target)) continue;

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
        // Filter to internal nodes only (repo:path format) — external packages
        // like lodash/jayson are excluded from pageRankToSarif findings, so they
        // must be excluded from the validation baseline too.
        const repoPrefix = `${repo}:`;
        const internalRanked = prResult.ranked.filter((r) => r.path.startsWith(repoPrefix));
        top10 = new Set(internalRanked.slice(0, 10).map((r) => r.path));
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
    // Filter to internal nodes (repo:path format) — external packages like
    // lodash/jayson are excluded from pageRankToSarif findings.
    const repoPrefix = `${repo}:`;
    const internalRanked = prResult.ranked.filter((r) => r.path.startsWith(repoPrefix));
    // pageRankToSarif() also filters out nodes below a score threshold; align recall check
    const top10 = internalRanked.slice(0, 10).filter((r) => r.score > 0.03);

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
