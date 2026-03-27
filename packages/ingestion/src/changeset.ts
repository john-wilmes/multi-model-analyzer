import type { ChangeSet, ClassifiedFile, RepoConfig } from "@mma/core";
import { classifyFileKind } from "@mma/core";
import { cloneOrFetch, diffFiles, getHeadCommit, fetchLocalRepo, getTrackedCommit } from "./git.js";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface ChangeDetectionOptions {
  readonly mirrorDir: string;
  readonly previousCommits: ReadonlyMap<string, string>;
}

export async function detectChanges(
  repo: RepoConfig,
  options: ChangeDetectionOptions,
): Promise<ChangeSet> {
  // If localPath exists and is a git repo, fetch from origin first to ensure
  // we index the latest remote state on the configured branch, not whatever
  // happens to be checked out locally.
  let repoPath: string;
  let currentCommit: string;
  if (repo.localPath !== undefined && await isGitRepo(repo.localPath)) {
    repoPath = repo.localPath;
    await fetchLocalRepo(repoPath);
    currentCommit = await getTrackedCommit(repoPath, repo.branch);
  } else {
    repoPath = await cloneOrFetch(repo.url, repo.name, {
      mirrorDir: options.mirrorDir,
      branch: repo.branch,
    });
    currentCommit = await getHeadCommit(repoPath, repo.branch);
  }
  const previousCommit = options.previousCommits.get(repo.name) ?? null;

  const { added, modified, deleted } = await diffFiles(
    repoPath,
    previousCommit,
    currentCommit,
  );

  return {
    repo: repo.name,
    commitHash: currentCommit,
    previousCommitHash: previousCommit,
    addedFiles: added,
    modifiedFiles: modified,
    deletedFiles: deleted,
    timestamp: new Date(),
  };
}

export function classifyFile(
  filePath: string,
  repo: string,
): ClassifiedFile {
  const kind = classifyFileKind(filePath);
  return {
    path: filePath,
    repo,
    kind,
    relativePath: filePath,
  };
}

/** Paths that should never be indexed (compiled output, vendored deps). */
const EXCLUDED_PATH_SEGMENTS = ["dist/", "node_modules/", ".next/", "build/output/"];

export function isExcludedPath(filePath: string): boolean {
  return EXCLUDED_PATH_SEGMENTS.some(
    (seg) => filePath.startsWith(seg) || filePath.includes(`/${seg}`),
  );
}

export function classifyFiles(
  changeSet: ChangeSet,
): readonly ClassifiedFile[] {
  const allFiles = [
    ...changeSet.addedFiles,
    ...changeSet.modifiedFiles,
  ];
  return allFiles
    .filter((f) => !isExcludedPath(f))
    .map((f) => classifyFile(f, changeSet.repo));
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    // Working copy: has .git subdir. Bare repo: has HEAD file directly.
    await access(join(dirPath, ".git"));
    return true;
  } catch {
    try {
      await access(join(dirPath, "HEAD"));
      return true;
    } catch {
      return false;
    }
  }
}
