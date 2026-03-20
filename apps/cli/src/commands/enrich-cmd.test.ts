import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryKVStore, InMemorySearchStore } from "@mma/storage";
import type { Summary, ServiceCatalogEntry } from "@mma/core";
import { enrichCommand } from "./enrich-cmd.js";

// ---------------------------------------------------------------------------
// Mock @mma/summarization — isolate enrich-cmd from real LLM calls
// ---------------------------------------------------------------------------

vi.mock("@mma/summarization", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mma/summarization")>();
  return {
    ...real,
    // shouldEscalateToTier3 uses real implementation so the tests exercise
    // the actual escalation logic based on confidence values.
    tier3BatchSummarize: vi.fn(async () => []),
    tier4BatchSummarize: vi.fn(async () => ({ summaries: [], apiCallsMade: 0 })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStores() {
  return {
    kvStore: new InMemoryKVStore(),
    searchStore: new InMemorySearchStore(),
  };
}

function makeOptions(
  overrides: Partial<Parameters<typeof enrichCommand>[0]> = {},
): Parameters<typeof enrichCommand>[0] {
  const { kvStore, searchStore } = makeStores();
  return {
    kvStore,
    searchStore,
    apiKey: "test-key",
    verbose: false,
    ...overrides,
  };
}

/** Write a JSON array of Summary objects under a t1 key. */
async function seedT1(
  kvStore: InMemoryKVStore,
  repo: string,
  summaries: Summary[],
): Promise<void> {
  await kvStore.set(`summary:t1:${repo}:src/index.ts:abc123`, JSON.stringify(summaries));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enrichCommand", () => {
  let tier3Mock: ReturnType<typeof vi.fn>;
  let tier4Mock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@mma/summarization");
    tier3Mock = mod.tier3BatchSummarize as ReturnType<typeof vi.fn>;
    tier4Mock = mod.tier4BatchSummarize as ReturnType<typeof vi.fn>;
  });

  // -------------------------------------------------------------------------
  // Case 1: empty store → zeros
  // -------------------------------------------------------------------------
  it("returns zeros when the KV store has no t1 summaries", async () => {
    const opts = makeOptions();
    const result = await enrichCommand(opts);

    expect(result).toEqual({
      reposEnriched: 0,
      tier3Count: 0,
      tier4Count: 0,
      apiCallsMade: 0,
    });
    expect(tier3Mock).not.toHaveBeenCalled();
    expect(tier4Mock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 2: already-cached t3 summaries are skipped
  // -------------------------------------------------------------------------
  it("skips t3 upgrade for entities that already have a cached t3 summary", async () => {
    const { kvStore, searchStore } = makeStores();
    const entityId = "repo-a/src/auth.ts::AuthService";

    // Low-confidence t1 summary → would normally escalate to tier3
    const lowConfSummary: Summary = {
      entityId,
      tier: 1,
      description: "AuthService",
      confidence: 0.3,
    };
    await seedT1(kvStore, "repo-a", [lowConfSummary]);

    // Pre-populate the t3 cache so enrich should skip the API call
    const cachedT3: Summary = {
      entityId,
      tier: 3,
      description: "Handles authentication and session management",
      confidence: 0.9,
    };
    await kvStore.set(`summary:t3:${entityId}`, JSON.stringify(cachedT3));

    const result = await enrichCommand({ kvStore, searchStore, apiKey: "k", verbose: false });

    expect(tier3Mock).not.toHaveBeenCalled();
    expect(result.reposEnriched).toBe(1);
    expect(result.tier3Count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Case 3: low-confidence entity without cache → tier3 is called
  // -------------------------------------------------------------------------
  it("calls tier3BatchSummarize for low-confidence entities not yet cached", async () => {
    const { kvStore, searchStore } = makeStores();
    const entityId = "repo-b/src/svc.ts::MyService";

    const lowConfSummary: Summary = {
      entityId,
      tier: 1,
      description: "MyService",
      confidence: 0.2,
    };
    await seedT1(kvStore, "repo-b", [lowConfSummary]);

    // Mock returns one upgraded summary
    const upgraded: Summary = { entityId, tier: 3, description: "My upgraded desc", confidence: 0.85 };
    tier3Mock.mockResolvedValueOnce([upgraded]);

    const result = await enrichCommand({ kvStore, searchStore, apiKey: "k", verbose: false });

    expect(tier3Mock).toHaveBeenCalledOnce();
    expect(result.tier3Count).toBe(1);
    expect(result.apiCallsMade).toBe(1);
    expect(result.reposEnriched).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Case 4: repo filter — only the targeted repo is enriched
  // -------------------------------------------------------------------------
  it("enriches only the specified repo when repo filter is provided", async () => {
    const { kvStore, searchStore } = makeStores();

    // Two repos with low-confidence summaries
    const mkSummary = (entityId: string): Summary => ({
      entityId,
      tier: 1,
      description: entityId,
      confidence: 0.1,
    });
    await seedT1(kvStore, "repo-a", [mkSummary("repo-a/src/a.ts::A")]);
    await seedT1(kvStore, "repo-b", [mkSummary("repo-b/src/b.ts::B")]);

    const result = await enrichCommand({
      kvStore,
      searchStore,
      apiKey: "k",
      verbose: false,
      repo: "repo-a",
    });

    expect(result.reposEnriched).toBe(1);

    // tier3 should only have been called with repo-a's entity
    if (tier3Mock.mock.calls.length > 0) {
      const candidates = tier3Mock.mock.calls[0]![0] as Array<{ entityId: string }>;
      for (const c of candidates) {
        expect(c.entityId).toContain("repo-a");
      }
    }
  });

  // -------------------------------------------------------------------------
  // Case 5: unknown repo in filter → returns zeros without error
  // -------------------------------------------------------------------------
  it("returns zeros when repo filter matches no indexed repos", async () => {
    const { kvStore, searchStore } = makeStores();
    await seedT1(kvStore, "repo-a", [
      { entityId: "repo-a/src/x.ts::X", tier: 1, description: "X", confidence: 0.1 },
    ]);

    const result = await enrichCommand({
      kvStore,
      searchStore,
      apiKey: "k",
      verbose: false,
      repo: "no-such-repo",
    });

    expect(result).toEqual({ reposEnriched: 0, tier3Count: 0, tier4Count: 0, apiCallsMade: 0 });
    expect(tier3Mock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 6: maxApiCalls budget is respected
  // -------------------------------------------------------------------------
  it("caps tier3 candidates to the remaining API budget", async () => {
    const { kvStore, searchStore } = makeStores();

    // 5 low-confidence entities
    const summaries: Summary[] = Array.from({ length: 5 }, (_, i) => ({
      entityId: `repo-c/src/f${i}.ts::F${i}`,
      tier: 1 as const,
      description: `F${i}`,
      confidence: 0.1,
    }));
    await seedT1(kvStore, "repo-c", summaries);

    // Stub tier3 to return upgraded summaries for whatever slice is passed
    tier3Mock.mockImplementation(
      async (candidates: Array<{ entityId: string }>) =>
        candidates.map((c) => ({
          entityId: c.entityId,
          tier: 3,
          description: `upgraded ${c.entityId}`,
          confidence: 0.9,
        })),
    );

    // Budget of 2 — only 2 out of 5 entities should be passed to tier3
    const result = await enrichCommand({
      kvStore,
      searchStore,
      apiKey: "k",
      verbose: false,
      maxApiCalls: 2,
    });

    expect(tier3Mock).toHaveBeenCalledOnce();
    const passedCandidates = tier3Mock.mock.calls[0]![0] as unknown[];
    expect(passedCandidates).toHaveLength(2);
    expect(result.tier3Count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Case 7: tier4 is called when a service catalog exists
  // -------------------------------------------------------------------------
  it("calls tier4BatchSummarize when a service catalog is present", async () => {
    const { kvStore, searchStore } = makeStores();
    const repo = "repo-d";

    // A high-confidence t1 summary (won't escalate to tier3)
    await seedT1(kvStore, repo, [
      { entityId: `${repo}/src/svc.ts::SvcA`, tier: 1, description: "SvcA", confidence: 0.9 },
    ]);

    // Catalog for the repo
    const catalog: ServiceCatalogEntry[] = [
      {
        name: "SvcA",
        rootPath: "src/svc-a",
        purpose: "Provides SvcA functionality",
        dependencies: ["dep-x"],
        apiSurface: [{ method: "GET", path: "/api/svc-a", description: "Get SvcA" }],
        errorHandlingSummary: "Returns 500 on failure",
      },
    ];
    await kvStore.set(`catalog:${repo}`, JSON.stringify(catalog));

    const tier4Summary: Summary = {
      entityId: "service:SvcA",
      tier: 4,
      description: "SvcA — exposes a REST API",
      confidence: 0.95,
    };
    tier4Mock.mockResolvedValueOnce({ summaries: [tier4Summary], apiCallsMade: 1 });

    const result = await enrichCommand({ kvStore, searchStore, apiKey: "k", verbose: false });

    expect(tier4Mock).toHaveBeenCalledOnce();
    expect(result.tier4Count).toBe(1);
    expect(result.apiCallsMade).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Case 8: enriched summaries are indexed into the search store
  // -------------------------------------------------------------------------
  it("re-indexes all summaries into the search store after enrichment", async () => {
    const { kvStore, searchStore } = makeStores();

    // Two high-confidence t1 summaries (won't escalate)
    const summaries: Summary[] = [
      { entityId: "repo-e/src/a.ts::Alpha", tier: 1, description: "Alpha", confidence: 0.9 },
      { entityId: "repo-e/src/b.ts::Beta", tier: 1, description: "Beta", confidence: 0.85 },
    ];
    await seedT1(kvStore, "repo-e", summaries);

    const indexSpy = vi.spyOn(searchStore, "index");

    await enrichCommand({ kvStore, searchStore, apiKey: "k", verbose: false });

    expect(indexSpy).toHaveBeenCalledOnce();
    const docs = indexSpy.mock.calls[0]![0] as unknown as Array<{ id: string }>;
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.id)).toContain("repo-e/src/a.ts::Alpha");
    expect(docs.map((d) => d.id)).toContain("repo-e/src/b.ts::Beta");
  });
});
