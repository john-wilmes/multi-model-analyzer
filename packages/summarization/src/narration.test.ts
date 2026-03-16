import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import {
  narrateSingle,
  narrateAll,
  buildRepoArchPrompt,
  buildHealthPrompt,
  buildCatalogPrompt,
  buildSystemPrompt,
  NARRATION_CACHE_PREFIX,
} from "./narration.js";
import type { RepoNarrationInput, SystemNarrationInput, NarrationOptions } from "./narration.js";

const baseRepoInput: RepoNarrationInput = {
  repo: "my-app",
  patterns: ["factory", "observer"],
  metricsSummary: {
    moduleCount: 42,
    avgInstability: 0.55,
    avgAbstractness: 0.3,
    avgDistance: 0.15,
    painZoneCount: 2,
    uselessnessZoneCount: 1,
  },
  sarifCounts: { arch: 3, fault: 1, instability: 5 },
  services: ["AuthService", "UserService"],
  serviceSummaries: ["Auth handles login/logout", "User manages profiles"],
  crossRepoEdges: 4,
};

const systemInput: SystemNarrationInput = {
  repoNames: ["my-app", "shared-lib"],
  totalFindings: 20,
  crossRepoEdgeCount: 8,
  linchpins: ["shared-lib/utils"],
};

const successResponse = {
  ok: true,
  json: async () => ({
    content: [{ type: "text", text: "This is a narration." }],
  }),
  headers: new Headers(),
};

function makeOptions(kv: InMemoryKVStore): NarrationOptions {
  return {
    apiKey: "test-key",
    kvStore: kv,
  };
}

describe("prompt builders", () => {
  it("buildRepoArchPrompt includes preamble constraint and repo data", () => {
    const prompt = buildRepoArchPrompt(baseRepoInput);
    expect(prompt).toContain("Do not make claims beyond what the data shows");
    expect(prompt).toContain("my-app");
    expect(prompt).toContain("factory, observer");
    expect(prompt).toContain("Modules: 42");
    expect(prompt).toContain("Cross-repo edges: 4");
  });

  it("buildHealthPrompt includes SARIF counts and zone info", () => {
    const prompt = buildHealthPrompt(baseRepoInput);
    expect(prompt).toContain("Do not make claims beyond what the data shows");
    expect(prompt).toContain("arch: 3");
    expect(prompt).toContain("Pain zone modules: 2");
    expect(prompt).toContain("Uselessness zone modules: 1");
  });

  it("buildCatalogPrompt includes services and summaries", () => {
    const prompt = buildCatalogPrompt(baseRepoInput);
    expect(prompt).toContain("Do not make claims beyond what the data shows");
    expect(prompt).toContain("AuthService");
    expect(prompt).toContain("Auth handles login/logout");
  });

  it("buildSystemPrompt includes system-wide data", () => {
    const prompt = buildSystemPrompt(systemInput);
    expect(prompt).toContain("Do not make claims beyond what the data shows");
    expect(prompt).toContain("my-app, shared-lib");
    expect(prompt).toContain("Total SARIF findings: 20");
    expect(prompt).toContain("shared-lib/utils");
  });
});

describe("narrateSingle", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns cached narration without calling API", async () => {
    const kv = new InMemoryKVStore();
    const key = `${NARRATION_CACHE_PREFIX}repo-arch:my-app`;
    await kv.set(key, "Cached architecture narration.");

    const result = await narrateSingle(
      "repo-architecture",
      "ignored prompt",
      key,
      makeOptions(kv),
    );

    expect(result.cached).toBe(true);
    expect(result.text).toBe("Cached architecture narration.");
    expect(result.type).toBe("repo-architecture");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("calls API on cache miss and writes result back", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      successResponse as unknown as Response,
    );

    const kv = new InMemoryKVStore();
    const key = `${NARRATION_CACHE_PREFIX}repo-arch:my-app`;

    const result = await narrateSingle(
      "repo-architecture",
      "test prompt",
      key,
      makeOptions(kv),
    );

    expect(result.cached).toBe(false);
    expect(result.text).toBe("This is a narration.");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Verify write-back
    const stored = await kv.get(key);
    expect(stored).toBe("This is a narration.");
  });

  it("propagates API errors", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as unknown as Response);

    const kv = new InMemoryKVStore();
    const key = `${NARRATION_CACHE_PREFIX}health:my-app`;

    await expect(
      narrateSingle("health-summary", "test prompt", key, makeOptions(kv)),
    ).rejects.toThrow("Anthropic API error: 500");
  });
});

describe("narrateAll", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces 3 repo narrations + 1 system narration", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      successResponse as unknown as Response,
    );

    const kv = new InMemoryKVStore();
    const results = await narrateAll([baseRepoInput], systemInput, makeOptions(kv));

    // 3 per repo (arch, health, catalog) + 1 system
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.type)).toEqual([
      "repo-architecture",
      "health-summary",
      "service-catalog",
      "system-overview",
    ]);

    // All should have been API calls (no cache)
    expect(results.every((r) => !r.cached)).toBe(true);
  });

  it("uses cache for already-narrated types", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      successResponse as unknown as Response,
    );

    const kv = new InMemoryKVStore();
    // Pre-cache the arch narration
    await kv.set(`${NARRATION_CACHE_PREFIX}repo-arch:my-app`, "Cached arch.");

    const results = await narrateAll([baseRepoInput], systemInput, makeOptions(kv));

    expect(results).toHaveLength(4);
    const arch = results.find((r) => r.type === "repo-architecture")!;
    expect(arch.cached).toBe(true);
    expect(arch.text).toBe("Cached arch.");

    // Other 3 should have called API
    const apiCalled = results.filter((r) => !r.cached);
    expect(apiCalled).toHaveLength(3);
  });

  it("continues on individual narration failure", async () => {
    let callCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500, headers: new Headers() } as unknown as Response;
      }
      return successResponse as unknown as Response;
    });

    const kv = new InMemoryKVStore();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await narrateAll([baseRepoInput], systemInput, makeOptions(kv));

    // First (repo-architecture) fails, other 3 succeed
    expect(results).toHaveLength(3);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain("[narration] Failed repo-architecture");

    errSpy.mockRestore();
  });

  it("skips system overview when systemInput is undefined", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      successResponse as unknown as Response,
    );

    const kv = new InMemoryKVStore();
    const results = await narrateAll([baseRepoInput], undefined, makeOptions(kv));

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.type !== "system-overview")).toBe(true);
  });
});
