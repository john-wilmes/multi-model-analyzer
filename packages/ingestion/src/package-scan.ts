import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";

const execFileAsync = promisify(execFile);

/** Package info extracted from a single package.json. */
export interface PackageInfo {
  readonly name: string;
  readonly version?: string;
  readonly path: string; // relative path to package.json
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly peerDependencies: readonly string[];
}

/** All packages found in a single repo. */
export interface RepoPackages {
  readonly repo: string;
  readonly packages: readonly PackageInfo[];
}

/** Org-wide mapping of package name → repo name. */
export interface PackageMap {
  /** Maps npm package name → repo name that publishes it. */
  readonly packageToRepo: ReadonlyMap<string, string>;
  /** Maps repo name → list of package names it publishes. */
  readonly repoToPackages: ReadonlyMap<string, readonly string[]>;
  readonly builtAt: string; // ISO date
}

/**
 * Scan a repo for package.json files without a full clone.
 * Uses a shallow bare blobless clone, lists package.json paths via ls-tree,
 * then bulk-reads them via git cat-file --batch.
 */
export async function scanRepoPackages(
  repoUrl: string,
  repoName: string,
  options: { mirrorDir: string; branch?: string },
): Promise<RepoPackages> {
  const repoPath = join(options.mirrorDir, `${repoName}.git`);

  // Clone if not already present (shallow bare blobless for minimal cost)
  try {
    await access(repoPath);
  } catch {
    await mkdir(options.mirrorDir, { recursive: true });
    const cloneArgs = ["clone", "--bare", "--filter=blob:none", "--depth=1"];
    if (options.branch) cloneArgs.push("-b", options.branch);
    cloneArgs.push(repoUrl, repoPath);
    await execFileAsync("git", cloneArgs, { timeout: 60_000 });
  }

  // List all package.json files
  const { stdout: lsOutput } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "HEAD", "--name-only"],
    { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
  );

  const packageJsonPaths = lsOutput
    .trim()
    .split("\n")
    .filter(
      (p) => p.endsWith("package.json") && !p.includes("node_modules/"),
    );

  if (packageJsonPaths.length === 0) {
    return { repo: repoName, packages: [] };
  }

  // Bulk-read package.json files using getFileContentBatch from git.ts
  const { getFileContentBatch } = await import("./git.js");
  const contents = await getFileContentBatch(repoPath, "HEAD", packageJsonPaths);

  const packages: PackageInfo[] = [];
  for (const [path, content] of contents) {
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      if (!pkg["name"]) continue; // Skip package.json without a name field

      packages.push({
        name: pkg["name"] as string,
        version: pkg["version"] as string | undefined,
        path,
        dependencies: Object.keys(
          (pkg["dependencies"] as Record<string, string> | undefined) ?? {},
        ),
        devDependencies: Object.keys(
          (pkg["devDependencies"] as Record<string, string> | undefined) ?? {},
        ),
        peerDependencies: Object.keys(
          (pkg["peerDependencies"] as Record<string, string> | undefined) ?? {},
        ),
      });
    } catch {
      // Skip malformed package.json
    }
  }

  return { repo: repoName, packages };
}

/**
 * Build an org-wide package-name → repo mapping from multiple repos' packages.
 */
export function buildPackageMap(
  repoPackages: readonly RepoPackages[],
): PackageMap {
  const packageToRepo = new Map<string, string>();
  const repoToPackages = new Map<string, string[]>();

  for (const rp of repoPackages) {
    const names: string[] = [];
    for (const pkg of rp.packages) {
      packageToRepo.set(pkg.name, rp.repo);
      names.push(pkg.name);
    }
    if (names.length > 0) {
      repoToPackages.set(rp.repo, names);
    }
  }

  return {
    packageToRepo,
    repoToPackages,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Find which repos a given repo depends on, using the package map.
 * Returns repo names that publish packages consumed by the given repo.
 */
export function findRepoDependencies(
  repoPackages: RepoPackages,
  packageMap: PackageMap,
): {
  repo: string;
  packages: string[];
  type: "dependency" | "devDependency" | "peerDependency";
}[] {
  const result = new Map<
    string,
    {
      packages: string[];
      type: "dependency" | "devDependency" | "peerDependency";
    }
  >();

  for (const pkg of repoPackages.packages) {
    for (const dep of pkg.dependencies) {
      const targetRepo = packageMap.packageToRepo.get(dep);
      if (targetRepo && targetRepo !== repoPackages.repo) {
        const entry = result.get(targetRepo) ?? {
          packages: [],
          type: "dependency" as const,
        };
        entry.packages.push(dep);
        result.set(targetRepo, entry);
      }
    }
    for (const dep of pkg.devDependencies) {
      const targetRepo = packageMap.packageToRepo.get(dep);
      if (targetRepo && targetRepo !== repoPackages.repo) {
        if (!result.has(targetRepo)) {
          result.set(targetRepo, { packages: [dep], type: "devDependency" });
        } else {
          result.get(targetRepo)!.packages.push(dep);
        }
      }
    }
    for (const dep of pkg.peerDependencies) {
      const targetRepo = packageMap.packageToRepo.get(dep);
      if (targetRepo && targetRepo !== repoPackages.repo) {
        if (!result.has(targetRepo)) {
          result.set(targetRepo, { packages: [dep], type: "peerDependency" });
        } else {
          result.get(targetRepo)!.packages.push(dep);
        }
      }
    }
  }

  return Array.from(result.entries()).map(([repo, info]) => ({
    repo,
    packages: info.packages,
    type: info.type,
  }));
}
