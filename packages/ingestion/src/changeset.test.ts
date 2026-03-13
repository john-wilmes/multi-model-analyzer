import { describe, it, expect, vi } from "vitest";
import { classifyFile, classifyFiles, detectChanges } from "./changeset.js";
import type { ChangeSet, RepoConfig } from "@mma/core";

// ---------------------------------------------------------------------------
// classifyFile — file extension to FileKind mapping
// ---------------------------------------------------------------------------

describe("classifyFile", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["src/app.tsx", "typescript"],
    ["src/app.mts", "typescript"],
    ["src/app.cts", "typescript"],
    ["src/app.js", "javascript"],
    ["src/app.jsx", "javascript"],
    ["src/app.mjs", "javascript"],
    ["src/app.cjs", "javascript"],
    ["config.json", "json"],
    ["config.yml", "yaml"],
    ["config.yaml", "yaml"],
    ["Dockerfile", "dockerfile"],
    ["services/dockerfile.prod", "dockerfile"],
    ["k8s/deployment.yml", "yaml"],
    ["infra/kubernetes/svc.yml", "yaml"],
    ["k8s/deployment.conf", "kubernetes"],
    ["README.md", "markdown"],
    ["Makefile", "unknown"],
    [".env", "unknown"],
  ] as const)("classifies %s as %s", (filePath, expectedKind) => {
    const result = classifyFile(filePath, "test-repo");
    expect(result.kind).toBe(expectedKind);
    expect(result.path).toBe(filePath);
    expect(result.repo).toBe("test-repo");
    expect(result.relativePath).toBe(filePath);
  });

  // ----- Edge cases for inferFileKind -----

  it("classifies files with multiple dots correctly (e.g. .test.ts)", () => {
    const result = classifyFile("src/utils.test.ts", "repo");
    expect(result.kind).toBe("typescript");
  });

  it("classifies .d.ts declaration files as typescript", () => {
    const result = classifyFile("types/global.d.ts", "repo");
    expect(result.kind).toBe("typescript");
  });

  it("classifies .d.mts declaration files as typescript", () => {
    const result = classifyFile("types/module.d.mts", "repo");
    expect(result.kind).toBe("typescript");
  });

  it("does not classify .json-like extensions (e.g. .jsonc) as json", () => {
    const result = classifyFile("tsconfig.jsonc", "repo");
    expect(result.kind).toBe("unknown");
  });

  it("classifies lowercase dockerfile in a subdirectory", () => {
    const result = classifyFile("docker/dockerfile", "repo");
    expect(result.kind).toBe("dockerfile");
  });

  it("classifies Dockerfile.dev as dockerfile", () => {
    const result = classifyFile("Dockerfile.dev", "repo");
    expect(result.kind).toBe("dockerfile");
  });

  it("classifies file in a k8s directory as kubernetes by path", () => {
    const result = classifyFile("k8s/configmap.toml", "repo");
    expect(result.kind).toBe("kubernetes");
  });

  it("classifies kubernetes in path segments", () => {
    const result = classifyFile("deploy/kubernetes/ingress.conf", "repo");
    expect(result.kind).toBe("kubernetes");
  });

  it("classifies a yml file under k8s as yaml (yaml check runs before kubernetes)", () => {
    // Note: .yml matches the yaml regex before the k8s path check
    const result = classifyFile("k8s/deployment.yml", "repo");
    expect(result.kind).toBe("yaml");
  });

  it("classifies root-level files without directories", () => {
    expect(classifyFile("index.ts", "repo").kind).toBe("typescript");
    expect(classifyFile("package.json", "repo").kind).toBe("json");
    expect(classifyFile("CHANGELOG.md", "repo").kind).toBe("markdown");
  });

  it("returns unknown for binary file extensions", () => {
    expect(classifyFile("image.png", "repo").kind).toBe("unknown");
    expect(classifyFile("archive.tar.gz", "repo").kind).toBe("unknown");
    expect(classifyFile("data.bin", "repo").kind).toBe("unknown");
  });

  it("returns unknown for extensionless files", () => {
    expect(classifyFile("LICENSE", "repo").kind).toBe("unknown");
    expect(classifyFile(".gitignore", "repo").kind).toBe("unknown");
  });

  it("handles empty file path string", () => {
    const result = classifyFile("", "repo");
    expect(result.kind).toBe("unknown");
    expect(result.path).toBe("");
  });

  it("preserves repo name in output", () => {
    const result = classifyFile("app.ts", "my-special-repo");
    expect(result.repo).toBe("my-special-repo");
  });
});

// ---------------------------------------------------------------------------
// classifyFiles — maps added + modified files, skips deleted
// ---------------------------------------------------------------------------

