#!/usr/bin/env node

import { config } from "dotenv";
config({ override: true });

/**
 * Multi-Model Analyzer CLI
 *
 * Commands:
 *   index  -- Index repositories and run analysis pipeline
 *   query  -- Query the analysis index
 */

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RepoConfig, ArchitecturalRule } from "@mma/core";
import { createStores } from "@mma/storage";
import type { StorageBackend } from "@mma/storage";
import { validateArchRules } from "@mma/heuristics";
import type { RawArchRule, Advisory } from "@mma/heuristics";
import { indexCommand } from "./commands/index-cmd.js";
import { queryCommand } from "./commands/query-cmd.js";
import { serveCommand } from "./commands/serve-cmd.js";
import { reportCommand } from "./commands/report-cmd.js";
import { practicesCommand } from "./commands/practices-cmd.js";
import { exportCommand } from "./commands/export-cmd.js";
import { mergeCommand } from "./commands/merge-cmd.js";
import { importCommand } from "./commands/import-cmd.js";
import { validateCommand } from "./commands/validate-cmd.js";
import { compressCommand, dashboardCommand, maybeDecompress } from "./commands/dashboard-cmd.js";
import { baselineCreateCommand, baselineCheckCommand } from "./commands/baseline-cmd.js";
import { deltaCommand } from "./commands/delta-cmd.js";
import { catalogCommand } from "./commands/catalog-cmd.js";
import { computeAffected } from "./commands/affected-cmd.js";
import { auditCommand } from "./commands/audit-cmd.js";
import { enrichCommand } from "./commands/enrich-cmd.js";
import { printJson, printTable, printSarif, validateFormat, validateReportFormat } from "./formatter.js";
import { parseWatchInterval, watchLoop } from "./watch.js";

