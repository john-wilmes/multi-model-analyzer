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
import { mkdirSync, existsSync } from "node:fs";
import type { RepoConfig } from "@mma/core";
import { createSqliteStores } from "@mma/storage";
import type { SqliteStores } from "@mma/storage";
import { indexCommand } from "./commands/index-cmd.js";
import { queryCommand } from "./commands/query-cmd.js";
import { serveCommand } from "./commands/serve-cmd.js";

interface CliConfig {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "mma.config.json" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      db: { type: "string" },
    },
  });

  if (values.help || positionals.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = positionals[0];
  const verbose = values.verbose;

  // Resolve DB path (--db flag or default data/mma.db)
  const dbPath = values.db ? resolve(values.db) : resolve("data", "mma.db");

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

  const stores: SqliteStores = createSqliteStores({ dbPath });
  const { graphStore, searchStore, kvStore } = stores;

  try {
    switch (command) {
      case "index":
        await indexCommand({
          repos: config.repos,
          mirrorDir: config.mirrorDir,
          kvStore,
          graphStore,
          searchStore,
          verbose,
        });
        break;

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
  mma index [-c config.json] [-v]    Index repositories
  mma query [-c config.json] "..."   Query the index
  mma serve [--db path/to/mma.db]    Start MCP server (stdio)

Options:
  -c, --config  Path to config file (default: mma.config.json)
  -v, --verbose Enable verbose output
  --db          Path to SQLite database (default: data/mma.db)
  -h, --help    Show this help message
`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
