import type { ChangeSet, ClassifiedFile, FileKind, RepoConfig } from "@mma/core";
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
  const kind = inferFileKind(filePath);
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

function inferFileKind(filePath: string): FileKind {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) return "yaml";
  if (/[Dd]ockerfile/.test(filePath)) return "dockerfile";
  if (filePath.includes("k8s") || filePath.includes("kubernetes")) return "kubernetes";
  if (filePath.endsWith(".md")) return "markdown";
  return "unknown";
}
