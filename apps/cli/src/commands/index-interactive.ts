/**
 * Interactive incremental indexing workflow (`mma explore`).
 *
 * Guides the user through discovering and indexing repos one at a time,
 * following connections between repos rather than indexing everything upfront.
 */

import { input, select, checkbox, confirm } from "@inquirer/prompts";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";
import {
  scanGitHubOrg,
  scanLocalDirectory,
  scanRepoPackages,
  buildPackageMap,
} from "@mma/ingestion";
import type { DiscoveredRepo, RepoPackages } from "@mma/ingestion";
import {
  RepoStateManager,
  discoverConnections,
} from "@mma/correlation";

export interface ExploreCommandOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly mirrorDir: string;
  readonly verbose?: boolean;
}

export async function exploreCommand(options: ExploreCommandOptions): Promise<void> {
  const { kvStore, mirrorDir, verbose } = options;
  const stateManager = new RepoStateManager(kvStore);

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
          branch: repo.defaultBranch,
          // For local repos the url is the filesystem path; for remote repos
          // the mirror dir will be used by the ingestion layer.
          localPath: repo.url,
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
