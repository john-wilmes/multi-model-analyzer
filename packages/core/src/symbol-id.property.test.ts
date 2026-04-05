import { describe, it } from "vitest";
import fc from "fast-check";
import {
  makeSymbolId,
  makeFileId,
  parseSymbolId,
  extractRepo,
  canonicalize,
} from "./symbol-id.js";

/**
 * Arbitraries that avoid the separator characters used in ID format.
 * - Repo names: no `:` or `#` (these are separators)
 * - File paths: no `#` or `:` (hash separates symbol name, colon separates repo), must contain `/`
 * - Symbol names: no `:` or `#`
 */
const repoArb = fc.stringMatching(/^[^:#]+$/);
const filePathArb = fc
  .tuple(fc.stringMatching(/^[^:#]+$/), fc.stringMatching(/^[^:#]+$/))
  .map(([dir, file]) => `${dir}/${file}`);
const symbolNameArb = fc.stringMatching(/^[^:#]+$/);

describe("symbol-id property-based tests", () => {
  describe("makeSymbolId / parseSymbolId roundtrip", () => {
    it("recovers repo, filePath, and symbolName from a symbol-level ID", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, symbolNameArb, (repo, filePath, symbolName) => {
          const id = makeSymbolId(repo, filePath, symbolName);
          const parsed = parseSymbolId(id);
          return (
            parsed.repo === repo &&
            parsed.filePath === filePath &&
            parsed.symbolName === symbolName &&
            parsed.isCanonical === true
          );
        }),
        { numRuns: 1000 },
      );
    });

    it("recovers repo and filePath from a file-level ID", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, (repo, filePath) => {
          const id = makeSymbolId(repo, filePath);
          const parsed = parseSymbolId(id);
          return (
            parsed.repo === repo &&
            parsed.filePath === filePath &&
            parsed.symbolName === undefined &&
            parsed.isCanonical === true
          );
        }),
        { numRuns: 1000 },
      );
    });
  });

  describe("makeFileId / parseSymbolId roundtrip", () => {
    it("recovers repo and filePath", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, (repo, filePath) => {
          const id = makeFileId(repo, filePath);
          const parsed = parseSymbolId(id);
          return (
            parsed.repo === repo &&
            parsed.filePath === filePath &&
            parsed.symbolName === undefined &&
            parsed.isCanonical === true
          );
        }),
        { numRuns: 1000 },
      );
    });
  });

  describe("extractRepo consistency", () => {
    it("agrees with parseSymbolId.repo for canonical IDs", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, fc.option(symbolNameArb), (repo, filePath, symOpt) => {
          const id = symOpt ? makeSymbolId(repo, filePath, symOpt) : makeFileId(repo, filePath);
          return extractRepo(id) === parseSymbolId(id).repo;
        }),
        { numRuns: 1000 },
      );
    });

    it("returns undefined for IDs without colon", () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[^:]+$/),
          (id) => extractRepo(id) === undefined,
        ),
        { numRuns: 500 },
      );
    });
  });

  describe("canonicalize", () => {
    it("is idempotent", () => {
      fc.assert(
        fc.property(filePathArb, repoArb, (filePath, repo) => {
          const once = canonicalize(filePath, repo);
          const twice = canonicalize(once, repo);
          return once === twice;
        }),
        { numRuns: 1000 },
      );
    });

    it("produces a canonical ID from a non-canonical one", () => {
      fc.assert(
        fc.property(filePathArb, repoArb, (filePath, repo) => {
          const canonical = canonicalize(filePath, repo);
          const parsed = parseSymbolId(canonical);
          return parsed.isCanonical === true && parsed.repo === repo;
        }),
        { numRuns: 1000 },
      );
    });

    it("preserves already-canonical IDs regardless of repo argument", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, repoArb, (origRepo, filePath, otherRepo) => {
          const id = makeFileId(origRepo, filePath);
          return canonicalize(id, otherRepo) === id;
        }),
        { numRuns: 1000 },
      );
    });
  });

  describe("format invariants", () => {
    it("makeSymbolId always contains exactly one colon and one hash", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, symbolNameArb, (repo, filePath, symbolName) => {
          const id = makeSymbolId(repo, filePath, symbolName);
          const colons = id.split(":").length - 1;
          const hashes = id.split("#").length - 1;
          return colons === 1 && hashes === 1;
        }),
        { numRuns: 1000 },
      );
    });

    it("makeFileId always contains exactly one colon and no hash", () => {
      fc.assert(
        fc.property(repoArb, filePathArb, (repo, filePath) => {
          const id = makeFileId(repo, filePath);
          const colons = id.split(":").length - 1;
          const hashes = id.split("#").length - 1;
          return colons === 1 && hashes === 0;
        }),
        { numRuns: 1000 },
      );
    });
  });
});
