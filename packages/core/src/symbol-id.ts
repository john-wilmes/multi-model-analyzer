/**
 * Cross-repo stable symbol ID utilities.
 *
 * Canonical format: `<repo>:<relativePath>#<symbolName>`
 * - Symbol-level: `nestjs-core:src/auth.ts#AuthService.validate`
 * - File-level:   `my-app:src/index.ts` (no `#`)
 * - External:     `@org/auth` (no `:` — not canonical)
 *
 * Old format (non-canonical): `src/auth.ts#AuthService.validate` (no repo prefix)
 */

export interface ParsedSymbolId {
  readonly repo: string | undefined;
  readonly filePath: string;
  readonly symbolName: string | undefined;
  /** True when the ID contains a `:` repo prefix. */
  readonly isCanonical: boolean;
}

/**
 * Build a canonical symbol-level ID: `repo:filePath#symbolName`.
 * If `symbolName` is omitted, returns a file-level ID: `repo:filePath`.
 */
export function makeSymbolId(
  repo: string,
  filePath: string,
  symbolName?: string,
): string {
  return symbolName
    ? `${repo}:${filePath}#${symbolName}`
    : `${repo}:${filePath}`;
}

/**
 * Build a canonical file-level ID: `repo:filePath`.
 */
export function makeFileId(repo: string, filePath: string): string {
  return `${repo}:${filePath}`;
}

/**
 * Parse a symbol ID into its components.
 *
 * Handles both canonical (`repo:path#sym`) and old-format (`path#sym`) IDs.
 * External specifiers (`@org/auth`, `lodash`) are detected by the absence of `:`.
 */
export function parseSymbolId(id: string): ParsedSymbolId {
  const colonIdx = id.indexOf(":");
  const isCanonical = colonIdx >= 0;

  let repo: string | undefined;
  let rest: string;

  if (isCanonical) {
    repo = id.slice(0, colonIdx);
    rest = id.slice(colonIdx + 1);
  } else {
    repo = undefined;
    rest = id;
  }

  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    return {
      repo,
      filePath: rest.slice(0, hashIdx),
      symbolName: rest.slice(hashIdx + 1),
      isCanonical,
    };
  }

  return { repo, filePath: rest, symbolName: undefined, isCanonical };
}

/**
 * Extract the repo from a canonical ID. Returns `undefined` for non-canonical IDs.
 * Fast path — no full parse, just finds the first `:`.
 */
export function extractRepo(id: string): string | undefined {
  const colonIdx = id.indexOf(":");
  return colonIdx >= 0 ? id.slice(0, colonIdx) : undefined;
}

/**
 * Convert an old-format ID to canonical by prepending the repo.
 * If the ID is already canonical, returns it unchanged.
 */
export function canonicalize(id: string, repo: string): string {
  if (id.indexOf(":") >= 0) return id;
  return `${repo}:${id}`;
}
