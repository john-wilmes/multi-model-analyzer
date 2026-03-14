/**
 * Tests for SARIF storage helpers: per-repo reads with fallback to sarif:latest.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKVStore } from "./kv.js";
import { getSarifResultsForRepo, getSarifResultsPaginated } from "./sarif-helpers.js";

function makeSarifResult(ruleId: string, repo: string, level = "warning") {
  return {
    ruleId,
    level,
    message: { text: `Finding for ${ruleId}` },
    locations: [{
      logicalLocations: [{
        fullyQualifiedName: `${repo}/src/file.ts`,
        properties: { repo },
      }],
    }],
  };
}

describe("SARIF helpers", () => {
  let kvStore: InMemoryKVStore;

  beforeEach(() => {
    kvStore = new InMemoryKVStore();
  });

  describe("getSarifResultsForRepo", () => {
    it("reads from per-repo key when available", async () => {
      const results = [makeSarifResult("arch/circular-dep", "myrepo")];
      await kvStore.set("sarif:repo:myrepo", JSON.stringify(results));

      const got = await getSarifResultsForRepo(kvStore, "myrepo");
      expect(got).toHaveLength(1);
      expect(got[0]!.ruleId).toBe("arch/circular-dep");
    });

    it("falls back to sarif:latest when per-repo key missing", async () => {
      const sarifLog = {
        runs: [{
          results: [
            makeSarifResult("arch/circular-dep", "myrepo"),
            makeSarifResult("fault/unhandled", "other"),
          ],
        }],
      };
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      const got = await getSarifResultsForRepo(kvStore, "myrepo");
      expect(got).toHaveLength(1);
      expect(got[0]!.ruleId).toBe("arch/circular-dep");
    });

    it("returns empty array when nothing exists", async () => {
      const got = await getSarifResultsForRepo(kvStore, "nonexistent");
      expect(got).toEqual([]);
    });
  });

  describe("getSarifResultsPaginated", () => {
    it("paginates per-repo results", async () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        makeSarifResult(`rule-${i}`, "myrepo"),
      );
      await kvStore.set("sarif:repo:myrepo", JSON.stringify(results));

      const page = await getSarifResultsPaginated(kvStore, {
        repo: "myrepo",
        limit: 3,
        offset: 2,
      });
      expect(page.total).toBe(10);
      expect(page.results).toHaveLength(3);
      expect(page.results[0]!.ruleId).toBe("rule-2");
    });

    it("filters by level", async () => {
      const results = [
        makeSarifResult("r1", "myrepo", "error"),
        makeSarifResult("r2", "myrepo", "warning"),
        makeSarifResult("r3", "myrepo", "error"),
      ];
      await kvStore.set("sarif:repo:myrepo", JSON.stringify(results));

      const page = await getSarifResultsPaginated(kvStore, {
        repo: "myrepo",
        level: "error",
      });
      expect(page.total).toBe(2);
    });

    it("filters by ruleId", async () => {
      const results = [
        makeSarifResult("arch/circular", "myrepo"),
        makeSarifResult("fault/unhandled", "myrepo"),
      ];
      await kvStore.set("sarif:repo:myrepo", JSON.stringify(results));

      const page = await getSarifResultsPaginated(kvStore, {
        repo: "myrepo",
        ruleId: "arch/circular",
      });
      expect(page.total).toBe(1);
    });

    it("uses index to read all repos when no repo filter", async () => {
      await kvStore.set("sarif:repo:r1", JSON.stringify([
        makeSarifResult("rule-a", "r1"),
      ]));
      await kvStore.set("sarif:repo:r2", JSON.stringify([
        makeSarifResult("rule-b", "r2"),
        makeSarifResult("rule-c", "r2"),
      ]));
      await kvStore.set("sarif:latest:index", JSON.stringify({
        repos: ["r1", "r2"],
        totalResults: 3,
        timestamp: new Date().toISOString(),
      }));

      const page = await getSarifResultsPaginated(kvStore, { limit: 50 });
      expect(page.total).toBe(3);
      expect(page.results).toHaveLength(3);
    });

    it("falls back to sarif:latest when no index exists", async () => {
      const sarifLog = {
        runs: [{ results: [makeSarifResult("r1", "repo1")] }],
      };
      await kvStore.set("sarif:latest", JSON.stringify(sarifLog));

      const page = await getSarifResultsPaginated(kvStore, {});
      expect(page.total).toBe(1);
    });
  });
});
