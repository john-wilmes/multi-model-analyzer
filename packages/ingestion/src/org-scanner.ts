import { Octokit } from "@octokit/rest";
import { join, basename } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** A discovered repo from an org scan. */
export interface DiscoveredRepo {
  readonly name: string;
  readonly fullName: string; // e.g. "supabase/supabase-js"
  readonly url: string; // clone URL (https)
  readonly sshUrl: string;
  readonly defaultBranch: string;
  readonly language: string | null;
  readonly updatedAt: string; // ISO date
  readonly archived: boolean;
  readonly fork: boolean;
  readonly starCount: number;
  readonly description: string | null;
}

/** Options for scanning a GitHub org. */
export interface OrgScanOptions {
  /** GitHub org name. */
  readonly org: string;
  /** GitHub personal access token. Uses GITHUB_TOKEN env var if not provided. */
  readonly token?: string;
  /** Exclude forked repos. Default: true. */
  readonly excludeForks?: boolean;
  /** Exclude archived repos. Default: true. */
  readonly excludeArchived?: boolean;
  /** Filter to repos with these primary languages (case-insensitive). Empty = no filter. */
  readonly languages?: readonly string[];
  /** Maximum number of repos to return. Default: no limit. */
  readonly limit?: number;
}

/** Result of an org scan. */
export interface OrgScanResult {
  readonly org: string;
  readonly repos: readonly DiscoveredRepo[];
  readonly scannedAt: string; // ISO date
  readonly totalReposInOrg: number; // before filtering
}

/**
 * Scan a GitHub org and return all repos matching the filter criteria.
 * Handles pagination automatically (GitHub returns 100/page max).
 */
export async function scanGitHubOrg(options: OrgScanOptions): Promise<OrgScanResult> {
  const token = options.token ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error("GitHub token required: set GITHUB_TOKEN env var or pass token option");
  }

  const octokit = new Octokit({ auth: token });
  const excludeForks = options.excludeForks ?? true;
  const excludeArchived = options.excludeArchived ?? true;
  const languages = (options.languages ?? []).map(l => l.toLowerCase());

  // Paginate through all repos
  const allRepos: DiscoveredRepo[] = [];
  let totalReposInOrg = 0;

  for await (const response of octokit.paginate.iterator(
    octokit.repos.listForOrg,
    { org: options.org, per_page: 100, type: "all", sort: "updated" }
  )) {
    for (const repo of response.data) {
      totalReposInOrg++;

      if (excludeForks && repo.fork) continue;
      if (excludeArchived && repo.archived) continue;
      if (
        languages.length > 0 &&
        (!repo.language || !languages.includes(repo.language.toLowerCase()))
      ) continue;

      allRepos.push({
        name: repo.name,
        fullName: repo.full_name,
        url: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
        sshUrl: repo.ssh_url ?? `git@github.com:${repo.full_name}.git`,
        defaultBranch: repo.default_branch ?? "main",
        language: repo.language ?? null,
        updatedAt: repo.updated_at ?? new Date().toISOString(),
        archived: repo.archived ?? false,
        fork: repo.fork ?? false,
        starCount: repo.stargazers_count ?? 0,
        description: repo.description ?? null,
      });

      if (options.limit !== undefined && allRepos.length >= options.limit) break;
    }
    if (options.limit !== undefined && allRepos.length >= options.limit) break;
  }

  return {
    org: options.org,
    repos: allRepos,
    scannedAt: new Date().toISOString(),
    totalReposInOrg,
  };
}

/**
 * Scan a local directory for git repos (non-GitHub alternative).
 * Looks for directories containing a .git folder or bare repos (ending in .git).
 */
export async function scanLocalDirectory(dirPath: string): Promise<DiscoveredRepo[]> {
  const execFileAsync = promisify(execFile);

  const entries = await readdir(dirPath, { withFileTypes: true });
  const repos: DiscoveredRepo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(dirPath, entry.name);

    // Check if it's a git repo (has .git dir or is bare)
    let isRepo = false;

    try {
      const gitDir = join(fullPath, ".git");
      await stat(gitDir);
      isRepo = true;
    } catch {
      // Check if bare repo
      try {
        const { stdout } = await execFileAsync(
          "git", ["rev-parse", "--is-bare-repository"],
          { cwd: fullPath }
        );
        isRepo = stdout.trim() === "true";
      } catch {
        // Not a git repo
      }
    }

    if (!isRepo) continue;

    let defaultBranch = "main";
    try {
      const { stdout } = await execFileAsync(
        "git", ["symbolic-ref", "--short", "HEAD"],
        { cwd: fullPath }
      );
      defaultBranch = stdout.trim();
    } catch {
      // Use default
    }

    const name = basename(entry.name, ".git");
    repos.push({
      name,
      fullName: name,
      url: fullPath,
      sshUrl: fullPath,
      defaultBranch,
      language: null,
      updatedAt: new Date().toISOString(),
      archived: false,
      fork: false,
      starCount: 0,
      description: null,
    });
  }

  return repos;
}
