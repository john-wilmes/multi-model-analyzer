/**
 * Interactive incremental indexing workflow (`mma explore`).
 *
 * Guides the user through discovering and indexing repos one at a time,
 * following connections between repos rather than indexing everything upfront.
 */

import { input, select, checkbox, confirm } from "@inquirer/prompts";
import { execFile } from "node:child_process";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";
import {
  scanGitHubOrg,
  scanLocalDirectory,
  scanRepoPackages,
  buildPackageMap,
} from "@mma/ingestion";
import type { DiscoveredRepo, RepoPackages, PackageMap } from "@mma/ingestion";
import {
  RepoStateManager,
  discoverConnections,
  extractPackageName,
} from "@mma/correlation";
import { extractRepo } from "@mma/core";

export interface ExploreCommandOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly mirrorDir: string;
  readonly verbose?: boolean;
  readonly seedUrl?: string;
}

export async function exploreCommand(options: ExploreCommandOptions): Promise<void> {
  const { kvStore, mirrorDir, verbose } = options;
  const stateManager = new RepoStateManager(kvStore);

  // If a seed URL was provided, skip org/dir scan and start from that single repo.
  if (options.seedUrl) {
    await exploreSeedUrl(options.seedUrl, stateManager, options);
    return;
  }

  // Step 1: Check for existing state
  const existingStates = await stateManager.getAll();
  let repos: DiscoveredRepo[] = [];

  if (existingStates.length > 0) {
    const summary = await stateManager.summary();
    console.log(
      `\nExisting state: ${summary.indexed} indexed, ${summary.candidate} candidates, ${summary.ignored} ignored`,
    );

    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Continue exploring (show candidates)", value: "continue" },
        { name: "Scan for new repos", value: "scan" },
        { name: "Show indexed repos", value: "show" },
      ],
    });

    if (action === "show") {
      const indexed = await stateManager.getByStatus("indexed");
      for (const r of indexed) {
        console.log(`  ${r.name} (indexed ${r.indexedAt ?? "unknown"})`);
      }
      return;
    }

    if (action === "continue") {
      await handleCandidates(stateManager, options, mirrorDir);
      return;
    }
    // action === "scan" falls through to the scan step below
  }

  // Step 2: Scan source
  const source = await select({
    message: "Where should we look for repos?",
    choices: [
      { name: "GitHub organization", value: "github" },
      { name: "Local directory", value: "local" },
    ],
  });

  if (source === "github") {
    const org = (await input({ message: "GitHub org name:" })).trim();
    if (!org) {
      console.error("Organization name cannot be empty.");
      return;
    }
    const token = process.env["GITHUB_TOKEN"];
    if (!token) {
      console.error("Set GITHUB_TOKEN environment variable for GitHub org scanning.");
      return;
    }

    console.log(`Scanning ${org}...`);
    const result = await scanGitHubOrg({ org, token });
    console.log(
      `Found ${result.repos.length} repos (${result.totalReposInOrg} total, after filtering forks/archived)`,
    );
    repos = [...result.repos];

    // Cache scan result
    await kvStore.set(`org-scan:${org}`, JSON.stringify(result));
  } else {
    const dirPath = (await input({ message: "Directory path:" })).trim();
    if (!dirPath) {
      console.error("Directory path cannot be empty.");
      return;
    }
    console.log(`Scanning ${dirPath}...`);
    repos = [...(await scanLocalDirectory(dirPath))];
    console.log(`Found ${repos.length} repos`);
  }

  if (repos.length === 0) {
    console.log("No repos found.");
    return;
  }

  // Register all as candidates
  for (const repo of repos) {
    await stateManager.addCandidate(
      {
        name: repo.name,
        url: repo.url,
        defaultBranch: repo.defaultBranch,
        language: repo.language ?? undefined,
      },
      "org-scan",
    );
  }

  // Step 3: Pick seed repo
  const seedName = await select({
    message: "Which repo to start with?",
    choices: repos
      .slice()
      .sort((a, b) => b.starCount - a.starCount)
      .slice(0, 50) // limit choices for usability
      .map((r) => ({
        name: `${r.name}${r.language ? ` (${r.language})` : ""}${r.starCount ? ` \u2605${r.starCount}` : ""}`,
        value: r.name,
      })),
  });

  // Step 4: Index the seed repo
  const seedRepo = repos.find((r) => r.name === seedName);
  if (!seedRepo) {
    console.error(`Repo not found: ${seedName}`);
    return;
  }
  await indexSingleRepo(seedRepo, stateManager, options, mirrorDir, verbose);

  // Step 5: Discovery loop
  await discoveryLoop(seedRepo, stateManager, options, mirrorDir, repos, verbose);
}

