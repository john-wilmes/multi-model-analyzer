#!/usr/bin/env node

import { config } from "dotenv";
config({ override: true, quiet: true });

/**
 * Multi-Model Analyzer CLI
 *
 * Commands:
 *   index  -- Index repositories and run analysis pipeline
 *   query  -- Query the analysis index
 *
 * Modules: cli/args.ts  cli/usage.ts  cli/dispatch.ts  cli/config.ts
 */

import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "./cli/args.js";
import { printUsage } from "./cli/usage.js";
import { dispatchCommand } from "./cli/dispatch.js";

async function main(): Promise<void> {
  const { positionals, values } = parseCliArgs();

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

  await dispatchCommand(positionals, values);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
