/**
 * E2E integration test for config validation pipeline.
 *
 * Unlike index-cmd.test.ts (which mocks model-config) and e2e-real-parsing.test.ts
 * (which focuses on symbols and import edges), this test exercises the full
 * config validation pipeline with real execution:
 *
 *   settings scanner → flag scanner → feature model builder →
 *   constraint extraction → SAT validation → SARIF findings
 *
 * Packages kept real: @mma/parsing (tree-sitter), @mma/heuristics (scanForSettings,
 * scanForFlags), @mma/model-config (buildFeatureModel, extractConstraintsFromCode,
 * validateFeatureModel), @mma/structural (dependency graphs, import resolution).
 *
 * Packages mocked: @mma/ingestion (git functions), @mma/summarization,
 * @mma/model-fault, @mma/model-functional, @mma/correlation,
 * ./affected-scope.js.
 */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { ChangeSet } from "@mma/core";
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";
import { initTreeSitter } from "@mma/parsing";
import { indexCommand, type IndexOptions } from "./index-cmd.js";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Partial mock: keep classifyFiles real, mock git-dependent functions.
vi.mock("@mma/ingestion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mma/ingestion")>();
  return {
    ...actual,
    detectChanges: vi.fn(),
    isBareRepo: vi.fn().mockResolvedValue(false),
    getFileContent: vi.fn().mockResolvedValue(""),
    getHeadCommit: vi.fn().mockResolvedValue("e2e-test-hash"),
  };
});

// Selective mock: forward real readFile unless caller is reading a package.json
// (which won't exist in the temp dir). tree-sitter's WASM loader uses its own
// file-reading mechanism and is unaffected.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn().mockImplementation(
      async (path: unknown, ...args: unknown[]) => {
        if (typeof path === "string" && path.includes("package.json")) {
          return "{}";
        }
        // Forward to the real implementation for everything else
        return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(
          path,
          ...args,
        );
      },
    ),
  };
});

// LLM-dependent packages — return empty/stub values
vi.mock("@mma/summarization", () => ({
  tier1Summarize: vi.fn().mockReturnValue([]),
  tier2Summarize: vi.fn().mockReturnValue([]),
}));

// DO NOT mock @mma/model-config — this is the package under test!

vi.mock("@mma/model-fault", () => ({
  identifyLogRoots: vi.fn().mockReturnValue([]),
  traceBackwardFromLog: vi.fn().mockReturnValue({ steps: [] }),
  buildFaultTree: vi.fn().mockReturnValue(null),
  analyzeGaps: vi.fn().mockReturnValue([]),
  analyzeCascadingRisk: vi.fn().mockReturnValue([]),
  FAULT_RULES: [],
}));

vi.mock("@mma/model-functional", () => ({
  buildServiceCatalog: vi.fn().mockReturnValue([]),
  generateDocumentation: vi.fn().mockReturnValue(""),
}));

vi.mock("@mma/correlation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mma/correlation")>();
  return {
    ...actual,
    runCorrelation: vi.fn().mockResolvedValue({
      pairs: [],
      hotspots: [],
      summary: "",
      crossRepoGraph: { edges: [], nodes: [] },
      serviceCorrelation: { groups: [], edges: [] },
      counts: {
        crossRepoEdges: 0,
        repoPairs: 0,
        linchpins: 0,
        sarifFindings: 0,
      },
    }),
    runCrossRepoModels: vi.fn().mockResolvedValue({
      sarifResults: [],
      featureResults: [],
      faultResults: [],
      catalogResults: [],
    }),
  };
});

vi.mock("./affected-scope.js", () => ({
  computeAffectedScope: vi.fn().mockResolvedValue(new Map()),
}));

// ---------------------------------------------------------------------------
// Import mocked detectChanges so we can configure its return value per-test
// ---------------------------------------------------------------------------

import { detectChanges } from "@mma/ingestion";
const mockDetectChanges = detectChanges as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture source files
// ---------------------------------------------------------------------------

