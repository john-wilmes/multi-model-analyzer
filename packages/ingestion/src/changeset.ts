import type { ChangeSet, ClassifiedFile, RepoConfig } from "@mma/core";
import { classifyFileKind } from "@mma/core";
import { cloneOrFetch, diffFiles, getHeadCommit } from "./git.js";

export interface ChangeDetectionOptions {
  readonly mirrorDir: string;
  readonly previousCommits: ReadonlyMap<string, string>;
}

export async function detectChanges(
  repo: RepoConfig,
  options: ChangeDetectionOptions,
): Promise<ChangeSet> {
  const repoPath = await cloneOrFetch(repo.url, repo.name, {
    mirrorDir: options.mirrorDir,
  });

  const currentCommit = await getHeadCommit(repoPath);
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
