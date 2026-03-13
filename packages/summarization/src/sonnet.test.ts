import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { Summary } from "@mma/core";
import {
  tier4BatchSummarize,
  summarizeWithSonnet,
  SONNET_DEFAULTS,
} from "./sonnet.js";

// Minimal valid input for all tests
const baseInput = {
  entityId: "service:auth",
  serviceName: "AuthService",
  methodSummaries: ["login()", "logout()"],
  dependencies: ["db", "cache"],
  entryPoints: ["POST /login"],
};

const baseOptions = {
  ...SONNET_DEFAULTS,
  apiKey: "test-key",
};

// Successful Anthropic API response fixture
const successResponse = {
  ok: true,
  json: async () => ({
    content: [{ type: "text", text: "Test summary" }],
  }),
  headers: new Headers(),
};

describe("tier4BatchSummarize", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cache hit: returns cached summary without calling fetch", async () => {
    const kv = new InMemoryKVStore();
    const cached: Summary = {
      entityId: "service:auth",
      tier: 4,
      description: "Cached auth service description",
      confidence: 0.95,
    };
    await kv.set("summary:t4:service:auth", JSON.stringify(cached));

    const result = await tier4BatchSummarize([baseInput], {
      ...baseOptions,
      kvStore: kv,
    });

    expect(result.cacheHits).toBe(1);
    expect(result.apiCallsMade).toBe(0);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]).toEqual(cached);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("cache miss: calls API and writes result back to KV store", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      successResponse as unknown as Response,
    );

    const kv = new InMemoryKVStore();

    const result = await tier4BatchSummarize([baseInput], {
      ...baseOptions,
      kvStore: kv,
    });

    expect(result.apiCallsMade).toBe(1);
    expect(result.cacheHits).toBe(0);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.confidence).toBeGreaterThan(0);

    // Verify the result was written to cache
    const stored = await kv.get("summary:t4:service:auth");
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!) as Summary;
    expect(parsed.entityId).toBe("service:auth");
    expect(parsed.description).toBe("Test summary");
  });

  it("maxApiCalls cap: skips inputs beyond the cap with confidence=0", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      successResponse as unknown as Response,
    );

    const inputs = [
      { ...baseInput, entityId: "service:auth", serviceName: "AuthService" },
      { ...baseInput, entityId: "service:users", serviceName: "UserService" },
      {
        ...baseInput,
        entityId: "service:billing",
        serviceName: "BillingService",
      },
    ];

    const result = await tier4BatchSummarize(inputs, {
      ...baseOptions,
      maxApiCalls: 1,
    });

    expect(result.apiCallsMade).toBe(1);
    expect(result.summaries).toHaveLength(3);

    // First summary should have been fetched successfully
    expect(result.summaries[0]!.confidence).toBeGreaterThan(0);

    // Remaining summaries should be skipped (confidence=0)
    expect(result.summaries[1]!.confidence).toBe(0);
    expect(result.summaries[2]!.confidence).toBe(0);
  });
});

describe("summarizeWithSonnet 429 retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "1" }),
    };

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(rateLimitResponse as unknown as Response)
      .mockResolvedValueOnce(successResponse as unknown as Response);

    const resultPromise = summarizeWithSonnet(baseInput, baseOptions);

    // Advance past the retry-after delay (1s = 1000ms)
    await vi.advanceTimersByTimeAsync(1500);

    const result = await resultPromise;

    expect(result.confidence).toBeGreaterThan(0);
    expect(result.description).toBe("Test summary");
    expect(result.entityId).toBe("service:auth");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
