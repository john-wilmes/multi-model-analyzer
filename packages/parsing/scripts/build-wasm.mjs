#!/usr/bin/env node

/**
 * Copy WASM grammar files from node_modules to packages/parsing/wasm/.
 * Idempotent -- skips files that already exist with the same size.
 *
 * Sources:
 *   web-tree-sitter       -> tree-sitter.wasm
 *   tree-sitter-typescript -> tree-sitter-typescript.wasm, tree-sitter-tsx.wasm
 *   tree-sitter-javascript -> tree-sitter-javascript.wasm
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outDir = join(__dirname, "..", "wasm");

mkdirSync(outDir, { recursive: true });

const sources = [
  {
    pkg: "web-tree-sitter",
    files: ["tree-sitter.wasm"],
  },
  {
    pkg: "tree-sitter-typescript",
    files: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
  },
  {
    pkg: "tree-sitter-javascript",
    files: ["tree-sitter-javascript.wasm"],
  },
];

let copied = 0;
let skipped = 0;
let missing = 0;

for (const { pkg, files } of sources) {
  let pkgDir;
  try {
    pkgDir = dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    console.warn(`  [build-wasm] Package ${pkg} not found -- skipping`);
    missing += files.length;
    continue;
  }

  for (const file of files) {
    const src = join(pkgDir, file);
    const dest = join(outDir, file);

    if (!existsSync(src)) {
      console.warn(`  [build-wasm] ${src} not found -- skipping`);
      missing++;
      continue;
    }

    if (existsSync(dest)) {
      const srcSize = statSync(src).size;
      const destSize = statSync(dest).size;
      if (srcSize === destSize) {
        skipped++;
        continue;
      }
    }

    copyFileSync(src, dest);
    copied++;
  }
}

console.log(`[build-wasm] ${copied} copied, ${skipped} up-to-date, ${missing} missing`);
if (missing > 0) {
  console.warn("[build-wasm] Some WASM files are missing. Grammar packages may not ship pre-built WASM.");
}

// Verify critical tree-sitter.wasm exists
const criticalWasm = join(outDir, "tree-sitter.wasm");
if (!existsSync(criticalWasm)) {
  console.error("[build-wasm] FATAL: tree-sitter.wasm not found in output directory. Build cannot proceed.");
  process.exit(1);
}