/** Config object with property accesses and defaults */
const CONFIG_TS = `\
const config = {
  timeout: 5000,
  maxRetries: 3,
  batchSize: 100,
};

export function getTimeout(): number {
  return config.timeout ?? 3000;
}

export function getMaxRetries(): number {
  return config.maxRetries ?? 1;
}

export function getBatchSize(): number {
  return config.batchSize ?? 50;
}
`;

/** Environment variable accesses including credentials */
const ENV_CONFIG_TS = `\
export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? "localhost:5432";
}

export function getApiKey(): string {
  return process.env.API_SECRET_KEY ?? "";
}

export function getRedisHost(): string {
  return process.env.REDIS_HOST ?? "localhost";
}
`;

/** Feature flags with if-else mutex pattern */
const FEATURE_FLAGS_TS = `\
const FEATURE_NEW_UI = process.env.FEATURE_NEW_UI === "true";
const FEATURE_LEGACY_UI = process.env.FEATURE_LEGACY_UI === "true";

export function renderUI(): string {
  if (FEATURE_NEW_UI) {
    return "new-ui";
  } else if (FEATURE_LEGACY_UI) {
    return "legacy-ui";
  }
  return "default-ui";
}
`;

/** Zod schema with constraints */
const VALIDATION_TS = `\
import { z } from "zod";

export const AppConfigSchema = z.object({
  port: z.number().min(1).max(65535),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  workerCount: z.number().min(1).max(32),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
`;

/** Guard clause pattern: if param X then uses param Y */
const GUARD_CLAUSE_TS = `\
import { getMaxRetries, getTimeout } from "./config";

export function processWithRetry(data: unknown): void {
  if (getMaxRetries() > 0) {
    const delay = getTimeout() * 2;
    console.log("Retrying with delay", delay);
  }
}
`;

/** Cross-repo shared config parameters (repo-b) */
const SHARED_CONFIG_TS = `\
export function getSharedDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? "localhost:5432";
}

export function getSharedApiKey(): string {
  return process.env.API_SECRET_KEY ?? "";
}
`;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let repoADir: string;
let repoBDir: string;

beforeAll(async () => {
  // Initialise real tree-sitter WASM grammars before any parsing happens.
  await initTreeSitter();

  // Set up repo-a with all config fixtures
  repoADir = await mkdtemp(join(tmpdir(), "mma-e2e-config-a-"));
  await mkdir(join(repoADir, "src"), { recursive: true });
  await writeFile(join(repoADir, "src", "config.ts"), CONFIG_TS, "utf-8");
  await writeFile(
    join(repoADir, "src", "env-config.ts"),
    ENV_CONFIG_TS,
    "utf-8",
  );
  await writeFile(
    join(repoADir, "src", "feature-flags.ts"),
    FEATURE_FLAGS_TS,
    "utf-8",
  );
  await writeFile(
    join(repoADir, "src", "validation.ts"),
    VALIDATION_TS,
    "utf-8",
  );
  await writeFile(
    join(repoADir, "src", "guard-clause.ts"),
    GUARD_CLAUSE_TS,
    "utf-8",
  );

  // Set up repo-b with shared config fixtures
  repoBDir = await mkdtemp(join(tmpdir(), "mma-e2e-config-b-"));
  await mkdir(join(repoBDir, "src"), { recursive: true });
  await writeFile(
    join(repoBDir, "src", "shared-config.ts"),
    SHARED_CONFIG_TS,
    "utf-8",
  );
}, 30_000);

