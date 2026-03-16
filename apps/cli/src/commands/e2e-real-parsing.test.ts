/**
 * E2E integration test for indexCommand with real tree-sitter parsing.
 *
 * Unlike index-cmd.test.ts (which mocks all parsing/structural/heuristics),
 * this test lets the real parsing, structural analysis, and heuristics execute
 * against actual .ts files written to a temp directory. Only LLM-dependent
 * packages (summarization, model-config, model-fault, model-functional,
 * correlation) and git-dependent ingestion functions are mocked.
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
  tier4BatchSummarize: vi.fn().mockResolvedValue([]),
  narrateAll: vi.fn().mockResolvedValue([]),
  SONNET_DEFAULTS: {},
}));

vi.mock("@mma/model-config", () => ({
  buildFeatureModel: vi.fn().mockReturnValue(null),
  extractConstraintsFromCode: vi.fn().mockReturnValue([]),
  validateFeatureModel: vi.fn().mockResolvedValue({
    results: [],
    validation: {
      deadFlags: [],
      alwaysOnFlags: [],
      untestedInteractions: [],
    },
  }),
}));

vi.mock("@mma/model-fault", () => ({
  identifyLogRoots: vi.fn().mockReturnValue([]),
  traceBackwardFromLog: vi.fn().mockReturnValue({ steps: [] }),
  buildFaultTree: vi.fn().mockReturnValue(null),
  analyzeGaps: vi.fn().mockReturnValue([]),
}));

vi.mock("@mma/model-functional", () => ({
  buildServiceCatalog: vi.fn().mockReturnValue([]),
  generateDocumentation: vi.fn().mockReturnValue(""),
}));

vi.mock("@mma/correlation", () => ({
  runCorrelation: vi.fn().mockResolvedValue({
    pairs: [],
    hotspots: [],
    summary: "",
  }),
}));

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

const APP_TS = `\
import { UserService } from "./user-service";

export async function bootstrap(): Promise<void> {
  const svc = new UserService();
  const user = await svc.getUser("123");
  console.log(user);
}

bootstrap();
`;

const USER_SERVICE_TS = `\
import { Logger } from "./logger";

export interface User {
  id: string;
  name: string;
}

export class UserService {
  private logger = new Logger();

  async getUser(id: string): Promise<User> {
    this.logger.info(\`Fetching user \${id}\`);
    return { id, name: "Alice" };
  }

  async createUser(name: string): Promise<User> {
    this.logger.info(\`Creating user \${name}\`);
    return { id: "new-id", name };
  }
}
`;

const LOGGER_TS = `\
export class Logger {
  info(message: string): void {
    console.log(\`[INFO] \${message}\`);
  }

  error(message: string): void {
    console.error(\`[ERROR] \${message}\`);
  }
}
`;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(async () => {
  // Initialise real tree-sitter WASM grammars before any parsing happens.
  await initTreeSitter();

  tempDir = await mkdtemp(join(tmpdir(), "mma-e2e-"));
  await mkdir(join(tempDir, "src"), { recursive: true });
  await writeFile(join(tempDir, "src", "app.ts"), APP_TS, "utf-8");
  await writeFile(
    join(tempDir, "src", "user-service.ts"),
    USER_SERVICE_TS,
    "utf-8",
  );
  await writeFile(join(tempDir, "src", "logger.ts"), LOGGER_TS, "utf-8");
}, 30_000);

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("indexCommand e2e (real tree-sitter)", () => {
  it(
    "runs full pipeline with real parsing and produces correct stores",
    async () => {
      const kvStore = new InMemoryKVStore();
      const graphStore = new InMemoryGraphStore();
      const searchStore = new InMemorySearchStore();

      const changeSet: ChangeSet = {
        repo: "test-repo",
        commitHash: "e2e-test-hash",
        previousCommitHash: null,
        addedFiles: [
          "src/app.ts",
          "src/user-service.ts",
          "src/logger.ts",
        ],
        modifiedFiles: [],
        deletedFiles: [],
        timestamp: new Date(),
      };

      mockDetectChanges.mockResolvedValue(changeSet);

      const options: IndexOptions = {
        repos: [
          {
            name: "test-repo",
            url: "https://test.example.com",
            branch: "main",
            localPath: tempDir,
          },
        ],
        mirrorDir: tempDir,
        kvStore,
        graphStore,
        searchStore,
        verbose: false,
      };

      const result = await indexCommand(options);

      // --- Return value ---
      expect(result.hadChanges).toBe(true);
      expect(result.repoCount).toBe(1);
      expect(result.totalFiles).toBeGreaterThan(0);
      expect(result.totalSarifResults).toBeGreaterThanOrEqual(0);

      // --- Pipeline completion markers ---
      expect(await kvStore.get("pipelineComplete:test-repo")).toBe("true");
      expect(await kvStore.get("commit:test-repo")).toBe("e2e-test-hash");

      // --- Symbols: UserService and its methods must be extracted ---
      const symbolsRaw = await kvStore.get(
        "symbols:test-repo:src/user-service.ts",
      );
      expect(symbolsRaw).toBeTruthy();
      const { symbols } = JSON.parse(symbolsRaw!) as {
        symbols: Array<{ name: string; kind: string }>;
        contentHash: string;
      };
      const symbolNames = symbols.map((s) => s.name);
      expect(symbolNames).toContain("UserService");
      expect(symbolNames).toContain("getUser");
      expect(symbolNames).toContain("createUser");

      // --- Import edges: app.ts → user-service.ts and user-service.ts → logger.ts ---
      const importEdges = await graphStore.getEdgesByKind(
        "imports",
        "test-repo",
      );
      const edgePairs = importEdges.map((e) => `${e.source} → ${e.target}`);
      expect(
        edgePairs.some(
          (p) =>
            p.includes("src/app.ts") && p.includes("src/user-service.ts"),
        ),
      ).toBe(true);
      expect(
        edgePairs.some(
          (p) =>
            p.includes("src/user-service.ts") && p.includes("src/logger.ts"),
        ),
      ).toBe(true);

      // --- Log templates: extracted from logger.ts console calls ---
      const logTemplatesRaw = await kvStore.get("logTemplates:test-repo");
      expect(logTemplatesRaw).toBeTruthy();
      const logIndex = JSON.parse(logTemplatesRaw!) as {
        repo: string;
        templates: unknown[];
      };
      expect(logIndex.templates.length).toBeGreaterThan(0);

      // --- Naming analysis persisted ---
      const namingRaw = await kvStore.get("naming:test-repo");
      expect(namingRaw).toBeTruthy();

      // --- Pattern detection ran (key written only when patterns.length > 0) ---
      // The fixture files are simple enough that no patterns may be detected,
      // so we only assert the key is valid JSON when it is present.
      const patternsRaw = await kvStore.get("patterns:test-repo");
      if (patternsRaw !== undefined && patternsRaw !== null) {
        expect(() => JSON.parse(patternsRaw)).not.toThrow();
      }

      // --- SARIF aggregated results present ---
      const sarifRaw = await kvStore.get("sarif:latest");
      expect(sarifRaw).toBeTruthy();
    },
    60_000,
  );
});
