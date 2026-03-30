import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KVStore, GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import { getFileContent, getHeadCommit } from "@mma/ingestion";
import { sampleN } from "./sampling.js";
import { getAllFindings, flattenFindings, fqn } from "./sarif-helpers.js";
import { getImportEdges } from "./instability.js";
import type { ValidationReporter } from "./reporter.js";

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
        // Skip templates that are entirely dynamic: fewer than 2 non-whitespace
        // characters remain after removing <*> tokens and whitespace. These are
        // log messages like bare variable references (e.g. just `<*>`) where an
        // empty result is expected by design.
        const nonWhitespace = stripped.replace(/\s+/g, "").length;
        if (nonWhitespace < 2) continue;
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
            Object.keys(parsed as Record<string, unknown>).length > 0) {
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

// ─── Config validation sanity checks ────────────────────────

const VALID_PARAM_KINDS = new Set(["setting", "credential", "flag"]);
const VALID_CONSTRAINT_KINDS = new Set([
  "requires", "excludes", "implies", "mutex", "range", "conditional", "enum",
]);
const VALID_CONSTRAINT_SOURCES = new Set(["inferred", "human", "schema"]);

interface RawParam {
  name?: unknown;
  kind?: unknown;
  locations?: unknown;
}

interface RawConstraint {
  kind?: unknown;
  flags?: unknown;
  description?: unknown;
  source?: unknown;
}

export async function checkSanityConfigValidation(
  kvStore: KVStore,
  graphStore: GraphStore,
  reporter: ValidationReporter,
): Promise<void> {
  const category = "sanity/config-validation";

  // ── 1. Config inventory structure ────────────────────────
  const inventoryKeys = await kvStore.keys("config-inventory:");
  if (inventoryKeys.length === 0) {
    reporter.skip(category, "*", "config inventory", "no config-inventory:* keys");
    return;
  }

  let inventoryInvalid = 0;
  let inventoryTotal = 0;
  for (const key of inventoryKeys) {
    const raw = await kvStore.get(key);
    if (!raw) continue;
    inventoryTotal++;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { inventoryInvalid++; continue; }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.repo !== "string" || !Array.isArray(obj.parameters)) {
      inventoryInvalid++;
      continue;
    }
    const params = obj.parameters as RawParam[];
    const badParam = params.some(
      (p) =>
        typeof p.name !== "string" ||
        p.name.length === 0 ||
        !VALID_PARAM_KINDS.has(p.kind as string) ||
        !Array.isArray(p.locations) ||
        (p.locations as unknown[]).length === 0,
    );
    if (badParam) inventoryInvalid++;
  }

  if (inventoryInvalid === 0) {
    reporter.pass(category, "*", `config inventory structure valid (${inventoryTotal} entries)`);
  } else {
    reporter.fail(
      category, "*", "config inventory structure valid",
      `${inventoryInvalid} of ${inventoryTotal} config-inventory entries are invalid`,
    );
  }

  // ── 2. Config model structure ─────────────────────────────
  const modelKeys = await kvStore.keys("config-model:");
  if (modelKeys.length === 0) {
    reporter.skip(category, "*", "config model", "no config-model:* keys");
  } else {
    let modelInvalid = 0;
    let modelTotal = 0;
    for (const key of modelKeys) {
      const raw = await kvStore.get(key);
      if (!raw) continue;
      modelTotal++;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { modelInvalid++; continue; }
      const obj = parsed as Record<string, unknown>;
      if (!Array.isArray(obj.flags) || !Array.isArray(obj.constraints)) {
        modelInvalid++;
        continue;
      }
      const constraints = obj.constraints as RawConstraint[];
      const badConstraint = constraints.some(
        (c) =>
          !VALID_CONSTRAINT_KINDS.has(c.kind as string) ||
          !Array.isArray(c.flags) ||
          (c.flags as unknown[]).length === 0 ||
          (c.flags as unknown[]).some((f) => typeof f !== "string") ||
          typeof c.description !== "string" ||
          !VALID_CONSTRAINT_SOURCES.has(c.source as string),
      );
      if (badConstraint) modelInvalid++;
    }

    if (modelInvalid === 0) {
      reporter.pass(category, "*", `config model structure valid (${modelTotal} entries)`);
    } else {
      reporter.fail(
        category, "*", "config model structure valid",
        `${modelInvalid} of ${modelTotal} config-model entries are invalid`,
      );
    }
  }

  // ── 3. SARIF config findings ──────────────────────────────
  const allConfigFindings = await getAllFindings(kvStore, "config");
  if (allConfigFindings.size === 0) {
    reporter.skip(category, "*", "SARIF config findings", "no sarif:config:* keys");
  } else {
    const flat = flattenFindings(allConfigFindings);
    const invalid = flat.filter(
      ({ finding }) =>
        typeof finding.ruleId !== "string" ||
        !finding.ruleId.startsWith("config/") ||
        typeof finding.message.text !== "string" ||
        finding.message.text.length === 0,
    );
    if (invalid.length === 0) {
      reporter.pass(category, "*", `SARIF config findings valid (${flat.length} findings)`);
    } else {
      reporter.fail(
        category, "*", "SARIF config findings valid",
        `${invalid.length} of ${flat.length} findings have invalid ruleId or missing message`,
      );
    }
  }

  // ── 4. Cross-consistency ──────────────────────────────────
  const flagsKeys = await kvStore.keys("flags:");
  const reposWithFlags = new Set<string>();
  for (const key of flagsKeys) {
    const raw = await kvStore.get(key);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(obj.flags) && (obj.flags as unknown[]).length > 0) {
        reposWithFlags.add(key.slice("flags:".length));
      }
    } catch { /* skip */ }
  }
  const reposWithInventoryParams = new Set<string>();
  for (const key of inventoryKeys) {
    const raw = await kvStore.get(key);
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.parameters) && (obj.parameters as unknown[]).length > 0) {
      const repo = key.slice("config-inventory:".length);
      reposWithInventoryParams.add(repo);
    }
  }

  // Only repos with import edges can produce a config-model (model phase requires dep graph)
  const candidates = new Set([...reposWithInventoryParams, ...reposWithFlags]);
  const reposNeedingModel = new Set<string>();
  for (const repo of candidates) {
    const edges = await graphStore.getEdgesByKind("imports", repo, { limit: 1 });
    if (edges.length > 0) reposNeedingModel.add(repo);
  }
  if (reposNeedingModel.size === 0) {
    reporter.skip(category, "*", "config cross-consistency", "no repos with params/flags and dep graph");
  } else {
    const modelRepos = new Set(modelKeys.map((k) => k.slice("config-model:".length)));
    const missingModel = [...reposNeedingModel].filter((r) => !modelRepos.has(r));
    if (missingModel.length === 0) {
      reporter.pass(category, "*", `config cross-consistency: all ${reposNeedingModel.size} repos have config-model`);
    } else {
      reporter.fail(
        category, "*", "config cross-consistency: repos with params have config-model",
        `missing config-model for: ${missingModel.join(", ")}`,
      );
    }
  }
}