afterAll(async () => {
  await Promise.all([
    repoADir
      ? rm(repoADir, { recursive: true, force: true })
      : Promise.resolve(),
    repoBDir
      ? rm(repoBDir, { recursive: true, force: true })
      : Promise.resolve(),
  ]);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeChangeSet(repo: string, files: string[]): ChangeSet {
  return {
    repo,
    commitHash: "e2e-test-hash",
    previousCommitHash: null,
    addedFiles: files,
    modifiedFiles: [],
    deletedFiles: [],
    timestamp: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("indexCommand e2e (config validation pipeline)", () => {
  it(
    "detects config parameters, builds feature model, and produces SARIF findings for repo-a",
    async () => {
      const kvStore = new InMemoryKVStore();
      const graphStore = new InMemoryGraphStore();
      const searchStore = new InMemorySearchStore();

      const changeSet = makeChangeSet("config-repo-a", [
        "src/config.ts",
        "src/env-config.ts",
        "src/feature-flags.ts",
        "src/validation.ts",
        "src/guard-clause.ts",
      ]);
      mockDetectChanges.mockResolvedValue(changeSet);

      const options: IndexOptions = {
        repos: [
          {
            name: "config-repo-a",
            url: "https://test.example.com/repo-a",
            branch: "main",
            localPath: repoADir,
            settings: {
              configObjectNames: ["config"],
            },
          },
        ],
        mirrorDir: repoADir,
        kvStore,
        graphStore,
        searchStore,
        verbose: false,
      };

      const result = await indexCommand(options);

      // --- Basic pipeline completion ---
      expect(result.hadChanges).toBe(true);
      expect(result.repoCount).toBe(1);
      expect(result.totalFiles).toBeGreaterThan(0);
      expect(await kvStore.get("pipelineComplete:config-repo-a")).toBe("true");
      expect(await kvStore.get("commit:config-repo-a")).toBe("e2e-test-hash");

      // --- Config inventory (settings scanner output) ---
      // phase-heuristics persists to `config-inventory:{repo}`.
      // Env vars and config object accesses should be detected.
      const configInventoryRaw = await kvStore.get(
        "config-inventory:config-repo-a",
      );
      expect(configInventoryRaw).toBeTruthy();
      const configInventory = JSON.parse(configInventoryRaw!) as {
        repo: string;
        parameters: Array<{ name: string; kind: string }>;
      };
      expect(configInventory.repo).toBe("config-repo-a");
      expect(configInventory.parameters.length).toBeGreaterThan(0);

      const paramNames = configInventory.parameters.map((p) => p.name);

      // Env vars from env-config.ts must be detected
      expect(paramNames).toContain("DATABASE_URL");
      expect(paramNames).toContain("REDIS_HOST");

      // API_SECRET_KEY must be classified as a credential
      const apiKeyParam = configInventory.parameters.find(
        (p) => p.name === "API_SECRET_KEY",
      );
      expect(apiKeyParam).toBeDefined();
      expect(apiKeyParam?.kind).toBe("credential");

      // Config object properties must be detected (configObjectNames: ["config"])
      expect(paramNames).toContain("timeout");
      expect(paramNames).toContain("maxRetries");
      expect(paramNames).toContain("batchSize");

      // --- Feature flag inventory ---
      const flagInventoryRaw = await kvStore.get("flags:config-repo-a");
      expect(flagInventoryRaw).toBeTruthy();
      const flagInventory = JSON.parse(flagInventoryRaw!) as {
        repo: string;
        flags: Array<{ name: string }>;
      };
      expect(flagInventory.repo).toBe("config-repo-a");

      // FEATURE_NEW_UI and FEATURE_LEGACY_UI should be detected from boolean
      // env var comparisons in feature-flags.ts
      const flagNames = flagInventory.flags.map((f) => f.name);
      expect(
        flagNames.some(
          (n) => n.includes("FEATURE_NEW_UI") || n.includes("NEW_UI"),
        ),
      ).toBe(true);
      expect(
        flagNames.some(
          (n) => n.includes("FEATURE_LEGACY_UI") || n.includes("LEGACY_UI"),
        ),
      ).toBe(true);

      // --- Feature model (config-model key) ---
      // phase-models persists to `config-model:{repo}` when flags or settings exist.
      const featureModelRaw = await kvStore.get("config-model:config-repo-a");
      expect(featureModelRaw).toBeTruthy();
      const featureModel = JSON.parse(featureModelRaw!) as {
        flags: Array<{ name: string }>;
        parameters?: Array<{ name: string }>;
        constraints: Array<{ kind: string }>;
      };

      // Model must include settings parameters (propagated from configInventory)
      expect(featureModel.parameters).toBeDefined();
      expect(featureModel.parameters!.length).toBeGreaterThan(0);

      // Constraints array must be present (may be empty for simple fixtures)
      expect(Array.isArray(featureModel.constraints)).toBe(true);

      // --- SARIF config findings ---
      // `sarif:config:{repo}` is written by phase-models after validateFeatureModel.
      const sarifConfigRaw = await kvStore.get("sarif:config:config-repo-a");
      expect(sarifConfigRaw).toBeTruthy();
      const sarifConfig = JSON.parse(sarifConfigRaw!) as Array<{
        ruleId: string;
      }>;
      expect(Array.isArray(sarifConfig)).toBe(true);

      // Every finding must reference a known CONFIG_RULES rule ID.
      const knownConfigRuleIds = new Set([
        "config/dead-flag",
        "config/always-on-flag",
        "config/missing-constraint",
        "config/untested-interaction",
        "config/format-violation",
        "config/unused-registry-flag",
        "config/unregistered-flag",
        "config/dead-setting",
        "config/missing-dependency",
        "config/conflicting-settings",
        "config/high-interaction-parameter",
        "config/exposed-credential",
      ]);
      for (const finding of sarifConfig) {
        expect(knownConfigRuleIds.has(finding.ruleId)).toBe(true);
      }

      // --- SARIF aggregated results present ---
      const sarifLatestRaw = await kvStore.get("sarif:latest");
      expect(sarifLatestRaw).toBeTruthy();
    },
    60_000,
  );

  it(
    "detects shared config parameters across two repos",
    async () => {
      const kvStore = new InMemoryKVStore();
      const graphStore = new InMemoryGraphStore();
      const searchStore = new InMemorySearchStore();

      const changeSetA = makeChangeSet("shared-a", [
        "src/config.ts",
        "src/env-config.ts",
      ]);
      const changeSetB = makeChangeSet("shared-b", [
        "src/shared-config.ts",
      ]);

      // detectChanges is called once per repo; return the matching ChangeSet
      mockDetectChanges
        .mockResolvedValueOnce(changeSetA)
        .mockResolvedValueOnce(changeSetB);

      const options: IndexOptions = {
        repos: [
          {
            name: "shared-a",
            url: "https://test.example.com/shared-a",
            branch: "main",
            localPath: repoADir,
            settings: {
              configObjectNames: ["config"],
            },
          },
          {
            name: "shared-b",
            url: "https://test.example.com/shared-b",
            branch: "main",
            localPath: repoBDir,
          },
        ],
        mirrorDir: repoADir,
        kvStore,
        graphStore,
        searchStore,
        verbose: false,
      };

      const result = await indexCommand(options);

      expect(result.hadChanges).toBe(true);
      expect(result.repoCount).toBe(2);

      // Both repos must complete without error
      expect(await kvStore.get("pipelineComplete:shared-a")).toBe("true");
      expect(await kvStore.get("pipelineComplete:shared-b")).toBe("true");

      // --- Both repos must have config inventories ---
      const inventoryARaw = await kvStore.get("config-inventory:shared-a");
      expect(inventoryARaw).toBeTruthy();
      const inventoryA = JSON.parse(inventoryARaw!) as {
        parameters: Array<{ name: string }>;
      };

      const inventoryBRaw = await kvStore.get("config-inventory:shared-b");
      expect(inventoryBRaw).toBeTruthy();
      const inventoryB = JSON.parse(inventoryBRaw!) as {
        parameters: Array<{ name: string }>;
      };

      // Both inventories must be non-empty
      expect(inventoryA.parameters.length).toBeGreaterThan(0);
      expect(inventoryB.parameters.length).toBeGreaterThan(0);

      const paramNamesA = inventoryA.parameters.map((p) => p.name);
      const paramNamesB = inventoryB.parameters.map((p) => p.name);

      // DATABASE_URL appears in both repos (shared env var)
      expect(paramNamesA).toContain("DATABASE_URL");
      expect(paramNamesB).toContain("DATABASE_URL");

      // API_SECRET_KEY appears in both repos (shared credential)
      expect(paramNamesA).toContain("API_SECRET_KEY");
      expect(paramNamesB).toContain("API_SECRET_KEY");

      // --- Aggregated SARIF written ---
      const sarifLatestRaw = await kvStore.get("sarif:latest");
      expect(sarifLatestRaw).toBeTruthy();
    },
    60_000,
  );
});
