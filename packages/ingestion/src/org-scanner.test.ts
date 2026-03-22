import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Mock @octokit/rest before importing the module under test
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(),
}));

import { Octokit } from "@octokit/rest";
import { scanGitHubOrg, scanLocalDirectory } from "./org-scanner.js";

// Helper: build an async iterable over pages of repo arrays
function makeAsyncIterable(pages: object[][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page };
      }
    },
  };
}

const makeRepo = (overrides: Record<string, unknown> = {}) => ({
  name: "test-repo",
  full_name: "org/test-repo",
  clone_url: "https://github.com/org/test-repo.git",
  ssh_url: "git@github.com:org/test-repo.git",
  default_branch: "main",
  language: "TypeScript",
  updated_at: "2024-01-01T00:00:00Z",
  archived: false,
  fork: false,
  stargazers_count: 10,
  description: "A test repo",
  ...overrides,
});

const OctokitMock = vi.mocked(Octokit);

function setupOctokit(pages: object[][]) {
  const mockInstance = {
    repos: { listForOrg: vi.fn() },
    paginate: {
      iterator: vi.fn().mockReturnValue(makeAsyncIterable(pages)),
    },
  };
  OctokitMock.mockImplementation(() => mockInstance as unknown as Octokit);
  return mockInstance;
}

describe("scanGitHubOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure no ambient token bleeds between tests
    delete process.env["GITHUB_TOKEN"];
  });

  it("throws when no token is available", async () => {
    await expect(
      scanGitHubOrg({ org: "myorg", token: undefined })
    ).rejects.toThrow("GitHub token required");
  });

  it("uses GITHUB_TOKEN env var when token option is omitted", async () => {
    process.env["GITHUB_TOKEN"] = "env-token";
    setupOctokit([[makeRepo()]]);

    const result = await scanGitHubOrg({ org: "myorg" });
    expect(result.repos).toHaveLength(1);
    expect(OctokitMock).toHaveBeenCalledWith({ auth: "env-token" });
  });

  it("filters forks when excludeForks=true (default)", async () => {
    setupOctokit([[
      makeRepo({ name: "normal", full_name: "org/normal", fork: false }),
      makeRepo({ name: "forked", full_name: "org/forked", fork: true }),
    ]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok" });
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.name).toBe("normal");
    expect(result.totalReposInOrg).toBe(2);
  });

  it("includes forks when excludeForks=false", async () => {
    setupOctokit([[
      makeRepo({ name: "normal", full_name: "org/normal", fork: false }),
      makeRepo({ name: "forked", full_name: "org/forked", fork: true }),
    ]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok", excludeForks: false });
    expect(result.repos).toHaveLength(2);
  });

  it("filters archived repos when excludeArchived=true (default)", async () => {
    setupOctokit([[
      makeRepo({ name: "active", full_name: "org/active", archived: false }),
      makeRepo({ name: "archived", full_name: "org/archived", archived: true }),
    ]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok" });
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.name).toBe("active");
  });

  it("includes archived repos when excludeArchived=false", async () => {
    setupOctokit([[
      makeRepo({ name: "active", full_name: "org/active", archived: false }),
      makeRepo({ name: "archived", full_name: "org/archived", archived: true }),
    ]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok", excludeArchived: false });
    expect(result.repos).toHaveLength(2);
  });

  it("filters by language (case-insensitive)", async () => {
    setupOctokit([[
      makeRepo({ name: "ts-repo", full_name: "org/ts-repo", language: "TypeScript" }),
      makeRepo({ name: "go-repo", full_name: "org/go-repo", language: "Go" }),
      makeRepo({ name: "no-lang", full_name: "org/no-lang", language: null }),
    ]]);

    const result = await scanGitHubOrg({
      org: "myorg",
      token: "tok",
      languages: ["typescript"],
    });
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.name).toBe("ts-repo");
  });

  it("applies no language filter when languages is empty", async () => {
    setupOctokit([[
      makeRepo({ name: "ts-repo", full_name: "org/ts-repo", language: "TypeScript" }),
      makeRepo({ name: "go-repo", full_name: "org/go-repo", language: "Go" }),
    ]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok", languages: [] });
    expect(result.repos).toHaveLength(2);
  });

  it("respects limit", async () => {
    setupOctokit([[
      makeRepo({ name: "repo1", full_name: "org/repo1" }),
      makeRepo({ name: "repo2", full_name: "org/repo2" }),
      makeRepo({ name: "repo3", full_name: "org/repo3" }),
    ]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok", limit: 2 });
    expect(result.repos).toHaveLength(2);
  });

  it("handles multi-page pagination", async () => {
    setupOctokit([
      [makeRepo({ name: "repo1", full_name: "org/repo1" })],
      [makeRepo({ name: "repo2", full_name: "org/repo2" })],
    ]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok" });
    expect(result.repos).toHaveLength(2);
    expect(result.totalReposInOrg).toBe(2);
  });

  it("maps repo fields correctly", async () => {
    setupOctokit([[makeRepo()]]);

    const result = await scanGitHubOrg({ org: "myorg", token: "tok" });
    const repo = result.repos[0]!;
    expect(repo.name).toBe("test-repo");
    expect(repo.fullName).toBe("org/test-repo");
    expect(repo.url).toBe("https://github.com/org/test-repo.git");
    expect(repo.sshUrl).toBe("git@github.com:org/test-repo.git");
    expect(repo.defaultBranch).toBe("main");
    expect(repo.language).toBe("TypeScript");
    expect(repo.updatedAt).toBe("2024-01-01T00:00:00Z");
    expect(repo.archived).toBe(false);
    expect(repo.fork).toBe(false);
    expect(repo.starCount).toBe(10);
    expect(repo.description).toBe("A test repo");
  });

  it("returns org and scannedAt in result", async () => {
    setupOctokit([[]]);

    const before = new Date().toISOString();
    const result = await scanGitHubOrg({ org: "myorg", token: "tok" });
    const after = new Date().toISOString();

    expect(result.org).toBe("myorg");
    expect(result.scannedAt >= before).toBe(true);
    expect(result.scannedAt <= after).toBe(true);
  });
});

describe("scanLocalDirectory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mma-org-scanner-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("finds a regular git repo", async () => {
    const repoDir = join(tmpDir, "my-repo");
    await execFileAsync("git", ["init", repoDir]);

    const repos = await scanLocalDirectory(tmpDir);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe("my-repo");
    expect(repos[0]!.url).toBe(repoDir);
  });

  it("finds multiple git repos", async () => {
    await execFileAsync("git", ["init", join(tmpDir, "alpha")]);
    await execFileAsync("git", ["init", join(tmpDir, "beta")]);

    const repos = await scanLocalDirectory(tmpDir);
    expect(repos).toHaveLength(2);
    const names = repos.map(r => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("skips non-git directories", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmpDir, "not-a-repo"));
    await execFileAsync("git", ["init", join(tmpDir, "real-repo")]);

    const repos = await scanLocalDirectory(tmpDir);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe("real-repo");
  });

  it("returns expected field values for local repos", async () => {
    await execFileAsync("git", ["init", join(tmpDir, "local-repo")]);

    const repos = await scanLocalDirectory(tmpDir);
    const repo = repos[0]!;
    expect(repo.language).toBeNull();
    expect(repo.archived).toBe(false);
    expect(repo.fork).toBe(false);
    expect(repo.starCount).toBe(0);
    expect(repo.description).toBeNull();
    expect(repo.sshUrl).toBe(repo.url);
  });
});
