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
import { createSqliteStores } from "@mma/storage";
import type { SqliteStores } from "@mma/storage";
import { validateArchRules } from "@mma/heuristics";
import type { RawArchRule } from "@mma/heuristics";
import { indexCommand } from "./commands/index-cmd.js";
import { queryCommand } from "./commands/query-cmd.js";
import { serveCommand } from "./commands/serve-cmd.js";
import { reportCommand } from "./commands/report-cmd.js";
import { practicesCommand } from "./commands/practices-cmd.js";
import { exportCommand } from "./commands/export-cmd.js";
import { mergeCommand } from "./commands/merge-cmd.js";
import { printJson, printTable, printSarif, validateFormat, validateReportFormat } from "./formatter.js";
import { parseWatchInterval, watchLoop } from "./watch.js";

interface CliConfig {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly dbPath?: string;
  readonly rules?: readonly RawArchRule[];
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
      version: { type: "boolean", default: false },
      watch: { type: "boolean", short: "w", default: false },
      "watch-interval": { type: "string", default: "30" },
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
  // For config-less commands (serve, report), config.dbPath is not available
  let dbPath: string;
  if (values.db) {
    dbPath = values.db === ":memory:" ? ":memory:" : resolve(values.db);
  } else {
    dbPath = resolve("data", "mma.db");
  }

  // serve command bypasses config -- only needs the DB (read-only)
  if (command === "serve") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = createSqliteStores({ dbPath, readonly: true });
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
    const stores = createSqliteStores({ dbPath, readonly: true });
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
    const stores = createSqliteStores({ dbPath, readonly: true });
    try {
      await exportCommand({
        kvStore: stores.kvStore,
        graphStore: stores.graphStore,
        output: resolve(outputPath),
        salt: values.salt ?? "",
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

  // report command bypasses config -- only needs the DB (read-only)
  if (command === "report") {
    if (!existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      console.error("Run 'mma index' first to create the analysis database.");
      process.exit(1);
    }
    const stores = createSqliteStores({ dbPath, readonly: true });
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
    const stores = createSqliteStores({ dbPath, readonly: true });
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

  mkdirSync(dirname(dbPath), { recursive: true });

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

  // If no --db flag was provided, check config.dbPath (resolved relative to config file)
  if (!values.db && config.dbPath) {
    dbPath = config.dbPath === ":memory:" ? ":memory:" : resolve(dirname(configPath), config.dbPath);
  }

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

  const stores: SqliteStores = createSqliteStores({ dbPath });
  const { graphStore, searchStore, kvStore } = stores;

  try {
    switch (command) {
      case "index": {
        const indexFormat = validateFormat(values.format, "table");
        const indexOpts = {
          repos: config.repos,
          mirrorDir: config.mirrorDir,
          kvStore,
          graphStore,
          searchStore,
          verbose,
          rules: validatedRules,
          affected: values.affected,
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
  mma index [-c config.json] [-v] [--affected] [--format json|table|sarif]
            [--watch [-w] [--watch-interval N]]
                                                Index repositories (default: table)
  mma query [-c config.json] "..." [--format json|table|sarif]
                                                Query the index (default: table)
  mma affected <rev-range> [--db path] [--format json|table|sarif]
                                                Show blast radius (default: table)
  mma serve [--db path/to/mma.db]               Start MCP server (stdio)
  mma export [--db path] [-o file.db] [--salt hex]
                                                Export anonymized SQLite DB
  mma merge file1.db file2.db ... [-o merged.db]
                                                Merge anonymized export DBs
  mma report [--db path] [-o file] [--format json|table|sarif|markdown|both]
             [--include-sarif] [--salt hex] [--note "text"]
                                                Generate anonymized report (default: json)
  mma practices [--db path] [--format json|table|markdown] [-o file]
                                                Best-practices recommendations (default: markdown)

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
  --salt          Hex salt for redaction hashing
  --note          Free-text note to include in report
  -h, --help      Show this help message
  --version       Show version number
`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
