import { execFile, spawn } from "node:child_process";
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
  options: GitOptions & { branch?: string },
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
    const cloneArgs = ["clone", "--bare"];
    if (options.branch) cloneArgs.push("-b", options.branch);
    cloneArgs.push(repoUrl, repoPath);
    await execFileAsync("git", cloneArgs, { timeout });
  }

  return repoPath;
}

export async function isBareRepo(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-bare-repository"],
      { cwd: repoPath },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getHeadCommit(repoPath: string, branch?: string): Promise<string> {
  const ref = branch ?? "HEAD";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", ref],
      { cwd: repoPath },
    );
    return stdout.trim();
  } catch {
    // Branch ref not found (e.g., "main" in a repo with "master"); fall back to HEAD
    if (ref !== "HEAD") {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: repoPath },
      );
      return stdout.trim();
    }
    throw new Error(`Cannot resolve HEAD in ${repoPath}`);
  }
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
  options?: { timeoutMs?: number },
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${commit}:${filePath}`],
    { cwd: repoPath, maxBuffer: 50 * 1024 * 1024, timeout: options?.timeoutMs },
  );
  return stdout;
}

/**
 * Read multiple files from a bare repo in a single `git cat-file --batch` process.
 * Much faster than spawning one `git show` per file, especially on blobless clones
 * where each show triggers a lazy blob fetch negotiation.
 *
 * Returns a Map<filePath, content>. Files that fail to read are omitted.
 */
export async function getFileContentBatch(
  repoPath: string,
  commit: string,
  filePaths: readonly string[],
): Promise<Map<string, string>> {
  if (filePaths.length === 0) return new Map();

  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 30_000;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const result = new Map<string, string>();
    const proc = spawn("git", ["cat-file", "--batch"], {
      cwd: repoPath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      proc.kill();
      settle(() => reject(new Error(`git cat-file --batch timed out after ${TIMEOUT_MS}ms`)));
    }, TIMEOUT_MS);

    const stdoutChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err) => settle(() => reject(err)));
    proc.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(`git cat-file --batch exited ${code}: ${stderr}`));
          return;
        }

        const stdout = Buffer.concat(stdoutChunks);

        // Parse batch output: each entry is "<oid> <type> <size>\n<content>\n"
        // or "<ref> missing\n" for missing objects
        let offset = 0;
        for (const filePath of filePaths) {
          // Find the header line
          const headerEnd = stdout.indexOf(0x0a, offset); // '\n'
          if (headerEnd === -1) break;
          const header = stdout.subarray(offset, headerEnd).toString("utf-8");

          if (header.endsWith("missing")) {
            offset = headerEnd + 1;
            continue;
          }

          // Parse "<oid> blob <size>"
          const sizeStr = header.split(" ").pop();
          const size = sizeStr ? parseInt(sizeStr, 10) : 0;
          if (isNaN(size) || size < 0) {
            offset = headerEnd + 1;
            continue;
          }

          const contentStart = headerEnd + 1;
          const contentEnd = contentStart + size;
          if (contentEnd > stdout.length) break;

          result.set(filePath, stdout.subarray(contentStart, contentEnd).toString("utf-8"));
          offset = contentEnd + 1; // skip trailing '\n'
        }

        resolve(result);
      });
    });

    // Write all refs to stdin then close; kill proc on write error
    const input = filePaths.map((fp) => `${commit}:${fp}\n`).join("");
    proc.stdin.write(input, (err) => {
      if (err) {
        proc.kill();
        settle(() => reject(err));
      }
    });
    proc.stdin.end();
  });
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
 *   ""                    → { from: "", to: "HEAD" }
 *
 * Note: an empty string produces from="" which will cause `git rev-parse`
 * to fail. Callers are responsible for validating the range before use.
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

export interface CommitFileChange {
  readonly hash: string;
  readonly filePath: string;
}

/**
 * Return a flat list of {hash, filePath} entries from the last `maxCommits`
 * commits in a (bare) repository.  Lines that look like a 40-hex-char SHA are
 * treated as commit boundaries; all non-empty lines that follow (until the
 * next SHA) are file paths.
 */
export async function getCommitHistory(
  repoPath: string,
  maxCommits: number = 200,
): Promise<CommitFileChange[]> {
  try {
    const bare = await isBareRepo(repoPath);
    const gitArgs = bare
      ? ["--git-dir", repoPath, "log"]
      : ["log"];
    gitArgs.push(
      "--name-only",
      "--diff-merges=first-parent",
      `--pretty=format:%H`,
      `-n`, String(maxCommits),
    );
    const { stdout } = await execFileAsync(
      "git",
      gitArgs,
      { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
    );

    const results: CommitFileChange[] = [];
    let currentHash = "";
    const SHA_RE = /^[0-9a-f]{40}$/;

    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (SHA_RE.test(line)) {
        currentHash = line;
      } else if (currentHash) {
        results.push({ hash: currentHash, filePath: line });
      }
    }

    return results;
  } catch (e) {
    console.warn(`[git] getCommitHistory failed for ${repoPath}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