describe("classifyFiles", () => {
  const makeChangeSet = (
    added: string[],
    modified: string[],
    deleted: string[],
  ): ChangeSet => ({
    repo: "test-repo",
    commitHash: "abc123",
    previousCommitHash: null,
    addedFiles: added,
    modifiedFiles: modified,
    deletedFiles: deleted,
    timestamp: new Date(),
  });

  it("classifies added and modified files", () => {
    const cs = makeChangeSet(["src/a.ts"], ["src/b.js"], []);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe("typescript");
    expect(result[1]!.kind).toBe("javascript");
  });

  it("excludes deleted files", () => {
    const cs = makeChangeSet([], [], ["src/removed.ts"]);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(0);
  });

  it("returns empty for empty changeset", () => {
    const cs = makeChangeSet([], [], []);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(0);
  });

  it("sets repo from changeset on all classified files", () => {
    const cs: ChangeSet = {
      repo: "specific-repo",
      commitHash: "abc123",
      previousCommitHash: null,
      addedFiles: ["a.ts"],
      modifiedFiles: ["b.js"],
      deletedFiles: [],
      timestamp: new Date(),
    };
    const result = classifyFiles(cs);
    expect(result).toHaveLength(2);
    for (const file of result) {
      expect(file.repo).toBe("specific-repo");
    }
  });

  it("preserves file order: added files come before modified files", () => {
    const cs = makeChangeSet(["z-added.ts"], ["a-modified.js"], []);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe("z-added.ts");
    expect(result[1]!.path).toBe("a-modified.js");
  });

  it("handles large number of files", () => {
    const added = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`);
    const modified = Array.from({ length: 50 }, (_, i) => `lib/mod${i}.js`);
    const cs = makeChangeSet(added, modified, ["deleted.ts"]);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(150);
    // All added files should be typescript
    for (let i = 0; i < 100; i++) {
      expect(result[i]!.kind).toBe("typescript");
    }
    // All modified files should be javascript
    for (let i = 100; i < 150; i++) {
      expect(result[i]!.kind).toBe("javascript");
    }
  });

  it("classifies mixed file types correctly", () => {
    const cs = makeChangeSet(
      ["app.ts", "config.json", "deploy.yml", "Dockerfile"],
      ["README.md", "script.mjs"],
      [],
    );
    const result = classifyFiles(cs);
    expect(result).toHaveLength(6);
    expect(result.map((f) => f.kind)).toEqual([
      "typescript",
      "json",
      "yaml",
      "dockerfile",
      "markdown",
      "javascript",
    ]);
  });

  it("handles changeset with only deleted files", () => {
    const cs = makeChangeSet([], [], ["removed1.ts", "removed2.ts", "removed3.ts"]);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(0);
  });

  it("handles changeset with only added files", () => {
    const cs = makeChangeSet(["new.ts", "new.js"], [], []);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(2);
  });

  it("handles changeset with only modified files", () => {
    const cs = makeChangeSet([], ["changed.ts"], []);
    const result = classifyFiles(cs);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("typescript");
  });
});

// ---------------------------------------------------------------------------
// detectChanges — orchestrates git operations
// ---------------------------------------------------------------------------

vi.mock("./git.js", () => ({
  cloneOrFetch: vi.fn().mockResolvedValue("/tmp/mirror/test-repo"),
  getHeadCommit: vi.fn().mockResolvedValue("deadbeef"),
  diffFiles: vi.fn().mockResolvedValue({
    added: ["src/new.ts"],
    modified: ["src/changed.ts"],
    deleted: ["src/old.ts"],
  }),
}));

describe("detectChanges", () => {
  const repo: RepoConfig = {
    name: "test-repo",
    url: "https://github.com/org/test-repo.git",
    branch: "main",
    localPath: "./data/mirrors/test-repo",
  };

  it("returns a ChangeSet with correct fields", async () => {
    const result = await detectChanges(repo, {
      mirrorDir: "/tmp/mirrors",
      previousCommits: new Map(),
    });
    expect(result.repo).toBe("test-repo");
    expect(result.commitHash).toBe("deadbeef");
    expect(result.previousCommitHash).toBeNull();
    expect(result.addedFiles).toEqual(["src/new.ts"]);
    expect(result.modifiedFiles).toEqual(["src/changed.ts"]);
    expect(result.deletedFiles).toEqual(["src/old.ts"]);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it("passes previous commit when available", async () => {
    const { diffFiles } = await import("./git.js");
    const result = await detectChanges(repo, {
      mirrorDir: "/tmp/mirrors",
      previousCommits: new Map([["test-repo", "prev123"]]),
    });
    expect(result.previousCommitHash).toBe("prev123");
    expect(diffFiles).toHaveBeenCalledWith(
      "/tmp/mirror/test-repo",
      "prev123",
      "deadbeef",
    );
  });
});
