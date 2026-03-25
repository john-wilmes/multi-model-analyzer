import type { ChangeSet, ClassifiedFile, RepoConfig } from "@mma/core";
import { classifyFileKind } from "@mma/core";
import { cloneOrFetch, diffFiles, getHeadCommit } from "./git.js";
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
  // If localPath exists and is a git repo, use it directly (skip clone/fetch).
  // This supports pre-cloned working copies alongside bare mirrors.
  let repoPath: string;
  if (repo.localPath !== undefined && await isGitRepo(repo.localPath)) {
    repoPath = repo.localPath;
  } else {
    repoPath = await cloneOrFetch(repo.url, repo.name, {
      mirrorDir: options.mirrorDir,
      branch: repo.branch,
    });
  }

  const currentCommit = await getHeadCommit(repoPath, repo.branch);
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

export function classifyFiles(
  changeSet: ChangeSet,
): readonly ClassifiedFile[] {
  const allFiles = [
    ...changeSet.addedFiles,
    ...changeSet.modifiedFiles,
  ];
  return allFiles.map((f) => classifyFile(f, changeSet.repo));
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
