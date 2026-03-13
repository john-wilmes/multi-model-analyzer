import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { KVStore } from "@mma/storage";
import { openValidationDb, closeValidationDb } from "../helpers/db.js";
import { ValidationReporter } from "../helpers/reporter.js";
import {
  FUNCTIONAL_GROUND_TRUTH,
  FUNCTIONAL_STRUCTURAL,
} from "../ground-truth/functional.ground-truth.js";

/** Count `## ` headings in a markdown string (each represents one service). */
function countServiceHeadings(markdown: string): number {
  return (markdown.match(/^## /gm) ?? []).length;
}

describe("Functional Model Validation", () => {
  let kvStore: KVStore;
  const reporter = new ValidationReporter();

  beforeAll(() => {
    const stores = openValidationDb();
    if (!stores) throw new Error("Validation DB not found — run indexing first");
    kvStore = stores.kvStore;
  });

  afterAll(() => {
    reporter.printSummary();
    closeValidationDb();
  });

  describe("service detection", () => {
    // Group by repo so we can cache doc reads.
    const byRepo = new Map<string, typeof FUNCTIONAL_GROUND_TRUTH>();
    for (const assertion of FUNCTIONAL_GROUND_TRUTH) {
      const list = byRepo.get(assertion.repo) ?? [];
      list.push(assertion);
      byRepo.set(assertion.repo, list);
    }

    for (const [repo, assertions] of byRepo) {
      describe(repo, () => {
        let doc: string | null = null;

        beforeAll(async () => {
          const raw = await kvStore.get(`docs:functional:${repo}`);
          doc = raw ?? null;
        });

        for (const assertion of assertions) {
          it(`contains service "${assertion.serviceNameSubstring}"`, () => {
            if (!doc) {
              reporter.skip(
                "functional",
                repo,
                assertion.serviceNameSubstring,
                "no functional doc",
              );
              expect.soft(doc).toBeTruthy();
              return;
            }
            const found = doc
              .toLowerCase()
              .includes(assertion.serviceNameSubstring.toLowerCase());
            if (found) {
              reporter.pass("functional", repo, assertion.serviceNameSubstring);
            } else {
              reporter.fail(
                "functional",
                repo,
                assertion.serviceNameSubstring,
                `not found in ${doc.length}-char document`,
              );
            }
            expect.soft(found).toBe(true);
          });
        }
      });
    }
  });

  describe("structural checks", () => {
    for (const [repo, expected] of Object.entries(FUNCTIONAL_STRUCTURAL)) {
      it(`${repo}: has >= ${expected.minServices} service headings`, async () => {
        const raw = await kvStore.get(`docs:functional:${repo}`);
        if (!raw) return; // skip — no data
        const count = countServiceHeadings(raw);
        expect(count).toBeGreaterThanOrEqual(expected.minServices);
      });

      it(`${repo}: doc has >= ${expected.minDocChars} characters`, async () => {
        const raw = await kvStore.get(`docs:functional:${repo}`);
        if (!raw) return; // skip — no data
        expect(raw.length).toBeGreaterThanOrEqual(expected.minDocChars);
      });
    }
  });
});
