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

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const status = line[0];
    const filePath = line.slice(2);
    switch (status) {
      case "A":
        added.push(filePath);
        break;
      case "M":
        modified.push(filePath);
        break;
      case "D":
        deleted.push(filePath);
        break;
      default:
        modified.push(filePath);
    }
  }

  return { added, modified, deleted };
}

export async function getFileContent(
  repoPath: string,
  commit: string,
  filePath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${commit}:${filePath}`],
    { cwd: repoPath },
  );
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
