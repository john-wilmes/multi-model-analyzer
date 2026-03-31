import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { createStores } from "@mma/storage";
import { indexCommand } from "../commands/index-cmd.js";
import { queryCommand } from "../commands/query-cmd.js";
import { serveCommand } from "../commands/serve-cmd.js";
import { reportCommand } from "../commands/report-cmd.js";
import { practicesCommand } from "../commands/practices-cmd.js";
import { exportCommand } from "../commands/export-cmd.js";
import { mergeCommand } from "../commands/merge-cmd.js";
import { importCommand } from "../commands/import-cmd.js";
import { validateCommand } from "../commands/validate-cmd.js";
import { compressCommand, dashboardCommand, maybeDecompress } from "../commands/dashboard-cmd.js";
import { baselineCreateCommand, baselineCheckCommand } from "../commands/baseline-cmd.js";
import { deltaCommand } from "../commands/delta-cmd.js";
import { catalogCommand } from "../commands/catalog-cmd.js";
import { computeAffected } from "../commands/affected-cmd.js";
import { auditCommand } from "../commands/audit-cmd.js";
import { enrichCommand } from "../commands/enrich-cmd.js";
import { printJson, printTable, printSarif, validateFormat, validateReportFormat } from "../formatter.js";
import { parseWatchInterval, watchLoop } from "../watch.js";
import { resolveDbPath, resolveEarlyBackend, loadConfig, validateCustomQueueFrameworks, validateFlagDefaults } from "./config.js";
import type { CliConfig } from "./config.js";
import type { ParsedArgs } from "./args.js";

type Values = ParsedArgs["values"];

export async function dispatchCommand(
  positionals: string[],
  values: Values,
): Promise<void> {
  const command = positionals[0];
  const verbose = values.verbose;

  const dbPath = resolveDbPath(values.db, values.config);
  const earlyBackend = resolveEarlyBackend(values.backend);

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
    let serveCustomQueueFrameworks: CliConfig["customQueueFrameworks"] | undefined;
    let serveFlagDefaults: CliConfig["flagDefaults"] | undefined;
    if (values.config && existsSync(resolve(values.config))) {
      try {
        const { readFileSync } = await import("node:fs");
        const cfgRaw = JSON.parse(readFileSync(resolve(values.config), "utf-8")) as Record<string, unknown>;
        if (cfgRaw["backend"] === "kuzu") serveBackend = "kuzu";
        if (typeof cfgRaw["mirrorDir"] === "string" && cfgRaw["mirrorDir"].trim() !== "") {
          serveMirrorDir = resolve(dirname(resolve(values.config)), cfgRaw["mirrorDir"]);
        }
        serveCustomQueueFrameworks = validateCustomQueueFrameworks(cfgRaw["customQueueFrameworks"]);
        serveFlagDefaults = validateFlagDefaults(cfgRaw["flagDefaults"]);
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
            repos: [{ name: repoConfig.name, localPath: repoConfig.localPath, url: "" }],
            mirrorDir: serveMirrorDir,
            kvStore: stores.kvStore,
            graphStore: stores.graphStore,
            searchStore: stores.searchStore,
            verbose: false,
            customQueueFrameworks: serveCustomQueueFrameworks,
            flagDefaults: serveFlagDefaults,
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
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}\nRun 'mma index' first.`);
      process.exit(1);
    }
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
        llmProvider: values["llm-provider"] as import("@mma/summarization").LlmProvider | undefined,
        llmApiKey: values["llm-api-key"],
        llmModel: values["llm-model"],
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
        localPath: r.localPath !== undefined ? resolve(configDir, r.localPath) : resolve(configDir, config.mirrorDir, `${r.name}.git`),
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
    const { resolve: pathResolve, dirname: pathDirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const staticDir = pathResolve(
      pathDirname(fileURLToPath(import.meta.url)),
      "..",
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

  // index-org command -- scan a GitHub org and index all repos in batches
  if (command === "index-org") {
    const orgName = positionals[1];
    if (!orgName) {
      console.error("Usage: mma index-org <org-name> [--mirrors dir] [--db path] [--concurrency N] [--language ts,js] [--force-full-reindex]");
      process.exit(1);
    }
    // Resolve mirrorDir and backend from config (same pattern as explore command),
    // falling back to CLI flags and defaults.
    let mirrorDir = resolve(values.mirrors ?? "mirrors");
    let orgBackend = earlyBackend;
    let orgCfg: CliConfig | undefined;
    try {
      const configPath = resolve(values.config);
      const configRaw = await readFile(configPath, "utf-8");
      const cfg = JSON.parse(configRaw) as CliConfig;
      orgCfg = cfg;
      if (!values.mirrors && typeof cfg.mirrorDir === "string" && cfg.mirrorDir.trim() !== "") {
        mirrorDir = resolve(dirname(configPath), cfg.mirrorDir);
      }
      if (!values.backend && cfg.backend) {
        orgBackend = cfg.backend;
      }
    } catch { /* use defaults */ }
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const stores = await createStores({ backend: orgBackend, dbPath });
    try {
      const { indexOrgCommand } = await import("../commands/index-org-cmd.js");
      const concurrency = parseInt(values.concurrency ?? "4", 10);
      const batchSizeVal = parseInt(values["batch-size"] ?? "20", 10);
      const languages = (values.language ?? "TypeScript,JavaScript").split(",").map((s: string) => s.trim());
      const result = await indexOrgCommand({
        org: orgName,
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        searchStore: stores.searchStore,
        mirrorDir,
        concurrency: Number.isFinite(concurrency) ? concurrency : 4,
        languages,
        force: values["force-full-reindex"] ?? false,
        verbose,
        batchSize: Number.isFinite(batchSizeVal) ? batchSizeVal : 20,
        enrich: values.enrich,
        ollamaUrl: values["ollama-url"],
        ollamaModel: values["ollama-model"],
        llmProvider: (values["llm-provider"] ?? orgCfg?.llmProvider ?? "ollama") as "anthropic" | "openai" | "ollama",
        llmApiKey: values["llm-api-key"] ?? orgCfg?.llmApiKey,
        llmModel: values["llm-model"] ?? orgCfg?.llmModel,
      });
      if (result.failedRepos.length > 0) {
        console.error(`Failed repos: ${result.failedRepos.join(", ")}`);
        process.exit(1);
      }
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
      const { exploreCommand } = await import("../commands/index-interactive.js");
      await exploreCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        searchStore: stores.searchStore,
        mirrorDir,
        verbose,
        seedUrl: values.repo,
      });
    } finally {
      stores.close();
    }
    return;
  }

  // Commands below require a full config file
  const { config, configPath, dbPath: configDbPath, backend, validatedRules } =
    await loadConfig(values.config, values.db, values.backend, verbose);

  // Use the fully resolved dbPath from loadConfig for config-requiring commands
  const resolvedDbPath = configDbPath;

  if (resolvedDbPath !== ":memory:") {
    mkdirSync(dirname(resolvedDbPath), { recursive: true });
  }
  const stores = await createStores({ backend, dbPath: resolvedDbPath });
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
          llmProvider: (values["llm-provider"] ?? config.llmProvider ?? "ollama") as "anthropic" | "openai" | "ollama",
          llmApiKey: values["llm-api-key"] ?? config.llmApiKey,
          llmModel: values["llm-model"] ?? config.llmModel,
          customQueueFrameworks: config.customQueueFrameworks,
          flagDefaults: config.flagDefaults,
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
        const { printUsage } = await import("./usage.js");
        printUsage();
        process.exit(1);
    }
  } finally {
    stores.close();
  }
}
