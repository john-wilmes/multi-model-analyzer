import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { KVStore } from "@mma/storage";
import { openValidationDb, closeValidationDb } from "../helpers/db.js";
import { ValidationReporter } from "../helpers/reporter.js";
import {
  CONFIG_GROUND_TRUTH,
  CONFIG_STRUCTURAL,
} from "../ground-truth/config.ground-truth.js";

/** Extract all flag names from a SARIF results array. */
function extractFlags(results: Array<{ message: { text: string } }>): Set<string> {
  const flags = new Set<string>();
  for (const r of results) {
    const matches = r.message.text.match(/\[([A-Z_]+(?:,\s*[A-Z_]+)*)\]/g);
    if (matches) {
      for (const match of matches) {
        for (const flag of match.slice(1, -1).split(",").map((s: string) => s.trim())) {
          flags.add(flag);
        }
      }
    }
  }
  return flags;
}

describe("Config Model Validation", () => {
  let kvStore: KVStore;
  const reporter = new ValidationReporter();

  // Cache parsed SARIF per repo to avoid redundant KV reads within a describe block.
  // Tests are sequential (singleFork pool), so a module-level cache is safe.
  const sarifCache = new Map<string, Set<string> | null>();

  async function getFlagsForRepo(repo: string): Promise<Set<string> | null> {
    if (sarifCache.has(repo)) return sarifCache.get(repo)!;
    const raw = await kvStore.get(`sarif:config:${repo}`);
    if (!raw) {
      sarifCache.set(repo, null);
      return null;
    }
    const results = JSON.parse(raw) as Array<{ message: { text: string } }>;
    const flags = extractFlags(results);
    sarifCache.set(repo, flags);
    return flags;
  }

  beforeAll(() => {
    const stores = openValidationDb();
    if (!stores) throw new Error("Validation DB not found — run indexing first");
    kvStore = stores.kvStore;
  });

  afterAll(() => {
    reporter.printSummary();
    closeValidationDb();
  });

  describe("flag detection", () => {
    for (const assertion of CONFIG_GROUND_TRUTH) {
      it(`${assertion.repo}: detects ${assertion.flagName}`, async () => {
        const flags = await getFlagsForRepo(assertion.repo);
        if (!flags) {
          reporter.skip("config", assertion.repo, assertion.flagName, "no SARIF data");
          expect.soft(flags).toBeTruthy();
          return;
        }
        if (flags.has(assertion.flagName)) {
          reporter.pass("config", assertion.repo, assertion.flagName);
        } else {
          reporter.fail(
            "config",
            assertion.repo,
            assertion.flagName,
            `not found in ${flags.size} flags`,
          );
        }
        expect.soft(flags.has(assertion.flagName)).toBe(true);
      });
    }
  });

  describe("structural checks", () => {
    for (const [repo, expected] of Object.entries(CONFIG_STRUCTURAL)) {
      it(`${repo}: has >= ${expected.minFlags} unique flags`, async () => {
        const raw = await kvStore.get(`sarif:config:${repo}`);
        if (!raw) return; // skip — no data
        const results = JSON.parse(raw) as Array<{ message: { text: string } }>;
        const flags = extractFlags(results);
        expect(flags.size).toBeGreaterThanOrEqual(expected.minFlags);
      });

      it(`${repo}: has >= ${expected.minFindings} SARIF findings`, async () => {
        const raw = await kvStore.get(`sarif:config:${repo}`);
        if (!raw) return; // skip — no data
        const results = JSON.parse(raw) as unknown[];
        expect(results.length).toBeGreaterThanOrEqual(expected.minFindings);
      });
    }
  });
});