interface CliConfig {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly dbPath?: string;
  readonly rules?: readonly RawArchRule[];
  readonly baselinePath?: string;
  readonly backend?: StorageBackend;
  readonly advisories?: readonly Advisory[];
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "mma.config.json" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      db: { type: "string" },
      affected: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      format: { type: "string" },
      "include-sarif": { type: "boolean", default: false },
      salt: { type: "string", default: "" },
      note: { type: "string" },
      mirrors: { type: "string" },
      "sample-size": { type: "string", default: "50" },
      seed: { type: "string", default: "42" },
      version: { type: "boolean", default: false },
      watch: { type: "boolean", short: "w", default: false },
      "watch-interval": { type: "string", default: "30" },
      raw: { type: "boolean", default: false },
      baseline: { type: "string" },
      "max-api-calls": { type: "string" },
      "force-full-reindex": { type: "boolean", default: false },
      enrich: { type: "boolean", default: false },
      "ollama-url": { type: "string" },
      "ollama-model": { type: "string" },
      port: { type: "string", default: "3000" },
      host: { type: "string", default: "127.0.0.1" },
      "cors-origin": { type: "string", multiple: true },
      backend: { type: "string" },
      transport: { type: "string" },
      "exit-code": { type: "boolean", default: false },
      repo: { type: "string" },
      "max-depth": { type: "string", default: "5" },
      "audit-file": { type: "string" },
    },
  });

  if (values.version) {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
      console.log(`mma ${pkg.version}`);
    } catch {
      console.log("mma (unknown version)");
    }
    process.exit(0);
  }

  if (values.help || positionals.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = positionals[0];
  const verbose = values.verbose;

  // Resolve DB path: --db flag > config.dbPath > default data/mma.db
  let dbPath: string;
  if (values.db) {
    dbPath = values.db === ":memory:" ? ":memory:" : resolve(values.db);
  } else if (values.config) {
    // Even for config-less commands (serve, report), honour config.dbPath
    try {
      const cfgRaw = JSON.parse(readFileSync(resolve(values.config), "utf-8"));
      if (cfgRaw.dbPath) {
        dbPath =
          cfgRaw.dbPath === ":memory:"
            ? ":memory:"
            : resolve(dirname(resolve(values.config)), cfgRaw.dbPath);
      } else {
        dbPath = resolve("data", "mma.db");
      }
    } catch {
      dbPath = resolve("data", "mma.db");
    }
  } else {
    dbPath = resolve("data", "mma.db");
  }

  // Resolve backend early for commands that don't load a config file.
  // Full validation (against config.backend) happens later for config-aware commands.
  const earlyBackend: StorageBackend =
    values.backend === "kuzu" ? "kuzu" : "sqlite";

  // serve command: reads config for mirrorDir/backend, opens writable stores for index_repo support
  if (command === "serve") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    // W25: Validate port
    const servePort = parseInt(values.port ?? "3001", 10);
    if (isNaN(servePort) || servePort < 1 || servePort > 65535) {
      console.error(`Invalid --port: "${values.port}". Must be 1–65535.`);
      process.exit(1);
    }
    // W24: Respect config.backend for serve command; also read mirrorDir for index_repo
    let serveBackend = earlyBackend;
    let serveMirrorDir = resolve("mirrors");
    if (values.config) {
      try {
        const cfgRaw = JSON.parse(readFileSync(resolve(values.config), "utf-8")) as Record<string, unknown>;
        if (cfgRaw["backend"] === "kuzu") serveBackend = "kuzu";
        if (typeof cfgRaw["mirrorDir"] === "string" && cfgRaw["mirrorDir"].trim() !== "") {
          serveMirrorDir = resolve(dirname(resolve(values.config)), cfgRaw["mirrorDir"]);
        }
      } catch { /* use defaults */ }
    }
    // Open writable stores so index_repo can persist analysis results
    const stores = await createStores({ backend: serveBackend, dbPath });
    try {
      const transport = values.transport === "http" ? "http" as const : "stdio" as const;
      await serveCommand({
        graphStore: stores.graphStore,
        searchStore: stores.searchStore,
        kvStore: stores.kvStore,
        transport,
        port: servePort,
        host: values.host,
        token: process.env["MMA_MCP_TOKEN"],
        mirrorDir: serveMirrorDir,
        indexRepo: async (repoConfig) => {
          const result = await indexCommand({
            repos: [{ name: repoConfig.name, localPath: repoConfig.localPath, url: "", branch: "" }],
            mirrorDir: serveMirrorDir,
            kvStore: stores.kvStore,
            graphStore: stores.graphStore,
            searchStore: stores.searchStore,
            verbose: false,
          });
          return {
            hadChanges: result.hadChanges,
            totalFiles: result.totalFiles,
            totalSarifResults: result.totalSarifResults,
          };
        },
      });
    } finally {
      stores.close();
    }
    return;
  }

  // affected command: compute blast radius from a revision range
  if (command === "affected") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const range = positionals[1];
    if (!range) {
      console.error("Usage: mma affected <revision-range> [--db path] [--repo name] [--max-depth N]");
      console.error("  Examples: mma affected HEAD~3..HEAD");
      console.error("           mma affected main..feature --repo my-service");
      process.exit(1);
    }
    const affectedFormat = validateFormat(values.format, "table");
    const maxDepth = parseInt(values["max-depth"] ?? "5", 10);
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      // Resolve repo path from config or use cwd
      let repoPath = process.cwd();
      try {
        const configPath = resolve(values.config);
        const configRaw = await readFile(configPath, "utf-8");
        const config = JSON.parse(configRaw) as CliConfig;
        if (config.repos[0]?.localPath) {
          repoPath = resolve(dirname(configPath), config.repos[0].localPath);
        }
      } catch { /* use cwd */ }

      const result = await computeAffected({
        repoPath,
        range,
        graphStore: stores.graphStore,
        repo: values.repo,
        maxDepth,
      });

      if (affectedFormat === "json") {
        printJson(result);
      } else if (affectedFormat === "sarif") {
        const sarifResults = result.affected.map((f) => ({
          ruleId: "affected/blast-radius",
          level: "warning" as const,
          message: `Affected file: ${f.path} (depth=${f.depth}, via ${f.via})`,
        }));
        printSarif("mma-affected", sarifResults);
      } else {
        // table (default)
        console.log(`Revision range: ${result.range}`);
        console.log(`Changed files: ${result.changed.added.length + result.changed.modified.length} (${result.changed.added.length} added, ${result.changed.modified.length} modified, ${result.changed.deleted.length} deleted)`);
        console.log(`Affected files: ${result.totalAffected}`);

        if (result.affected.length > 0) {
          const displayFiles = result.affected.slice(0, 20);
          console.log("\nAffected (by depth):");
          printTable(
            ["Depth", "Path", "Via"],
            displayFiles.map((f) => [String(f.depth), f.path, f.via]),
          );
          if (result.affected.length > 20) {
            console.log(`  ... and ${result.affected.length - 20} more`);
          }
        }

        if (result.highRisk.length > 0) {
          console.log("\nHighest-risk files (by PageRank):");
          printTable(
            ["Rank", "Path", "Score"],
            result.highRisk.map((f) => [String(f.rank), f.path, f.score.toFixed(4)]),
          );
        }
      }
    } finally {
      stores.close();
    }
    return;
  }

  // audit command: parse npm audit JSON and check transitive vulnerability reachability
  if (command === "audit") {
    const stores = await createStores({ backend: earlyBackend, dbPath });
    let auditResult: { hasFindings: boolean } = { hasFindings: false };
    try {
      auditResult = await auditCommand({
        auditFile: values["audit-file"],
        repo: values.repo,
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        verbose,
      });
    } finally {
      stores.close();
    }
    // W22: exit code 1 when --exit-code is set and findings exist
    if (values["exit-code"] && auditResult.hasFindings) {
      process.exit(1);
    }
    process.exit(0);
  }

  // enrich command: standalone LLM enrichment (Tier 3) outside of index
  if (command === "enrich") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const maxApiCalls = values["max-api-calls"] ? parseInt(values["max-api-calls"], 10) : undefined;
    if (maxApiCalls !== undefined && (isNaN(maxApiCalls) || maxApiCalls < 0)) {
      console.error(`Invalid --max-api-calls: "${values["max-api-calls"]}". Must be a non-negative integer.`);
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath });
    try {
      const result = await enrichCommand({
        kvStore: stores.kvStore,
        searchStore: stores.searchStore,
        maxApiCalls,
        repo: values.repo,
        verbose,
        ollamaUrl: values["ollama-url"],
        ollamaModel: values["ollama-model"],
      });
      console.log(`Enriched ${result.reposEnriched} repo(s): ${result.tier3Count} tier-3 summaries`);
    } finally {
      stores.close();
    }
    process.exit(0);
  }

  // export command bypasses config -- only needs the DB (read-only)
  if (command === "export") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const outputPath = values.output ?? "export.db";
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      await exportCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        output: resolve(outputPath),
        salt: values.salt ?? "",
        raw: values.raw ?? false,
      });
    } finally {
      stores.close();
    }
    return;
  }

  // merge command: combine multiple export DBs
  if (command === "merge") {
    const inputPaths = positionals.slice(1).map((p) => resolve(p));
    if (inputPaths.length === 0) {
      console.error("Usage: mma merge file1.db file2.db ... [-o merged.db]");
      process.exit(1);
    }
    const outputPath = resolve(values.output ?? "merged.db");
    try {
      await mergeCommand(inputPaths, outputPath);
    } catch (err) {
      console.error(`merge failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  // import command: import a raw export baseline into local DB
  if (command === "import") {
    const inputPath = positionals[1];
    if (!inputPath) {
      console.error("Usage: mma import <file.db> [--db path]");
      process.exit(1);
    }

    mkdirSync(dirname(dbPath), { recursive: true });
    const stores = await createStores({ backend: earlyBackend, dbPath });
    try {
      // Optionally load config for repo mismatch warnings
      let configRepos: string[] | undefined;
      try {
        const configPath = resolve(values.config);
        const configRaw = await readFile(configPath, "utf-8");
        const config = JSON.parse(configRaw) as CliConfig;
        configRepos = config.repos.map((r) => r.name);
      } catch {
        // No config available — skip mismatch warnings
      }

      await importCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        input: resolve(inputPath),
        configRepos,
        verbose,
      });
    } catch (err) {
      console.error(
        `import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      stores.close();
    }
    return;
  }

  // validate command: statistical validation of SARIF findings
  if (command === "validate") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      const valFormat = values.format as "json" | "table" | "markdown" | undefined;
      if (valFormat && !["json", "table", "markdown"].includes(valFormat)) {
        console.error(`Invalid format: "${values.format}". Must be one of: json, table, markdown`);
        process.exit(1);
      }
      const sampleSize = parseInt(values["sample-size"] ?? "50", 10);
      const seed = parseInt(values.seed ?? "42", 10);
      if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
        console.error(`Invalid --sample-size: "${values["sample-size"]}". Must be a positive integer.`);
        process.exit(1);
      }
      if (!Number.isInteger(seed)) {
        console.error(`Invalid --seed: "${values.seed}". Must be an integer.`);
        process.exit(1);
      }
      const result = await validateCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        mirrorsDir: values.mirrors,
        sampleSize,
        seed,
        format: valFormat ?? "table",
        output: values.output,
      });
      process.exit(result.summary.fail > 0 ? 1 : 0);
    } finally {
      stores.close();
    }
  }

  // baseline command: create or check a known-violations baseline
  if (command === "baseline") {
    const subcommand = positionals[1];
    if (!subcommand || !["create", "check"].includes(subcommand)) {
      console.error("Usage: mma baseline create [-o baseline.json] [--db path]");
      console.error("       mma baseline check -b baseline.json [--db path]");
      process.exit(1);
    }
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      if (subcommand === "create") {
        await baselineCreateCommand({
          kvStore: stores.kvStore,
          output: resolve(values.output ?? "baseline.json"),
        });
      } else {
        const bPath = values.baseline;
        if (!bPath) {
          console.error("Missing --baseline flag. Usage: mma baseline check --baseline baseline.json");
          process.exit(1);
        }
        const result = await baselineCheckCommand({
          kvStore: stores.kvStore,
          baselinePath: resolve(bPath),
        });
        console.log(`Current: ${result.totalCurrent} finding(s), Baseline: ${result.totalBaseline} finding(s)`);
        console.log(`New: ${result.newFindings.length}, Absent: ${result.absentFindings}`);
        if (result.newFindings.length > 0) {
          console.log("\nNew violations:");
          for (const f of result.newFindings) {
            const fqns = f.locations
              ?.flatMap((l) => l.logicalLocations?.map((ll) => ll.fullyQualifiedName) ?? [])
              .filter(Boolean)
              .join(", ") ?? "";
            console.log(`  ${f.ruleId}: ${f.message.text}${fqns ? ` (${fqns})` : ""}`);
          }
          process.exit(1);
        }
      }
    } finally {
      stores.close();
    }
    return;
  }

  // delta command: PR delta analysis — new/updated findings in a revision range
  if (command === "delta") {
    const range = positionals[1];
    if (!range) {
      console.error("Usage: mma delta <revision-range> [--db path] [--format markdown|json|sarif] [--exit-code]");
      console.error("  Examples: mma delta main..HEAD");
      console.error("           mma delta origin/main..feature");
      process.exit(1);
    }
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }

    // Validate format
    const deltaFormatRaw = values.format ?? "markdown";
    if (!["markdown", "json", "sarif"].includes(deltaFormatRaw)) {
      console.error(`Invalid format: "${deltaFormatRaw}". Must be one of: markdown, json, sarif`);
      process.exit(1);
    }
    const deltaFormat = deltaFormatRaw as "markdown" | "json" | "sarif";

    // Load config to get repo list (needed for git diff per repo)
    let deltaRepos: Array<{ name: string; localPath: string }> = [];
    try {
      const configPath = resolve(values.config);
      const configRaw = await readFile(configPath, "utf-8");
      const config = JSON.parse(configRaw) as CliConfig;
      const configDir = dirname(configPath);
      deltaRepos = config.repos.map((r) => ({
        name: r.name,
        localPath: resolve(configDir, r.localPath),
      }));
    } catch {
      // No config — use cwd as a single unnamed repo
      deltaRepos = [{ name: ".", localPath: process.cwd() }];
    }

    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      const result = await deltaCommand({
        kvStore: stores.kvStore,
        repos: deltaRepos,
        range,
        format: deltaFormat,
      });

      if (values["exit-code"] && result.hasNewOrUpdated) {
        process.exit(1);
      }
    } finally {
      stores.close();
    }
    return;
  }

  // catalog command: generate Backstage catalog-info.yaml from service catalog
  if (command === "catalog") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      await catalogCommand({
        kvStore: stores.kvStore,
        repo: values.repo,
        outputDir: values.output,
      });
    } finally {
      stores.close();
    }
    return;
  }

  // report command bypasses config -- only needs the DB (read-only)
  if (command === "report") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      const fmt = validateReportFormat(values.format, "json");
      await reportCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        output: values.output,
        format: fmt,
        includeSarif: values["include-sarif"] ?? false,
        salt: values.salt ?? "",
        note: values.note,
      });
    } finally {
      stores.close();
    }
    return;
  }

  // practices command bypasses config -- only needs the DB (read-only)
  if (command === "practices") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      const fmt = validateReportFormat(values.format, "markdown");
      await practicesCommand({
        kvStore: stores.kvStore,
        format: fmt,
        output: values.output,
      });
    } finally {
      stores.close();
    }
    return;
  }

  // compress command -- gzip data/mma.db -> data/mma.db.gz
  if (command === "compress") {
    await compressCommand(dbPath);
    return;
  }

  // dashboard command -- serve local web UI over the DB
  if (command === "dashboard") {
    await maybeDecompress(dbPath);
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const port = parseInt(values.port ?? "3000", 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid --port: "${values.port}". Must be 1–65535.`);
      process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- path.resolve/dirname are pure functions
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const staticDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "apps",
      "dashboard",
      "dist",
    );
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      const corsOriginList = values["cors-origin"];
      await dashboardCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        port,
        host: values.host ?? "127.0.0.1",
        staticDir,
        corsOrigins: corsOriginList && corsOriginList.length > 0
          ? new Set(corsOriginList)
          : undefined,
      });
    } finally {
      stores.close();
    }
    return;
  }

  // explore command -- interactive incremental indexing
  if (command === "explore") {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    // Try to get mirrorDir and backend from config; fall back to defaults
    let mirrorDir = resolve("mirrors");
    let exploreBackend = earlyBackend;
    try {
      const configPath = resolve(values.config);
      const configRaw = await readFile(configPath, "utf-8");
      const config = JSON.parse(configRaw) as CliConfig;
      if (typeof config.mirrorDir === "string" && config.mirrorDir.trim() !== "") {
        mirrorDir = resolve(dirname(configPath), config.mirrorDir);
      }
      // Honour config.backend unless --backend was explicitly passed on CLI
      if (!values.backend && config.backend) {
        exploreBackend = config.backend;
      }
    } catch { /* use defaults */ }
    const stores = await createStores({ backend: exploreBackend, dbPath });
    try {
      const { exploreCommand } = await import("./commands/index-interactive.js");
      await exploreCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        searchStore: stores.searchStore,
        mirrorDir,
        verbose,
      });
    } finally {
      stores.close();
    }
    return;
  }

  const configPath = resolve(values.config);
  let config: CliConfig;
  try {
    const raw = await readFile(configPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (jsonErr) {
      console.error(`Could not parse config file: ${configPath}`);
      console.error(`  JSON error: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
      process.exit(1);
    }
    // W23: Validate required fields
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`Config file must be a JSON object: ${configPath}`);
      process.exit(1);
    }
    const cfg = parsed as Record<string, unknown>;
    if (!Array.isArray(cfg["repos"])) {
      console.error(`Config missing required field: "repos" (must be an array)`);
      process.exit(1);
    }
    if (typeof cfg["mirrorDir"] !== "string") {
      console.error(`Config missing required field: "mirrorDir" (must be a string)`);
      process.exit(1);
    }
    // Warn on unknown top-level fields (catches typos)
    const knownFields = new Set(["repos", "mirrorDir", "dbPath", "rules", "baselinePath", "backend", "advisories"]);
    for (const key of Object.keys(cfg)) {
      if (!knownFields.has(key)) {
        console.error(`warning: unknown config field "${key}" — possible typo`);
      }
    }
    config = cfg as unknown as CliConfig;
  } catch {
    console.error(`Could not read config file: ${configPath}`);
    console.error("Create an mma.config.json with repos and mirrorDir.");
    process.exit(1);
  }

  // Resolve all paths in config relative to the config file's directory
  const configDir = dirname(configPath);
  config = {
    ...config,
    mirrorDir: resolve(configDir, config.mirrorDir),
    repos: config.repos.map((r) => ({
      ...r,
      localPath: resolve(configDir, r.localPath),
    })),
  };

  // If no --db flag was provided, check config.dbPath (resolved relative to config file)
  if (!values.db && config.dbPath) {
    dbPath = config.dbPath === ":memory:" ? ":memory:" : resolve(configDir, config.dbPath);
  }

  // Resolve backend: --backend flag > config.backend > "sqlite"
  const rawBackend = values.backend ?? config.backend ?? "sqlite";
  if (rawBackend !== "sqlite" && rawBackend !== "kuzu") {
    console.error(`Invalid --backend: "${rawBackend}". Must be "sqlite" or "kuzu".`);
    process.exit(1);
  }
  const backend: StorageBackend = rawBackend;

  // Validate architectural rules from config
  let validatedRules: ArchitecturalRule[] = [];
  if (config.rules && config.rules.length > 0) {
    const { rules, errors } = validateArchRules(config.rules);
    validatedRules = rules;
    for (const err of errors) {
      console.error(`  warning: rules[${err.ruleIndex}].${err.field}: ${err.message}`);
    }
    if (verbose && rules.length > 0) {
      console.error(`  Loaded ${rules.length} architectural rule(s)`);
    }
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const stores = await createStores({ backend, dbPath });
  const { graphStore, searchStore, kvStore } = stores;

  // Auto-import baseline on fresh DB
  if (command === "index") {
    const baselinePath = values.baseline
      ? resolve(values.baseline)
      : config.baselinePath
        ? resolve(dirname(configPath), config.baselinePath)
        : undefined;

    if (baselinePath) {
      // Check if DB already contains data
      const hasPriorData = !(await kvStore.isEmpty());

      if (!hasPriorData) {
        if (!existsSync(baselinePath)) {
          console.warn(`Warning: baseline not found: ${baselinePath} — indexing from scratch`);
        } else {
          try {
            await importCommand({
              kvStore,
              graphStore,
              input: baselinePath,
              configRepos: config.repos.map((r) => r.name),
              verbose,
            });
          } catch (err) {
            console.warn(
              `Warning: baseline import failed: ${err instanceof Error ? err.message : String(err)} — indexing from scratch`,
            );
          }
        }
      }
    }
  }

  try {
    switch (command) {
      case "index": {
        const indexFormat = validateFormat(values.format, "table");
        const maxApiCalls = values["max-api-calls"] ? parseInt(values["max-api-calls"], 10) : undefined;
        if (maxApiCalls !== undefined && (isNaN(maxApiCalls) || maxApiCalls < 0)) {
          console.error(`Invalid --max-api-calls: "${values["max-api-calls"]}". Must be a non-negative integer.`);
          process.exit(1);
        }
        const indexOpts = {
          repos: config.repos,
          mirrorDir: config.mirrorDir,
          kvStore,
          graphStore,
          searchStore,
          verbose,
          rules: validatedRules,
          affected: values.affected,
          enrich: values.enrich,
          maxApiCalls,
          forceFullReindex: values["force-full-reindex"],
          advisories: config.advisories,
          ollamaUrl: values["ollama-url"],
          ollamaModel: values["ollama-model"],
        } as const;

        if (values.watch) {
          let intervalMs: number;
          try {
            intervalMs = parseWatchInterval(values["watch-interval"]);
          } catch {
            console.error(`Invalid --watch-interval: "${values["watch-interval"]}". Must be a positive number of seconds.`);
            process.exit(1);
          }
          await watchLoop({
            indexOpts,
            intervalSeconds: intervalMs / 1000,
            runIndex: indexCommand,
          });
        } else {
          const result = await indexCommand(indexOpts);

          if (indexFormat === "json") {
            printJson(result);
          } else if (indexFormat === "sarif") {
            const sarifJson = await kvStore.get("sarif:latest");
            if (sarifJson) {
              console.log(sarifJson);
            } else {
              console.log("No SARIF data available.");
            }
          } else if (!verbose) {
            // table (default) — one-line summary when not verbose
            console.log(`Indexed ${result.repoCount} repo(s), ${result.totalFiles} files, ${result.totalSarifResults} findings`);
          }

          // W21: Exit with code 1 if any repos failed
          if (result.failedRepos > 0) {
            console.error(`${result.failedRepos} repo(s) failed to index.`);
            process.exit(1);
          }
        }
        break;
      }

      case "query": {
        const query = positionals.slice(1).join(" ");
        if (!query) {
          console.error("Usage: mma query <your question>");
          process.exit(1);
        }
        await queryCommand(query, {
          graphStore,
          searchStore,
          kvStore,
          verbose,
          format: validateFormat(values.format, "table"),
        });
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    stores.close();
  }
}

function printUsage(): void {
  console.log(`
Multi-Model Analyzer (mma)

Usage:
  mma index [-c config.json] [-v] [--affected] [--enrich] [--baseline file.db]
            [--format json|table|sarif] [--watch [-w] [--watch-interval N]]
            [--force-full-reindex]         Index repositories (default: table)
  mma query [-c config.json] "..." [--format json|table|sarif]
                                                Query the index (default: table)
  mma affected <rev-range> [--db path] [--repo name] [--max-depth N]
             [--format json|table|sarif]        Show blast radius (default: table)
  mma delta <rev-range> [-c config.json] [--db path] [--format markdown|json|sarif] [--exit-code]
                                                Show new/worsened findings for changed files (default: markdown)
  mma serve [--db path] [--transport stdio|http] [--port 3001] [--host 127.0.0.1]
                                                Start MCP server
  mma export [--db path] [-o file.db] [--salt hex] [--raw]
                                                Export SQLite DB (default: anonymized)
  mma import <file.db> [--db path] [-v]         Import raw export baseline
  mma merge file1.db file2.db ... [-o merged.db]
                                                Merge anonymized export DBs
  mma baseline create [-o baseline.json] [--db path]
                                                Snapshot findings as known-violations baseline
  mma baseline check --baseline baseline.json [--db path]
                                                Check for new violations (exit 1 if found)
  mma validate [--db path] [--mirrors dir] [--sample-size 50] [--seed 42]
               [--format json|table|markdown] [-o file]
                                                Validate SARIF findings quality
  mma report [--db path] [-o file] [--format json|table|sarif|markdown|both]
             [--include-sarif] [--salt hex] [--note "text"]
                                                Generate anonymized report (default: json)
  mma practices [--db path] [--format json|table|markdown] [-o file]
                                                Best-practices recommendations (default: markdown)
  mma catalog [--db path] [--repo name] [-o dir]
                                                Export Backstage catalog-info.yaml (default: stdout)
  mma audit [--audit-file file.json] [--repo name] [--db path] [-v]
                                                Parse npm audit JSON and check vulnerability reachability
  mma enrich [--db path] [--max-api-calls N] [--ollama-url URL] [--ollama-model M] [--repo name] [-v]
                                                Enrich summaries with Ollama (Tier 3)
  mma compress [--db path]                      Gzip the analysis database
  mma dashboard [--db path] [--port 3000] [--host 127.0.0.1]
                                                Serve local web dashboard
  mma explore [--db path] [--config path] [--backend <name>] [-v]
                                                Interactive incremental indexing (guided repo discovery)

Options:
  -c, --config    Path to config file (default: mma.config.json)
  -v, --verbose   Enable verbose output
  --db            Path to SQLite database (default: data/mma.db)
  --affected      Scope analysis to changed files and their blast radius
  -w, --watch     Re-index on a timer until interrupted
  --watch-interval  Seconds between watch cycles (default: 30)
  -o, --output    Output file path (default: report.json)
  --format        Output format (varies by command, see above)
  --include-sarif Include redacted SARIF in report
  --raw           Export without anonymization (for baseline sharing)
  --baseline      Path to raw export DB; auto-imports on fresh DB before indexing
  --salt          Hex salt for redaction hashing
  --note          Free-text note to include in report
  --mirrors       Path to bare repo mirrors (for fault validation)
  --sample-size   Findings to sample per check (default: 50)
  --seed          PRNG seed for reproducibility (default: 42)
  --port          Port for dashboard server (default: 3000)
  --host          Host/IP to bind dashboard server (default: 127.0.0.1)
  --cors-origin   Allowed CORS origin(s) for the dashboard API (repeatable, e.g. --cors-origin http://localhost:5173)
  --force-full-reindex  Clear and rebuild graph for each repo (default: incremental)
  --enrich        Enable LLM enrichment (Tier 3) via local Ollama
  --ollama-url    Custom Ollama endpoint (default: http://localhost:11434)
  --ollama-model  Custom Ollama model (default: qwen2.5-coder:1.5b)
  --backend       Storage backend: sqlite (default) or kuzu
  --transport     MCP transport: stdio (default) or http (use with serve)
  --exit-code     Exit with code 1 if new/updated findings exist (use with delta)
  --repo          Filter to a single repo (use with affected, catalog)
  --max-depth     Max blast radius depth (default: 5, use with affected)
  -h, --help      Show this help message
  --version       Show version number
`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
