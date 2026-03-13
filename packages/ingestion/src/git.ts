import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitOptions {
  readonly mirrorDir: string;
  readonly timeout?: number;
}

export async function cloneOrFetch(
  repoUrl: string,
  repoName: string,
  options: GitOptions,
): Promise<string> {
  const repoPath = join(options.mirrorDir, `${repoName}.git`);
  const timeout = options.timeout ?? 120_000;

  if (await exists(repoPath)) {
    await execFileAsync("git", ["fetch", "--all"], {
      cwd: repoPath,
      timeout,
    });
  } else {
    await mkdir(options.mirrorDir, { recursive: true });
    await execFileAsync("git", ["clone", "--bare", repoUrl, repoPath], {
      timeout,
    });
  }

  return repoPath;
}

export async function getHeadCommit(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoPath },
  );
  return stdout.trim();
}

export async function diffFiles(
  repoPath: string,
  fromCommit: string | null,
  toCommit: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  if (fromCommit === null) {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-tree", "-r", "--name-only", toCommit],
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
    );
    return {
      added: stdout.trim().split("\n").filter(Boolean),
      modified: [],
      deleted: [],
    };
  }

  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-status", fromCommit, toCommit],
    { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
  );

  return parseNameStatus(stdout);
}

export async function getFileContent(
  repoPath: string,
  commit: string,
  filePath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${commit}:${filePath}`],
    { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout;
}

export function parseNameStatus(
  stdout: string,
): { added: string[]; modified: string[]; deleted: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const statusCode = parts[0]!;
    // R100 or C100 have a score suffix; strip to get the base letter
    const status = statusCode[0];
    switch (status) {
      case "A":
        added.push(parts[1]!);
        break;
      case "M":
        modified.push(parts[1]!);
        break;
      case "D":
        deleted.push(parts[1]!);
        break;
      case "R":
        // Rename: old path deleted, new path added
        deleted.push(parts[1]!);
        added.push(parts[2]!);
        break;
      case "C":
        // Copy: new path added (old path unchanged)
        added.push(parts[2]!);
        break;
      default:
        modified.push(parts[1]!);
    }
  }

  return { added, modified, deleted };
}

export interface RevisionRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Parse a git revision range string into from/to refs.
 *
 * Supports formats:
 *   "abc123..def456"      → { from: "abc123", to: "def456" }
 *   "main..feature"       → { from: "main", to: "feature" }
 *   "HEAD~3..HEAD"        → { from: "HEAD~3", to: "HEAD" }
 *   "HEAD~3"              → { from: "HEAD~3", to: "HEAD" }
 *   "abc123"              → { from: "abc123", to: "HEAD" }
 */
export function parseRevisionRange(range: string): RevisionRange {
  const dotDot = range.indexOf("..");
  if (dotDot >= 0) {
    const from = range.slice(0, dotDot);
    const rest = range.slice(dotDot + 2);
    // Handle "..." (three-dot merge-base) by stripping extra dot
    const to = rest.startsWith(".") ? rest.slice(1) : rest;
    return { from: from || "HEAD", to: to || "HEAD" };
  }
  return { from: range, to: "HEAD" };
}

/**
 * Resolve a revision range and extract changed files from a repo.
 */
export async function getChangedFilesInRange(
  repoPath: string,
  range: string,
): Promise<{ from: string; to: string; added: string[]; modified: string[]; deleted: string[] }> {
  const { from, to } = parseRevisionRange(range);

  // Resolve refs to concrete SHAs
  const { stdout: fromSha } = await execFileAsync(
    "git", ["rev-parse", from], { cwd: repoPath },
  );
  const { stdout: toSha } = await execFileAsync(
    "git", ["rev-parse", to], { cwd: repoPath },
  );

  const files = await diffFiles(repoPath, fromSha.trim(), toSha.trim());

  return {
    from: fromSha.trim(),
    to: toSha.trim(),
    ...files,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
