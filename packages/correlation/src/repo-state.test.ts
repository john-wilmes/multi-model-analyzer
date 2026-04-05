import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import { RepoStateManager } from "./repo-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_A = {
  name: "repo-a",
  url: "https://github.com/org/repo-a",
  defaultBranch: "main",
  language: "TypeScript",
} as const;

const REPO_B = {
  name: "repo-b",
  url: "https://github.com/org/repo-b",
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RepoStateManager", () => {
  let kv: InMemoryKVStore;
  let mgr: RepoStateManager;

  beforeEach(() => {
    kv = new InMemoryKVStore();
    mgr = new RepoStateManager(kv);
  });

  // 1. Add candidates and verify state
  it("adds a candidate and returns correct initial state", async () => {
    const state = await mgr.addCandidate(REPO_A, "org-scan");

    expect(state.name).toBe("repo-a");
    expect(state.url).toBe(REPO_A.url);
    expect(state.defaultBranch).toBe("main");
    expect(state.language).toBe("TypeScript");
    expect(state.status).toBe("candidate");
    expect(state.discoveredVia).toBe("org-scan");
    expect(state.discoveredAt).toBeTruthy();
    expect(state.indexedAt).toBeUndefined();
    expect(state.ignoredAt).toBeUndefined();
    expect(state.connectionCount).toBe(0);
  });

  // 2. Full lifecycle: candidate → indexing → indexed
  it("transitions through the full indexing lifecycle", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");

    const indexing = await mgr.startIndexing("repo-a");
    expect(indexing.status).toBe("indexing");

    const indexed = await mgr.markIndexed("repo-a");
    expect(indexed.status).toBe("indexed");
    expect(indexed.indexedAt).toBeTruthy();

    // Verify persisted state matches
    const fetched = await mgr.get("repo-a");
    expect(fetched?.status).toBe("indexed");
    expect(fetched?.indexedAt).toBe(indexed.indexedAt);
  });

  // 3. Ignore from candidate state
  it("ignores a candidate repo", async () => {
    await mgr.addCandidate(REPO_B, "user-selected");
    const ignored = await mgr.markIgnored("repo-b");

    expect(ignored.status).toBe("ignored");
    expect(ignored.ignoredAt).toBeTruthy();
  });

  // 4. Ignore from indexed state
  it("ignores an already-indexed repo", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.startIndexing("repo-a");
    await mgr.markIndexed("repo-a");

    const ignored = await mgr.markIgnored("repo-a");
    expect(ignored.status).toBe("ignored");
    expect(ignored.ignoredAt).toBeTruthy();
    // Original indexedAt is preserved
    expect(ignored.indexedAt).toBeTruthy();
  });

  // 5. Unignore back to candidate
  it("unignores a repo back to candidate", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.markIgnored("repo-a");

    const reactivated = await mgr.unignore("repo-a");
    expect(reactivated.status).toBe("candidate");
    expect(reactivated.ignoredAt).toBeUndefined();
    expect(reactivated.discoveredAt).toBeTruthy();
  });

  // 6. Invalid transitions throw errors
  describe("invalid transitions", () => {
    it("throws when starting indexing on a non-candidate repo", async () => {
      await mgr.addCandidate(REPO_A, "org-scan");
      await mgr.startIndexing("repo-a");

      await expect(mgr.startIndexing("repo-a")).rejects.toThrow(
        /expected status "candidate"/,
      );
    });

    it("throws when marking indexed a non-indexing repo", async () => {
      await mgr.addCandidate(REPO_A, "org-scan");

      await expect(mgr.markIndexed("repo-a")).rejects.toThrow(
        /expected status "indexing"/,
      );
    });

    it("throws when ignoring an indexing repo", async () => {
      await mgr.addCandidate(REPO_A, "org-scan");
      await mgr.startIndexing("repo-a");

      await expect(mgr.markIgnored("repo-a")).rejects.toThrow(
        /expected status "candidate" or "indexed"/,
      );
    });

    it("throws when unignoring a non-ignored repo", async () => {
      await mgr.addCandidate(REPO_A, "org-scan");

      await expect(mgr.unignore("repo-a")).rejects.toThrow(
        /expected status "ignored"/,
      );
    });

    it("throws when operating on a non-existent repo", async () => {
      await expect(mgr.startIndexing("ghost")).rejects.toThrow(
        /not found in state store/,
      );
    });
  });

  // 7. getByStatus filtering
  it("filters repos by status", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.addCandidate(REPO_B, "org-scan");
    await mgr.startIndexing("repo-a");

    const candidates = await mgr.getByStatus("candidate");
    expect(candidates.map((r) => r.name)).toEqual(["repo-b"]);

    const indexing = await mgr.getByStatus("indexing");
    expect(indexing.map((r) => r.name)).toEqual(["repo-a"]);

    const indexed = await mgr.getByStatus("indexed");
    expect(indexed).toHaveLength(0);
  });

  // 8. summary counts
  it("returns correct summary counts", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.addCandidate(REPO_B, "org-scan");
    await mgr.startIndexing("repo-a");
    await mgr.markIndexed("repo-a");
    await mgr.markIgnored("repo-b");

    const s = await mgr.summary();
    expect(s.candidate).toBe(0);
    expect(s.indexing).toBe(0);
    expect(s.indexed).toBe(1);
    expect(s.ignored).toBe(1);
  });

  // 9. updateConnectionCount
  it("updates connection count for a repo", async () => {
    await mgr.addCandidate(REPO_A, "dependency:@org/shared");
    const updated = await mgr.updateConnectionCount("repo-a", 5);

    expect(updated.connectionCount).toBe(5);

    const fetched = await mgr.get("repo-a");
    expect(fetched?.connectionCount).toBe(5);
  });

  // 10. addCandidate is idempotent
  it("addCandidate is idempotent — does not overwrite existing state", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.startIndexing("repo-a"); // advance state

    // Adding again should return the current (indexing) state unchanged
    const second = await mgr.addCandidate(REPO_A, "user-selected");
    expect(second.status).toBe("indexing");
    expect(second.discoveredVia).toBe("org-scan"); // original discoveredVia preserved
  });

  // Bonus: getAll and remove
  it("getAll returns all tracked repos", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.addCandidate(REPO_B, "org-scan");

    const all = await mgr.getAll();
    expect(all).toHaveLength(2);
    const names = all.map((r) => r.name).sort();
    expect(names).toEqual(["repo-a", "repo-b"]);
  });

  // forceCandidate
  describe("forceCandidate", () => {
    it("resets an indexed repo back to candidate", async () => {
      await mgr.addCandidate(REPO_A, "org-scan");
      await mgr.startIndexing("repo-a");
      await mgr.markIndexed("repo-a");

      const result = await mgr.forceCandidate("repo-a");
      expect(result.status).toBe("candidate");

      const fetched = await mgr.get("repo-a");
      expect(fetched?.status).toBe("candidate");
    });

    it("resets an indexing repo back to candidate", async () => {
      await mgr.addCandidate(REPO_A, "org-scan");
      await mgr.startIndexing("repo-a");

      const result = await mgr.forceCandidate("repo-a");
      expect(result.status).toBe("candidate");
    });

    it("throws for a non-existent repo", async () => {
      await expect(mgr.forceCandidate("ghost")).rejects.toThrow(
        /not found in state store/,
      );
    });
  });

  it("remove deletes a repo from state", async () => {
    await mgr.addCandidate(REPO_A, "org-scan");
    await mgr.remove("repo-a");

    expect(await mgr.get("repo-a")).toBeUndefined();
    expect(await mgr.getAll()).toHaveLength(0);
  });
});
