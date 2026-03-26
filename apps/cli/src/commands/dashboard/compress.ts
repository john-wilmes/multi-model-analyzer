/**
 * compress / decompress helpers for the analysis database.
 */

import { createReadStream, createWriteStream, statSync, existsSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export async function compressCommand(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const gzPath = `${dbPath}.gz`;
  const beforeBytes = statSync(dbPath).size;

  await pipeline(createReadStream(dbPath), createGzip(), createWriteStream(gzPath));

  const afterBytes = statSync(gzPath).size;
  const ratio = ((1 - afterBytes / beforeBytes) * 100).toFixed(1);

  console.log(`Compressed: ${dbPath}`);
  console.log(`  Before: ${(beforeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  After:  ${(afterBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Ratio:  ${ratio}% reduction`);
}

// ---------------------------------------------------------------------------
// Auto-decompress helper (used by index.ts before opening stores)
// ---------------------------------------------------------------------------

export async function maybeDecompress(dbPath: string): Promise<void> {
  const gzPath = `${dbPath}.gz`;
  if (!existsSync(dbPath) && existsSync(gzPath)) {
    console.log(`Decompressing ${gzPath} → ${dbPath}`);
    await pipeline(
      createReadStream(gzPath),
      createGunzip(),
      createWriteStream(dbPath),
    );
  }
}
