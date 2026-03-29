import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import { runWakeUpCheck, diffOrgScan } from "./wake-up.js";

// Mock @mma/ingestion
vi.mock("@mma/ingestion", () => ({
  scanGitHubOrg: vi.fn(),
}));

// Mock @mma/correlation
const mockAddCandidate = vi.fn();
const mockGet = vi.fn();
vi.mock("@mma/correlation", () => ({
  RepoStateManager: vi.fn().mockImplementation(function() {
    return {
      addCandidate: mockAddCandidate,
      get: mockGet,
    };
  }),
}));

describe("wake-up check", () => {
  let kvStore: InMemoryKVStore;

  beforeEach(async () => {
    kvStore = new InMemoryKVStore();
    vi.clearAllMocks();
    mockGet.mockResolvedValue(undefined);

    const { scanGitHubOrg } = await import("@mma/ingestion");
    (scanGitHubOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      org: "test-org",
      repos: [
        { name: "repo-a", fullName: "test-org/repo-a", url: "https://github.com/test-org/repo-a.git", sshUrl: "", defaultBranch: "main", language: "TypeScript", updatedAt: "2026-01-01", archived: false, fork: false, starCount: 10, description: null },
        { name: "repo-b", fullName: "test-org/repo-b", url: "https://github.com/test-org/repo-b.git", sshUrl: "", defaultBranch: "main", language: "JavaScript", updatedAt: "2026-01-01", archived: false, fork: false, starCount: 5, description: null },
        { name: "repo-c", fullName: "test-org/repo-c", url: "https://github.com/test-org/repo-c.git", sshUrl: "", defaultBranch: "main", language: null, updatedAt: "2026-01-01", archived: false, fork: false, starCount: 1, description: null },
      ],
      scannedAt: "2026-03-22T00:00:00Z",
      totalReposInOrg: 3,
    });
  });

  describe("diffOrgScan", () => {
    it("finds all repos as new when no previous scan exists", async () => {
      const result = await diffOrgScan("test-org", kvStore);
      expect(result.previousRepoCount).toBe(0);
      expect(result.currentRepoCount).toBe(3);
      expect(result.newRepos).toHaveLength(3);
      expect(result.newRepos.map(r => r.name)).toEqual(["repo-a", "repo-b", "repo-c"]);
      expect(mockAddCandidate).toHaveBeenCalledTimes(3);
    });

    it("finds only new repos when previous scan exists", async () => {
      // Seed previous scan with repo-a and repo-b
      await kvStore.set("org-scan:test-org", JSON.stringify({
        repos: [{ name: "repo-a" }, { name: "repo-b" }],
      }));

      const result = await diffOrgScan("test-org", kvStore);
      expect(result.previousRepoCount).toBe(2);
      expect(result.currentRepoCount).toBe(3);
      expect(result.newRepos).toHaveLength(1);
      expect(result.newRepos[0]!.name).toBe("repo-c");
      expect(mockAddCandidate).toHaveBeenCalledTimes(1);
    });

    it("skips candidate registration for repos already tracked", async () => {
      mockGet.mockResolvedValueOnce({ name: "repo-a", status: "indexed" });
      mockGet.mockResolvedValueOnce(undefined);
      mockGet.mockResolvedValueOnce(undefined);

      const result = await diffOrgScan("test-org", kvStore);
      expect(result.newRepos).toHaveLength(3);
      // Only 2 registered because repo-a already exists
      expect(mockAddCandidate).toHaveBeenCalledTimes(2);
    });

    it("updates cached scan result", async () => {
      await diffOrgScan("test-org", kvStore);
      const cached = await kvStore.get("org-scan:test-org");
      expect(cached).toBeTruthy();
      const parsed = JSON.parse(cached!);
      expect(parsed.repos).toHaveLength(3);
    });
  });

  describe("runWakeUpCheck", () => {
    it("returns empty result when no orgs are tracked", async () => {
      const result = await runWakeUpCheck(kvStore);
      expect(result.orgsChecked).toBe(0);
      expect(result.totalNewRepos).toBe(0);
      expect(result.results).toEqual([]);
    });

    it("scans all previously scanned orgs", async () => {
      await kvStore.set("org-scan:org-1", JSON.stringify({ repos: [{ name: "repo-a" }] }));
      await kvStore.set("org-scan:org-2", JSON.stringify({ repos: [] }));

      const result = await runWakeUpCheck(kvStore);
      expect(result.orgsChecked).toBe(2);
    });

    it("sums new repos across orgs", async () => {
      await kvStore.set("org-scan:test-org", JSON.stringify({ repos: [{ name: "repo-a" }] }));

      const result = await runWakeUpCheck(kvStore);
      expect(result.orgsChecked).toBe(1);
      expect(result.totalNewRepos).toBe(2); // repo-b and repo-c are new
      expect(result.results[0]!.newRepos).toHaveLength(2);
    });

    it("continues scanning other orgs if one fails", async () => {
      const { scanGitHubOrg } = await import("@mma/ingestion");
      (scanGitHubOrg as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("API rate limit"))
        .mockResolvedValueOnce({
          org: "org-2",
          repos: [{ name: "new-repo", fullName: "org-2/new-repo", url: "url", sshUrl: "", defaultBranch: "main", language: null, updatedAt: "2026-01-01", archived: false, fork: false, starCount: 0, description: null }],
          scannedAt: "2026-03-22",
          totalReposInOrg: 1,
        });

      await kvStore.set("org-scan:org-1", JSON.stringify({ repos: [] }));
      await kvStore.set("org-scan:org-2", JSON.stringify({ repos: [] }));

      const result = await runWakeUpCheck(kvStore);
      expect(result.orgsChecked).toBe(2);
      // org-1 failed, so only org-2's result
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.org).toBe("org-2");
    });
  });
});
