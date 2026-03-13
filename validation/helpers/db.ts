import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSqliteStores, type SqliteStores } from "@mma/storage";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const DB_PATH = resolve(PROJECT_ROOT, "data/mma.db");

let stores: SqliteStores | null = null;

/**
 * Open the validation database in read-only mode.
 * Returns null if the DB file doesn't exist (allows graceful skip).
 */
export function openValidationDb(): SqliteStores | null {
  if (stores) return stores;
  if (!existsSync(DB_PATH)) return null;
  stores = createSqliteStores({ dbPath: DB_PATH, readonly: true });
  return stores;
}

export function closeValidationDb(): void {
  if (stores) {
    stores.close();
    stores = null;
  }
}
