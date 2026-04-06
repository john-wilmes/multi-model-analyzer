/**
 * SCIP (Source Code Intelligence Protocol) index integration.
 *
 * SCIP provides cross-repo code intelligence: go-to-definition, find-references,
 * hover information across repository boundaries.
 *
 * For POC: shell out to scip-typescript to generate .scip index files.
 * Store index in KV store for query-time lookups.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @internal */
export interface ScipIndexResult {
  readonly repo: string;
  readonly indexPath: string;
  readonly symbolCount: number;
  readonly documentCount: number;
}

/** @internal */
export interface ScipSymbol {
  readonly symbol: string;
  readonly documentation: readonly string[];
  readonly relationships: readonly ScipRelationship[];
}

/** @internal */
export interface ScipRelationship {
  readonly symbol: string;
  readonly isDefinition: boolean;
  readonly isReference: boolean;
  readonly isImplementation: boolean;
}

/** @internal */
export async function generateScipIndex(
  repoPath: string,
  repo: string,
  outputPath: string,
): Promise<ScipIndexResult> {
  // scip-typescript generates a .scip protobuf file.
  // In POC, we assume scip-typescript is installed globally.
  try {
    await execFileAsync(
      "npx",
      ["scip-typescript", "index", "--output", outputPath],
      { cwd: repoPath, timeout: 300_000 },
    );
  } catch (err) {
    // Distinguish "tool not found" (expected in dev/CI) from real failures
    // (bad cwd, timeout, scip-typescript indexing error).  Only swallow the
    // former; surface the latter so callers are not silently misled.
    const isCommandNotFound =
      err instanceof Error &&
      (err.message.includes("ENOENT") ||
        err.message.includes("not found") ||
        err.message.includes("command not found") ||
        // execFile wraps ENOENT as a SystemError; check the code property too
        (err as NodeJS.ErrnoException).code === "ENOENT");

    if (!isCommandNotFound) {
      throw err;
    }

    // scip-typescript not installed — return empty result for graceful degradation
    return {
      repo,
      indexPath: outputPath,
      symbolCount: 0,
      documentCount: 0,
    };
  }

  return {
    repo,
    indexPath: outputPath,
    symbolCount: 0, // Would parse .scip protobuf for accurate counts
    documentCount: 0,
  };
}

/** @internal */
export function parseScipSymbolString(symbol: string): {
  scheme: string;
  package: string;
  descriptor: string;
} {
  // SCIP symbol format: scheme ' ' package ' ' descriptor
  // The descriptor may itself contain spaces (e.g. "some.Class method().").
  const parts = symbol.split(" ");
  return {
    scheme: parts[0] ?? "",
    package: parts[1] ?? "",
    descriptor: parts.slice(2).join(" "),
  };
}
