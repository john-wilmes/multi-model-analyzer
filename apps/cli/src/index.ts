#!/usr/bin/env node

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
import type { RawArchRule } from "@mma/heuristics";
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
import { printJson, printTable, printSarif, validateFormat, validateReportFormat } from "./formatter.js";
import { parseWatchInterval, watchLoop } from "./watch.js";

interface CliConfig {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly dbPath?: string;
  readonly rules?: readonly RawArchRule[];
  readonly baselinePath?: string;
  readonly backend?: StorageBackend;
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
      "api-key": { type: "string" },
      "max-api-calls": { type: "string" },
      port: { type: "string", default: "3000" },
      backend: { type: "string" },
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

  // serve command bypasses config -- only needs the DB (read-only)
  if (command === "serve") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      await serveCommand({
        graphStore: stores.graphStore,
        searchStore: stores.searchStore,
        kvStore: stores.kvStore,
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
      console.error("Usage: mma affected <revision-range> [--db path]");
      console.error("  Examples: mma affected HEAD~3..HEAD");
      console.error("           mma affected main..feature");
      process.exit(1);
    }
    const affectedFormat = validateFormat(values.format, "table");
    const stores = await createStores({ backend: earlyBackend, dbPath, readonly: true });
    try {
      const { computeBlastRadius, computePageRank } = await import("@mma/query");
      const { parseRevisionRange, getChangedFilesInRange } = await import("@mma/ingestion");

      const parsedRange = parseRevisionRange(range);

      // Find the repo path from config (if available) or use cwd
      let repoPath = process.cwd();
      try {
        const configPath = resolve(values.config);
        const configRaw = await readFile(configPath, "utf-8");
        const config = JSON.parse(configRaw) as CliConfig;
        if (config.repos[0]?.localPath) {
          repoPath = resolve(dirname(configPath), config.repos[0].localPath);
        }
      } catch { /* use cwd */ }

      const rangeResult = await getChangedFilesInRange(repoPath, range);
      const changedFiles = [...rangeResult.added, ...rangeResult.modified];

      // Compute blast radius once for all output formats
      const blastRoots = [...changedFiles, ...rangeResult.deleted];
      const blastResult = blastRoots.length > 0
        ? await computeBlastRadius(blastRoots, stores.graphStore, { maxDepth: 5 })
        : { totalAffected: 0, affectedFiles: [] as Array<{ path: string; depth: number; via: string }> };

      // Compute PageRank for json and table formats
      let highRisk: Array<{ path: string; rank: number; score: number }> = [];
      if (affectedFormat !== "sarif") {
        const allEdges = await stores.graphStore.getEdgesByKind("imports");
        if (allEdges.length > 0) {
          const prResult = computePageRank(allEdges);
          const impacted = new Set([...changedFiles, ...blastResult.affectedFiles.map(f => f.path)]);
          highRisk = prResult.ranked.filter(f => impacted.has(f.path)).slice(0, 10);
        }
      }

      if (affectedFormat === "json") {
        printJson({
          range: `${parsedRange.from}..${parsedRange.to}`,
          changed: { added: rangeResult.added, modified: rangeResult.modified, deleted: rangeResult.deleted },
          affected: blastResult.affectedFiles,
          totalAffected: blastResult.totalAffected,
          highRisk,
        });
      } else if (affectedFormat === "sarif") {
        const sarifResults = blastResult.affectedFiles.map((f) => ({
          ruleId: "affected/blast-radius",
          level: "warning" as const,
          message: `Affected file: ${f.path} (depth=${f.depth}, via ${f.via})`,
        }));
        printSarif("mma-affected", sarifResults);
      } else {
        // table (default)
        console.log(`Revision range: ${parsedRange.from}..${parsedRange.to}`);
        console.log(`Changed files: ${changedFiles.length} (${rangeResult.added.length} added, ${rangeResult.modified.length} modified, ${rangeResult.deleted.length} deleted)`);
        console.log(`Affected files: ${blastResult.totalAffected}`);

        if (blastResult.affectedFiles.length > 0) {
          const displayFiles = blastResult.affectedFiles.slice(0, 20);
          console.log("\nAffected (by depth):");
          printTable(
            ["Depth", "Path", "Via"],
            displayFiles.map((f) => [String(f.depth), f.path, f.via]),
          );
          if (blastResult.affectedFiles.length > 20) {
            console.log(`  ... and ${blastResult.affectedFiles.length - 20} more`);
          }
        }

        if (highRisk.length > 0) {
          console.log("\nHighest-risk files (by PageRank):");
          printTable(
            ["Rank", "Path", "Score"],
            highRisk.map((f) => [String(f.rank), f.path, f.score.toFixed(4)]),
          );
        }
      }
    } finally {
      stores.close();
    }
    return;
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
      await dashboardCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        port,
        staticDir,
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
    config = JSON.parse(raw) as CliConfig;
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
        const anthropicApiKey = values["api-key"] || process.env.ANTHROPIC_API_KEY;
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
          anthropicApiKey,
          maxApiCalls,
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
  mma index [-c config.json] [-v] [--affected] [--baseline file.db]
            [--format json|table|sarif] [--watch [-w] [--watch-interval N]]
                                                Index repositories (default: table)
  mma query [-c config.json] "..." [--format json|table|sarif]
                                                Query the index (default: table)
  mma affected <rev-range> [--db path] [--format json|table|sarif]
                                                Show blast radius (default: table)
  mma serve [--db path/to/mma.db]               Start MCP server (stdio)
  mma export [--db path] [-o file.db] [--salt hex] [--raw]
                                                Export SQLite DB (default: anonymized)
  mma import <file.db> [--db path] [-v]         Import raw export baseline
  mma merge file1.db file2.db ... [-o merged.db]
                                                Merge anonymized export DBs
  mma validate [--db path] [--mirrors dir] [--sample-size 50] [--seed 42]
               [--format json|table|markdown] [-o file]
                                                Validate SARIF findings quality
  mma report [--db path] [-o file] [--format json|table|sarif|markdown|both]
             [--include-sarif] [--salt hex] [--note "text"]
                                                Generate anonymized report (default: json)
  mma practices [--db path] [--format json|table|markdown] [-o file]
                                                Best-practices recommendations (default: markdown)
  mma compress [--db path]                      Gzip the analysis database
  mma dashboard [--db path] [--port 3000]       Serve local web dashboard

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
  --backend       Storage backend: sqlite (default) or kuzu
  -h, --help      Show this help message
  --version       Show version number
`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