async function indexSingleRepo(
  repo: DiscoveredRepo,
  stateManager: RepoStateManager,
  options: ExploreCommandOptions,
  mirrorDir: string,
  verbose?: boolean,
): Promise<void> {
  const { kvStore, graphStore, searchStore } = options;

  console.log(`\nIndexing ${repo.name}...`);
  await stateManager.startIndexing(repo.name);

  try {
    // Dynamic import to avoid circular dependency at module load time
    const { indexCommand } = await import("./index-cmd.js");
    await indexCommand({
      repos: [
        {
          name: repo.name,
          url: repo.url,
          branch: repo.defaultBranch || undefined,
          // For local repos the url is the filesystem path; for remote repos
          // omit localPath so index-cmd falls back to mirrorDir.
          localPath: repo.url.startsWith("/") ? repo.url : undefined,
        },
      ],
      mirrorDir,
      kvStore,
      graphStore,
      searchStore,
      verbose: verbose ?? false,
      rules: [],
    });

    await stateManager.markIndexed(repo.name);
    console.log(`  \u2713 ${repo.name} indexed successfully`);
  } catch (err) {
    console.error(
      `  \u2717 Failed to index ${repo.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // State remains "indexing" — user can retry by re-running explore
  }
}

async function discoveryLoop(
  lastIndexed: DiscoveredRepo,
  stateManager: RepoStateManager,
  options: ExploreCommandOptions,
  mirrorDir: string,
  allRepos: DiscoveredRepo[],
  verbose?: boolean,
): Promise<void> {
  const { graphStore, kvStore } = options;

  // Pre-scan all repos for package.json to build package map
  console.log("\nPre-scanning package.json files across all repos...");
  const allRepoPackages: RepoPackages[] = [];
  for (const repo of allRepos) {
    try {
      const pkgs = await scanRepoPackages(repo.url, repo.name, {
        mirrorDir,
        branch: repo.defaultBranch,
      });
      allRepoPackages.push(pkgs);
    } catch {
      // Skip repos that fail pre-scan (e.g. no package.json, bare clone issues)
    }
  }
  const packageMap = buildPackageMap(allRepoPackages);
  console.log(
    `Package map: ${packageMap.packageToRepo.size} packages across ${packageMap.repoToPackages.size} repos`,
  );

  // Persist package map for future sessions
  await kvStore.set(
    "package-map",
    JSON.stringify({
      packageToRepo: Object.fromEntries(packageMap.packageToRepo),
      repoToPackages: Object.fromEntries(
        [...packageMap.repoToPackages].map(([k, v]) => [k, v]),
      ),
      builtAt: packageMap.builtAt,
    }),
  );

  // Mutable cursor tracking which repo to discover connections from
  let currentRepo = lastIndexed;
  let continueExploring = true;

  while (continueExploring) {
    const connections = await discoverConnections({
      indexedRepo: currentRepo.name,
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages,
    });

    if (connections.length === 0) {
      console.log("\nNo new connections discovered.");

      const candidates = await stateManager.getByStatus("candidate");
      if (candidates.length > 0) {
        const exploreMore = await confirm({
          message: `${candidates.length} unconnected repos remain. Explore more?`,
        });
        if (exploreMore) {
          await handleCandidates(stateManager, options, mirrorDir, verbose);
        }
      }
      break;
    }

    console.log(`\nConnections from ${currentRepo.name}:`);
    for (const conn of connections) {
      console.log(`  ${conn.repo} (${conn.connectionType}, ${conn.edgeCount} edges from ${conn.fromRepo})`);
    }

    const selected = await checkbox({
      message: "Which repos should we index? (space to select, enter to confirm)",
      choices: [
        ...connections.map((c) => ({
          name: `${c.repo} (${c.connectionType}, ${c.edgeCount} edges)`,
          value: c.repo,
        })),
        { name: "-- Done exploring --", value: "__done__" },
      ],
    });

    if (selected.includes("__done__") || selected.length === 0) {
      continueExploring = false;
      break;
    }

    // Mark unselected connections as ignored
    for (const conn of connections) {
      if (!selected.includes(conn.repo)) {
        try {
          await stateManager.markIgnored(conn.repo);
        } catch {
          // May already be in a state that prevents transition — skip
        }
      }
    }

    // Index each selected repo in order
    let lastSuccessfulRepo: DiscoveredRepo | undefined;
    for (const repoName of selected) {
      if (repoName === "__done__") continue;
      const repo = allRepos.find((r) => r.name === repoName);
      if (repo) {
        await indexSingleRepo(repo, stateManager, options, mirrorDir, verbose);
        lastSuccessfulRepo = repo;
      }
    }

    // Advance cursor to the last successfully queued repo for next iteration
    if (lastSuccessfulRepo) {
      currentRepo = lastSuccessfulRepo;
    }
  }

  // Final summary
  const summary = await stateManager.summary();
  console.log(`\nExploration complete:`);
  console.log(`  Indexed: ${summary.indexed}`);
  console.log(`  Candidates remaining: ${summary.candidate}`);
  console.log(`  Ignored: ${summary.ignored}`);
}

async function handleCandidates(
  stateManager: RepoStateManager,
  options: ExploreCommandOptions,
  mirrorDir: string,
  verbose?: boolean,
): Promise<void> {
  const candidates = await stateManager.getByStatus("candidate");
  if (candidates.length === 0) {
    console.log("No candidates available.");
    return;
  }

  const selected = await checkbox({
    message: `${candidates.length} candidates. Select repos to index:`,
    choices: candidates.map((c) => ({
      name: `${c.name} (${c.connectionCount} connections, via ${c.discoveredVia})`,
      value: c.name,
    })),
  });

  for (const name of selected) {
    const state = await stateManager.get(name);
    if (!state) continue;

    const repo: DiscoveredRepo = {
      name: state.name,
      fullName: state.name,
      url: state.url,
      sshUrl: state.url,
      defaultBranch: state.defaultBranch ?? "main",
      language: state.language ?? null,
      updatedAt: state.discoveredAt,
      archived: false,
      fork: false,
      starCount: 0,
      description: null,
    };

    await indexSingleRepo(repo, stateManager, options, mirrorDir, verbose);
  }
}

/**
 * Derive a stable, org-qualified identifier from a clone URL.
 * Returns "owner/repo" when the URL has at least two path segments, otherwise
 * falls back to just the repo basename.  Always strips .git and query/hash.
 */
function repoNameFromUrl(url: string): string {
  const cleaned = (url.replace(/\.git$/, "").split(/[?#]/)[0] ?? "").replace(/\/$/, "");
  // Strip scheme + host to get the path segments (works for https:// and git@)
  const path = cleaned.replace(/^(?:https?:\/\/|git@)[^/:]+[/:]/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  const name = parts[parts.length - 1] ?? "";
  if (!name) throw new Error(`Could not derive repo name from URL: ${url}`);
  return name;
}

/**
 * Probe the remote to detect its default branch.
 * Uses `git ls-remote --symref <url> HEAD` and parses the `ref: refs/heads/<branch>` line.
 * Falls back to "main" if the probe fails or the output is unparseable.
 */
async function detectDefaultBranch(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["ls-remote", "--symref", url, "HEAD"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout);
      resolve(match?.[1]);
    });
  });
}

/**
 * Entry point for `mma explore --repo <url>`.
 * Indexes a single seed repo then runs a lazy outward-discovery loop.
 */
async function exploreSeedUrl(
  seedUrl: string,
  stateManager: RepoStateManager,
  options: ExploreCommandOptions,
): Promise<void> {
  const { mirrorDir, verbose } = options;
  let name: string;
  try {
    name = repoNameFromUrl(seedUrl);
  } catch (err) {
    console.error(`Invalid repo URL: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  console.log(`\nStarting from ${name} (${seedUrl})`);
  console.log("  Detecting default branch...");
  const detectedBranch = await detectDefaultBranch(seedUrl);
  console.log(detectedBranch ? `  Default branch: ${detectedBranch}` : "  Default branch: (not detected, will use remote HEAD)");

  const seed: DiscoveredRepo = {
    name,
    fullName: name,
    url: seedUrl,
    sshUrl: seedUrl,
    defaultBranch: detectedBranch ?? "",
    language: null,
    updatedAt: new Date().toISOString(),
    archived: false,
    fork: false,
    starCount: 0,
    description: null,
  };

  const existing = await stateManager.get(name);
  if (existing?.status !== "indexed") {
    await stateManager.addCandidate({ name, url: seedUrl, defaultBranch: detectedBranch ?? "" }, "user-selected");
    await indexSingleRepo(seed, stateManager, options, mirrorDir, verbose);
    const postIndex = await stateManager.get(name);
    if (postIndex?.status !== "indexed") return;
  } else {
    console.log(`  ${name} is already indexed.`);
  }

  await lazyDiscoveryLoop(seed, stateManager, options);
}

/**
 * Discovery loop for the single-URL entry path.
 *
 * Unlike the full `discoveryLoop`, this builds the package map incrementally —
 * starting from just the seed and growing as the user adds more repos.
 * When structured connection discovery finds nothing (sparse package map),
 * it surfaces unresolved external imports and lets the user provide URLs.
 */
async function lazyDiscoveryLoop(
  seedRepo: DiscoveredRepo,
  stateManager: RepoStateManager,
  options: ExploreCommandOptions,
): Promise<void> {
  const { graphStore, mirrorDir, verbose } = options;

  const allRepos: DiscoveredRepo[] = [seedRepo];
  const allRepoPackages: RepoPackages[] = [];

  try {
    const pkgs = await scanRepoPackages(seedRepo.url, seedRepo.name, {
      mirrorDir,
      branch: seedRepo.defaultBranch,
    });
    allRepoPackages.push(pkgs);
  } catch {
    // seed may not have a package.json
  }

  let packageMap: PackageMap = buildPackageMap(allRepoPackages);
  let currentRepo = seedRepo;

  while (true) {
    // 1. Try structured connection discovery (works when packageMap has entries)
    const connections = await discoverConnections({
      indexedRepo: currentRepo.name,
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages,
    });

    if (connections.length > 0) {
      console.log(`\nConnections from ${currentRepo.name}:`);
      for (const conn of connections) {
        console.log(`  ${conn.repo} (${conn.connectionType}, ${conn.edgeCount} edges)`);
      }

      const selected = await checkbox({
        message: "Which repos should we index? (space to select, enter to confirm)",
        choices: [
          ...connections.map((c) => ({
            name: `${c.repo} (${c.connectionType}, ${c.edgeCount} edges)`,
            value: c.repo,
          })),
          { name: "-- Done exploring --", value: "__done__" },
        ],
      });

      if (selected.includes("__done__") || selected.length === 0) break;

      for (const conn of connections) {
        if (!selected.includes(conn.repo)) {
          try { await stateManager.markIgnored(conn.repo); } catch { /* skip */ }
        }
      }

      let lastSuccessful: DiscoveredRepo | undefined;
      for (const repoName of selected) {
        if (repoName === "__done__") continue;
        const knownRepo = allRepos.find((r) => r.name === repoName);
        if (knownRepo) {
          await indexSingleRepo(knownRepo, stateManager, options, mirrorDir, verbose);
          if ((await stateManager.get(knownRepo.name))?.status === "indexed") {
            lastSuccessful = knownRepo;
          }
        } else {
          // Connection resolved by name but no URL yet — prompt user
          const added = await promptForRepoUrl(repoName, stateManager, options);
          if (added) {
            allRepos.push(added);
            await addToPackageMap(added, allRepoPackages, mirrorDir);
            packageMap = buildPackageMap(allRepoPackages);
            lastSuccessful = added;
          }
        }
      }

      if (lastSuccessful) currentRepo = lastSuccessful;
      continue;
    }

    // 2. No structured connections — surface unresolved external imports
    const unresolved = await findUnresolvedImports(
      currentRepo.name,
      graphStore,
      packageMap,
      stateManager,
    );

    if (unresolved.length === 0) {
      console.log("\nNo more connections found.");
      break;
    }

    console.log(`\nUnresolved external imports from ${currentRepo.name}:`);
    const chosen = await checkbox({
      message: "Select packages to provide a repo URL for (space to select, enter to confirm):",
      choices: [
        ...unresolved.map((pkg) => ({ name: pkg, value: pkg })),
        { name: "-- Done exploring --", value: "__done__" },
      ],
    });

    if (chosen.includes("__done__") || chosen.length === 0) break;

    // Mark packages the user skipped as ignored so they don't resurface
    for (const pkg of unresolved) {
      if (!chosen.includes(pkg)) {
        try { await stateManager.addCandidate({ name: pkg, url: "" }, "user-selected"); } catch { /* already in state machine */ }
        try { await stateManager.markIgnored(pkg); } catch { /* skip */ }
      }
    }

    let lastSuccessful: DiscoveredRepo | undefined;
    for (const pkg of chosen) {
      if (pkg === "__done__") continue;
      const added = await promptForRepoUrl(pkg, stateManager, options);
      if (added) {
        allRepos.push(added);
        await addToPackageMap(added, allRepoPackages, mirrorDir);
        packageMap = buildPackageMap(allRepoPackages);
        lastSuccessful = added;
      }
    }

    if (!lastSuccessful) break;
    currentRepo = lastSuccessful;
  }

  const summary = await stateManager.summary();
  console.log(`\nExploration complete:`);
  console.log(`  Indexed: ${summary.indexed}`);
  console.log(`  Candidates remaining: ${summary.candidate}`);
  console.log(`  Ignored: ${summary.ignored}`);
}

/**
 * Scan a newly added repo's package.json and append its entries to allRepoPackages.
 */
async function addToPackageMap(
  repo: DiscoveredRepo,
  allRepoPackages: RepoPackages[],
  mirrorDir: string,
): Promise<void> {
  try {
    const pkgs = await scanRepoPackages(repo.url, repo.name, {
      mirrorDir,
      branch: repo.defaultBranch,
    });
    allRepoPackages.push(pkgs);
  } catch {
    // repo may not have a package.json
  }
}

/**
 * Find external package names imported by a repo that can't be resolved to known repos.
 * These are candidates for the user to provide URLs for.
 */
async function findUnresolvedImports(
  repoName: string,
  graphStore: GraphStore,
  packageMap: PackageMap,
  stateManager: RepoStateManager,
): Promise<string[]> {
  const seen = new Set<string>();
  for (const kind of ["imports", "depends-on"] as const) {
    const edges = await graphStore.getEdgesByKind(kind, repoName);
    for (const edge of edges) {
      if (extractRepo(edge.target) !== undefined) continue; // already a resolved repo ID
      const pkg = extractPackageName(edge.target);
      if (pkg === null) continue;
      if (packageMap.packageToRepo.has(pkg)) continue; // already resolved via package map
      const state = await stateManager.get(pkg);
      if (state?.status === "indexed" || state?.status === "ignored") continue;
      seen.add(pkg);
    }
  }
  return [...seen].sort();
}

/**
 * Prompt the user for a clone URL for a package/repo name they want to add.
 * Indexes the repo if a URL is provided; marks it ignored if skipped.
 */
async function promptForRepoUrl(
  packageOrRepoName: string,
  stateManager: RepoStateManager,
  options: ExploreCommandOptions,
): Promise<DiscoveredRepo | undefined> {
  const { mirrorDir, verbose } = options;
  const url = (
    await input({
      message: `Repo URL for "${packageOrRepoName}" (leave blank to skip):`,
    })
  ).trim();

  if (!url) {
    // Mark as ignored so it doesn't keep appearing
    try {
      await stateManager.addCandidate({ name: packageOrRepoName, url: "" }, "user-selected");
    } catch {
      // already known — just mark ignored
    }
    await stateManager.markIgnored(packageOrRepoName);
    return undefined;
  }

  let name: string;
  try {
    name = repoNameFromUrl(url);
  } catch {
    console.error(`  Invalid URL: ${url}`);
    return undefined;
  }
  const detectedBranch = await detectDefaultBranch(url);
  const repo: DiscoveredRepo = {
    name,
    fullName: name,
    url,
    sshUrl: url,
    defaultBranch: detectedBranch ?? "",
    language: null,
    updatedAt: new Date().toISOString(),
    archived: false,
    fork: false,
    starCount: 0,
    description: null,
  };

  const existing = await stateManager.get(name);
  if (existing?.status !== "indexed") {
    await stateManager.addCandidate({ name, url, defaultBranch: detectedBranch ?? "" }, "user-selected");
    await indexSingleRepo(repo, stateManager, options, mirrorDir, verbose);
    const postIndex = await stateManager.get(name);
    if (postIndex?.status !== "indexed") return undefined;
  }
  return repo;
}
