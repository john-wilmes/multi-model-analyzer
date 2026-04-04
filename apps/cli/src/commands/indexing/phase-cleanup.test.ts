import { describe, it, expect, vi } from "vitest";
import { runPhaseCleanup } from "./phase-cleanup.js";
import type { ChangeSet } from "@mma/core";

function makeKVStore(entries: Map<string, string> = new Map()) {
  return {
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { entries.set(key, value); }),
    has: vi.fn(async (key: string) => entries.has(key)),
    delete: vi.fn(async (key: string) => { entries.delete(key); return true; }),
    deleteByPrefix: vi.fn(async (prefix: string) => {
      let count = 0;
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) { entries.delete(key); count++; }
      }
      return count;
    }),
    keys: vi.fn(async () => [...entries.keys()]),
    close: vi.fn(),
  };
}

function makeGraphStore() {
  return {
    addEdges: vi.fn(),
    deleteEdgesForFiles: vi.fn(),
    getEdges: vi.fn(async () => []),
    query: vi.fn(async () => []),
    close: vi.fn(),
    clear: vi.fn(),
  };
}

function makeSearchStore() {
  return {
    index: vi.fn(),
    search: vi.fn(async () => []),
    deleteByFilePaths: vi.fn(),
    close: vi.fn(),
    clear: vi.fn(),
  };
}

describe("runPhaseCleanup", () => {
  it("deletes T3 summaries for deleted files", async () => {
    const entries = new Map<string, string>([
      ["summary:t3:repo-a:src/auth.ts#AuthService.login", '{"text":"old"}'],
      ["summary:t3:repo-a:src/utils.ts#helper", '{"text":"keep"}'],
    ]);
    const kvStore = makeKVStore(entries);
    const changeSet: ChangeSet = {
      repo: "repo-a",
      commitHash: "abc",
      previousCommitHash: "def",
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: ["src/auth.ts"],
      timestamp: new Date(),
    };

    await runPhaseCleanup({
      changeSets: [changeSet],
      kvStore: kvStore as any,
      graphStore: makeGraphStore() as any,
      searchStore: makeSearchStore() as any,
      log: vi.fn(),
    });

    expect(entries.has("summary:t3:repo-a:src/auth.ts#AuthService.login")).toBe(false);
    expect(entries.has("summary:t3:repo-a:src/utils.ts#helper")).toBe(true);
  });

  it("retains T3 summaries for modified files (content-hash handles staleness)", async () => {
    const entries = new Map<string, string>([
      ["summary:t3:repo-a:src/auth.ts#AuthService.login", '{"text":"stale"}'],
      ["summary:t3:repo-a:src/auth.ts#AuthService.logout", '{"text":"also stale"}'],
      ["summary:t3:repo-a:src/utils.ts#helper", '{"text":"keep"}'],
    ]);
    const kvStore = makeKVStore(entries);
    const changeSet: ChangeSet = {
      repo: "repo-a",
      commitHash: "abc",
      previousCommitHash: "def",
      addedFiles: [],
      modifiedFiles: ["src/auth.ts"],
      deletedFiles: [],
      timestamp: new Date(),
    };

    await runPhaseCleanup({
      changeSets: [changeSet],
      kvStore: kvStore as any,
      graphStore: makeGraphStore() as any,
      searchStore: makeSearchStore() as any,
      log: vi.fn(),
    });

    // Modified-file T3 entries are no longer deleted — content-hash-addressed
    // keys in phase-summarization handle cache invalidation automatically.
    expect(entries.has("summary:t3:repo-a:src/auth.ts#AuthService.login")).toBe(true);
    expect(entries.has("summary:t3:repo-a:src/auth.ts#AuthService.logout")).toBe(true);
    expect(entries.has("summary:t3:repo-a:src/utils.ts#helper")).toBe(true);
  });

  it("does nothing when no files are modified or deleted", async () => {
    const entries = new Map<string, string>([
      ["summary:t3:repo-a:src/auth.ts#AuthService.login", '{"text":"keep"}'],
    ]);
    const kvStore = makeKVStore(entries);
    const changeSet: ChangeSet = {
      repo: "repo-a",
      commitHash: "abc",
      previousCommitHash: "def",
      addedFiles: ["src/new.ts"],
      modifiedFiles: [],
      deletedFiles: [],
      timestamp: new Date(),
    };

    await runPhaseCleanup({
      changeSets: [changeSet],
      kvStore: kvStore as any,
      graphStore: makeGraphStore() as any,
      searchStore: makeSearchStore() as any,
      log: vi.fn(),
    });

    expect(entries.has("summary:t3:repo-a:src/auth.ts#AuthService.login")).toBe(true);
    expect(kvStore.deleteByPrefix).not.toHaveBeenCalled();
  });
});
