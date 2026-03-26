/**
 * Phase 2: File classification and packageRoots map construction.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { RepoConfig, ChangeSet } from "@mma/core";
import type { KVStore } from "@mma/storage";
import { classifyFiles, getFileContent } from "@mma/ingestion";
import { checkBareRepo, resolveCommitForBare } from "./bare-repo.js";

export interface PhaseClassifyInput {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly log: (...args: unknown[]) => void;
  readonly changeSets: readonly ChangeSet[];
  readonly classifiedByRepo: Map<string, ReturnType<typeof classifyFiles>>;
  readonly packageRoots: Map<string, string>;
  readonly forceFullReindex?: boolean;
}

export async function runPhaseClassify(input: PhaseClassifyInput): Promise<void> {
  const { repos, mirrorDir, kvStore, log, changeSets, classifiedByRepo, packageRoots } = input;

  for (const changeSet of changeSets) {
    const classified = classifyFiles(changeSet);
    classifiedByRepo.set(changeSet.repo, classified);
    log(`  ${changeSet.repo}: ${classified.length} files classified`);
  }

  // Build cross-repo packageRoots map before Phase 3 so it's available for
  // dependency extraction (Phase 4). Only reads classified package.json files.
  const hasClassifiedFiles = [...classifiedByRepo.values()].some(c => c.length > 0);
  if (!hasClassifiedFiles) {
    // Incremental run with 0 changes — restore cached packageRoots from previous run
    const cached = await kvStore.get("_packageRoots");
    if (cached) {
      try {
        const entries = JSON.parse(cached) as [string, string][];
        for (const [name, dir] of entries) {
          packageRoots.set(name, dir);
        }
        log(`  Restored packageRoots from cache: ${packageRoots.size} packages`);
      } catch { /* ignore malformed cache entry */ }
    }
    // If cache was empty (e.g., first run after upgrade), scan repos via git
    if (packageRoots.size === 0) {
      await Promise.all(repos.map(async (repo) => {
        try {
          const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
          const isBare = await checkBareRepo(repoPath);
          const commit = await resolveCommitForBare(repoPath, changeSets, repo.name);
          const { execSync } = await import("node:child_process");
          const lsOutput = execSync(
            `git ls-tree -r --name-only ${commit}`,
            { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
          );
          const pjPaths = lsOutput.split("\n").filter(p => p.endsWith("/package.json") || p === "package.json");
          await Promise.all(pjPaths.map(async (pjPath) => {
            try {
              const raw = isBare
                ? await getFileContent(repoPath, commit, pjPath)
                : await readFile(join(repoPath, pjPath), "utf-8");
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const name = parsed.name as string | undefined;
              if (name) {
                packageRoots.set(name, join(repoPath, dirname(pjPath)));
              }
            } catch { /* skip unreadable */ }
          }));
        } catch { /* skip repos that fail git ls-tree */ }
      }));
      if (packageRoots.size > 0) {
        await kvStore.set("_packageRoots", JSON.stringify([...packageRoots.entries()]));
        log(`  Built packageRoots from git scan: ${packageRoots.size} packages`);
      }
    }
  } else {
    // Incremental mode: seed from cache so unchanged repos' packages are preserved
    const cachedPkgRoots = await kvStore.get("_packageRoots");
    if (cachedPkgRoots) {
      try {
        const entries = JSON.parse(cachedPkgRoots) as [string, string][];
        for (const [name, dir] of entries) {
          packageRoots.set(name, dir);
        }
      } catch { /* skip malformed cache */ }
    }
    await Promise.all(repos.map(async (repo) => {
      const classified = classifiedByRepo.get(repo.name);
      if (!classified) return;
      const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
      const packageJsonFiles = classified.filter(
        (f) => f.kind === "json" && f.path.endsWith("package.json"),
      );
      const isBare = await checkBareRepo(repoPath);
      await Promise.all(packageJsonFiles.map(async (pjFile) => {
        try {
          const raw = isBare
            ? await getFileContent(repoPath, await resolveCommitForBare(repoPath, changeSets, repo.name), pjFile.path)
            : await readFile(join(repoPath, pjFile.path), "utf-8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const name = parsed.name as string | undefined;
          if (name) {
            const absDir = join(repoPath, dirname(pjFile.path));
            if (packageRoots.has(name)) {
              log(`    warning: duplicate package name "${name}" (overwriting ${packageRoots.get(name)} with ${absDir})`);
            }
            packageRoots.set(name, absDir);
          }
        } catch {
          // Skip unreadable package.json files
        }
      }));
    }));
    if (packageRoots.size > 0) {
      await kvStore.set("_packageRoots", JSON.stringify([...packageRoots.entries()]));
      log(`  Built packageRoots map: ${packageRoots.size} packages across all repos`);
    }
  }
}
