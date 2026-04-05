/**
 * Tests for constraint extraction from code patterns.
 *
 * Uses real tree-sitter parsing (WASM) to build TreeSitterTree objects,
 * mirroring the approach used in packages/heuristics/src/flags.test.ts.
 *
 * Implementation notes (verified by running against actual AST output):
 *
 * - Mutex detection: visitAll walks every if_statement node including nested
 *   else-if nodes. A 3-flag chain (A / else-if B / else-if C) produces two
 *   separate chains: [A,B,C] (from the outer if_statement) and [B,C] (from
 *   the inner if_statement that begins the else-if branch). This is the actual
 *   implementation behaviour, not a bug in the tests.
 *
 * - Flag matching: uses word-boundary regex to avoid substring false positives
 *   (e.g. FEATURE_A must not match inside FEATURE_AB).
 *
 * - Range detection: findValidationPatterns uses node.children (all children,
 *   including unnamed tokens) to detect comparison operators. In tree-sitter's
 *   TypeScript grammar, <, >, <=, >= are UNNAMED children of binary_expression,
 *   so node.children is required; namedChildren would miss them.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseSource } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import type { FeatureFlag, ConfigParameter } from "@mma/core";
import { extractConstraintsFromCode } from "./constraints.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFiles(entries: Record<string, string>): Map<string, TreeSitterTree> {
  const map = new Map<string, TreeSitterTree>();
  for (const [path, code] of Object.entries(entries)) {
    map.set(path, parseSource(code, path));
  }
  return map;
}

function makeFlag(name: string): FeatureFlag {
  return { name, locations: [] };
}

function makeFlags(...names: string[]): FeatureFlag[] {
  return names.map(makeFlag);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("extractConstraintsFromCode", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  // -------------------------------------------------------------------------
  // Empty / degenerate inputs
  // -------------------------------------------------------------------------

  describe("empty inputs", () => {
    it("returns empty array when files map is empty", () => {
      const result = extractConstraintsFromCode(new Map(), makeFlags("FLAG_A", "FLAG_B"));
      expect(result).toHaveLength(0);
    });

    it("returns empty array when flags list is empty", () => {
      const files = makeFiles({
        "src/config.ts": `
          if (featureA) {
            doSomething();
          } else if (featureB) {
            doOther();
          }
        `,
      });
      const result = extractConstraintsFromCode(files, []);
      expect(result).toHaveLength(0);
    });

    it("returns empty array when files contain no flag references", () => {
      const files = makeFiles({
        "src/math.ts": `export function add(a: number, b: number) { return a + b; }`,
      });
      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));
      expect(result).toHaveLength(0);
    });

    it("returns empty array when code has if-else but no flag names match", () => {
      const files = makeFiles({
        "src/ui.ts": `
          if (unknownVar) {
            show();
          } else if (anotherUnknown) {
            hide();
          }
        `,
      });
      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_X", "FEATURE_Y"));
      expect(result).toHaveLength(0);
    });

    it("returns empty array for file with only assignment statements", () => {
      const files = makeFiles({
        "src/constants.ts": `
          const FEATURE_A = true;
          const FEATURE_B = false;
        `,
      });
      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));
      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Mutex detection from if-else chains
  // -------------------------------------------------------------------------

  describe("if-else chain mutex detection", () => {
    it("detects mutex constraint from simple if-else-if chain with two flags", () => {
      const files = makeFiles({
        "src/router.ts": `
          if (FEATURE_A) {
            renderA();
          } else if (FEATURE_B) {
            renderB();
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_A");
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_B");
    });

    it("sets flagName to the first flag in the chain", () => {
      const files = makeFiles({
        "src/router.ts": `
          if (FEATURE_A) {
            doA();
          } else if (FEATURE_B) {
            doB();
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex[0]!.flagName).toBe("FEATURE_A");
    });

    it("marks mutex constraint as inferred", () => {
      const files = makeFiles({
        "src/router.ts": `
          if (FEATURE_A) {
            doA();
          } else if (FEATURE_B) {
            doB();
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.find((c) => c.constraint.kind === "mutex");
      expect(mutex!.constraint.source).toBe("inferred");
    });

    it("sets a description on mutex constraints", () => {
      const files = makeFiles({
        "src/router.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.find((c) => c.constraint.kind === "mutex");
      expect(mutex!.constraint.description.toLowerCase()).toContain("mutually exclusive");
    });

    it("does not produce mutex for a lone if (no else-if branch)", () => {
      const files = makeFiles({
        "src/check.ts": `
          if (FEATURE_A) {
            run();
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(0);
    });

    it("does not produce mutex when else-if references no known flag", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) {
            doA();
          } else if (unknownVar) {
            doOther();
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(0);
    });

    it("detects two mutex chains for a 3-flag if-else-if-else-if", () => {
      // visitAll visits both the outer if_statement (chain: [A,B,C]) and the
      // nested if_statement that starts the second branch (chain: [B,C]).
      const files = makeFiles({
        "src/render.ts": `
          if (FEATURE_A) {
            modeA();
          } else if (FEATURE_B) {
            modeB();
          } else if (FEATURE_C) {
            modeC();
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_A", "FEATURE_B", "FEATURE_C"),
      );

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      // Two chains are detected: [A,B,C] from the outer node and [B,C] from the inner node
      expect(mutex).toHaveLength(2);

      const fullChain = mutex.find((c) => c.constraint.flags.length === 3);
      expect(fullChain).toBeDefined();
      expect(fullChain!.constraint.flags).toEqual(
        expect.arrayContaining(["FEATURE_A", "FEATURE_B", "FEATURE_C"]),
      );

      const subChain = mutex.find((c) => c.constraint.flags.length === 2);
      expect(subChain).toBeDefined();
      expect(subChain!.constraint.flags).toEqual(
        expect.arrayContaining(["FEATURE_B", "FEATURE_C"]),
      );
    });

    it("detects multiple independent if-else chains in the same file", () => {
      const files = makeFiles({
        "src/multi.ts": `
          function modeSwitch() {
            if (FEATURE_A) {
              doA();
            } else if (FEATURE_B) {
              doB();
            }
          }

          function themeSwitch() {
            if (FEATURE_C) {
              lightTheme();
            } else if (FEATURE_D) {
              darkTheme();
            }
          }
        `,
      });

      const flags = makeFlags("FEATURE_A", "FEATURE_B", "FEATURE_C", "FEATURE_D");
      const result = extractConstraintsFromCode(files, flags);

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(2);
    });

    it("detects mutex constraints across multiple files", () => {
      const files = makeFiles({
        "src/a.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
        "src/b.ts": `
          if (FEATURE_C) { doC(); } else if (FEATURE_D) { doD(); }
        `,
      });

      const flags = makeFlags("FEATURE_A", "FEATURE_B", "FEATURE_C", "FEATURE_D");
      const result = extractConstraintsFromCode(files, flags);

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(2);
    });

    it("produces exactly one mutex for a 2-flag chain even when surrounded by other statements", () => {
      const files = makeFiles({
        "src/complex.ts": `
          const x = 1;
          console.log("setup");
          if (FEATURE_NEW_UI) {
            showNewUI();
          } else if (FEATURE_OLD_UI) {
            showOldUI();
          }
          const y = 2;
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_NEW_UI", "FEATURE_OLD_UI"),
      );

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_NEW_UI");
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_OLD_UI");
    });
  });

  // -------------------------------------------------------------------------
  // Range / validation pattern detection
  //
  // The implementation uses node.children (all children, including unnamed
  // tokens) to detect comparison operators. In tree-sitter's TypeScript
  // grammar, <, >, <=, >= are UNNAMED children of binary_expression, so
  // node.children is required (namedChildren would miss them).
  // -------------------------------------------------------------------------

  describe("range validation pattern detection", () => {
    it("detects range constraint for less-than comparison", () => {
      const files = makeFiles({
        "src/validate.ts": `
          if (FEATURE_RATE_LIMIT < 0) {
            throw new Error("invalid");
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_RATE_LIMIT"));

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(1);
      expect(range[0]!.flagName).toBe("FEATURE_RATE_LIMIT");
    });

    it("detects range constraint for greater-than comparison", () => {
      const files = makeFiles({
        "src/validate.ts": `
          if (FEATURE_TIMEOUT > 60000) {
            warn("timeout too high");
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_TIMEOUT"));

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(1);
      expect(range[0]!.flagName).toBe("FEATURE_TIMEOUT");
    });

    it("detects range constraint for less-than-or-equal comparison", () => {
      const files = makeFiles({
        "src/check.ts": `
          if (FEATURE_CONCURRENCY <= 0) {
            throw new Error("must be positive");
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_CONCURRENCY"));

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(1);
      expect(range[0]!.flagName).toBe("FEATURE_CONCURRENCY");
    });

    it("detects range constraint for greater-than-or-equal comparison", () => {
      const files = makeFiles({
        "src/check.ts": `
          if (FEATURE_RETRY_COUNT >= 100) {
            warn("excessive retries");
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_RETRY_COUNT"));

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(1);
      expect(range[0]!.flagName).toBe("FEATURE_RETRY_COUNT");
    });

    it("detects range constraints when code has both range checks and no mutex patterns", () => {
      const files = makeFiles({
        "src/validate.ts": `
          if (FEATURE_RATE_LIMIT < 0 || FEATURE_RATE_LIMIT > 1000) {
            throw new Error("out of range");
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_RATE_LIMIT"));

      // Two range constraints (one per binary_expression), no mutex.
      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range.length).toBeGreaterThanOrEqual(1);
      expect(result.filter((c) => c.constraint.kind === "mutex")).toHaveLength(0);
    });

    it("does not produce range for equality operator", () => {
      const files = makeFiles({
        "src/check.ts": `
          if (FEATURE_MODE === "dark") {
            enableDark();
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_MODE"));

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(0);
    });

    it("does not produce range for strict inequality operator", () => {
      const files = makeFiles({
        "src/check.ts": `
          if (FEATURE_VALUE !== null) {
            use(FEATURE_VALUE);
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_VALUE"));

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(0);
    });

    it("does not produce range when flag name does not appear in expression", () => {
      const files = makeFiles({
        "src/validate.ts": `
          if (someOtherVar < 0) {
            throw new Error("negative");
          }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_RATE_LIMIT"));

      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ExtractedConstraint shape
  // -------------------------------------------------------------------------

  describe("ExtractedConstraint shape", () => {
    it("each result has flagName and constraint fields", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      expect(result.length).toBeGreaterThan(0);
      for (const entry of result) {
        expect(entry).toHaveProperty("flagName");
        expect(entry).toHaveProperty("constraint");
        expect(typeof entry.flagName).toBe("string");
        expect(typeof entry.constraint.kind).toBe("string");
        expect(Array.isArray(entry.constraint.flags)).toBe(true);
        expect(typeof entry.constraint.description).toBe("string");
        expect(typeof entry.constraint.source).toBe("string");
      }
    });

    it("constraint.flags array contains at least two entries for mutex", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      for (const entry of mutex) {
        expect(entry.constraint.flags.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("source field is always 'inferred' for extracted constraints", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      for (const entry of result) {
        expect(entry.constraint.source).toBe("inferred");
      }
    });

    it("flagName is a string present in the flags array of the constraint", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      for (const entry of result) {
        expect(entry.constraint.flags).toContain(entry.flagName);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Flag name matching edge cases
  // -------------------------------------------------------------------------

  describe("flag name matching edge cases", () => {
    it("detects mutex when flags have similar prefixes", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_AB) { doAB(); } else if (FEATURE_C) { doC(); }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_A", "FEATURE_AB", "FEATURE_C"),
      );

      // Word-boundary matching ensures FEATURE_A does not match inside FEATURE_AB.
      // Only the exact name FEATURE_AB should be detected in the first branch.
      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_AB");
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_C");
      expect(mutex[0]!.constraint.flags).not.toContain("FEATURE_A");
    });

    it("does not detect range when flag name is longer than text in expression", () => {
      // FEATURE_RATE_LIMIT will not be found in text containing only FEATURE_RATE
      const files = makeFiles({
        "src/validate.ts": `
          if (FEATURE_RATE < 0) { throw new Error(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_RATE_LIMIT"));

      expect(result).toHaveLength(0);
    });

    it("detects flag names containing hyphens when quoted in bracket notation", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (flags["feature-alpha"]) { doAlpha(); } else if (flags["feature-beta"]) { doBeta(); }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("feature-alpha", "feature-beta"),
      );

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
    });

    it("returns empty result when code references no known flag names at all", () => {
      const files = makeFiles({
        "src/app.ts": `
          if (someConfig) { run(); } else if (otherConfig) { skip(); }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_A", "FEATURE_B", "FEATURE_C"),
      );

      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple files — aggregation
  // -------------------------------------------------------------------------

  describe("multiple files aggregation", () => {
    it("collects mutex constraints from all files independently", () => {
      const files = makeFiles({
        "src/a.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
        "src/b.ts": `
          if (FEATURE_C) { doC(); } else if (FEATURE_D) { doD(); }
        `,
      });

      const flags = makeFlags("FEATURE_A", "FEATURE_B", "FEATURE_C", "FEATURE_D");
      const result = extractConstraintsFromCode(files, flags);

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(2);
    });

    it("detects the same if-else chain pattern repeated across multiple files", () => {
      const files = makeFiles({
        "src/page-a.ts": `
          if (FEATURE_X) { renderX(); } else if (FEATURE_Y) { renderY(); }
        `,
        "src/page-b.ts": `
          if (FEATURE_X) { showX(); } else if (FEATURE_Y) { showY(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_X", "FEATURE_Y"));

      // Each file independently produces a mutex constraint
      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(2);
    });

    it("handles a single file with no if-else pattern alongside another that has one", () => {
      const files = makeFiles({
        "src/pure.ts": `
          export function greet(name: string) { return "hello " + name; }
        `,
        "src/flags.ts": `
          if (FEATURE_ALPHA) { alpha(); } else if (FEATURE_BETA) { beta(); }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_ALPHA", "FEATURE_BETA"),
      );

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Relationship between flags in the constraint
  // -------------------------------------------------------------------------

  describe("constraint flags list content", () => {
    it("mutex flags list matches the full sequence of flag names in the chain", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.find((c) => c.constraint.kind === "mutex");
      expect(mutex!.constraint.flags).toContain("FEATURE_A");
      expect(mutex!.constraint.flags).toContain("FEATURE_B");
      expect(mutex!.constraint.flags.length).toBe(2);
    });

    it("all flags in a mutex constraint are valid known flag names", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_X) { doX(); } else if (FEATURE_Y) { doY(); }
        `,
      });

      const knownNames = new Set(["FEATURE_X", "FEATURE_Y"]);
      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_X", "FEATURE_Y"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      for (const entry of mutex) {
        for (const flagInConstraint of entry.constraint.flags) {
          expect(knownNames.has(flagInConstraint)).toBe(true);
        }
      }
    });

    it("constraint kind is always a valid ConstraintKind string", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const validKinds = new Set(["requires", "excludes", "implies", "mutex", "range", "conditional", "enum"]);
      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      for (const entry of result) {
        expect(validKinds.has(entry.constraint.kind)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Unified constraint extraction with ConfigParameter
  // -------------------------------------------------------------------------

  describe("unified constraint extraction with parameters", () => {
    function makeParam(name: string, kind: "setting" | "credential" | "flag" = "setting"): ConfigParameter {
      return { name, locations: [], kind };
    }

    it("detects mutex between a flag and a setting in an if-else chain", () => {
      const files = makeFiles({
        "src/router.ts": `
          if (FEATURE_A) {
            renderA();
          } else if (timeout) {
            renderTimeout();
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_A"),
        [makeParam("timeout")],
      );

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
      expect(mutex[0]!.constraint.flags).toContain("FEATURE_A");
      expect(mutex[0]!.constraint.flags).toContain("timeout");
    });

    it("detects range check on a setting parameter", () => {
      const files = makeFiles({
        "src/validate.ts": `
          if (maxRetries < 0) {
            throw new Error("invalid");
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [makeParam("maxRetries")],
      );

      const range = result.filter((c) => c.constraint.kind === "range");
      expect(range).toHaveLength(1);
      expect(range[0]!.flagName).toBe("maxRetries");
    });

    it("works with empty parameters array (backward compatible)", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"), []);

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
    });

    it("works without parameters argument (backward compatible)", () => {
      const files = makeFiles({
        "src/gate.ts": `
          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(files, makeFlags("FEATURE_A", "FEATURE_B"));

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      expect(mutex).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Guard clause detection
  // -------------------------------------------------------------------------

  describe("guard clause detection", () => {
    it("detects requires constraint from guard clause with equality check", () => {
      const files = makeFiles({
        "src/config.ts": `
          if (provider === "epic") {
            const val = hl7Enabled;
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [
          { name: "provider", locations: [], kind: "setting" },
          { name: "hl7Enabled", locations: [], kind: "flag" },
        ],
      );

      const requires = result.filter((c) => c.constraint.kind === "requires");
      expect(requires.length).toBeGreaterThanOrEqual(1);
      const guard = requires.find(
        (c) => c.constraint.flags.includes("provider") && c.constraint.flags.includes("hl7Enabled"),
      );
      expect(guard).toBeDefined();
      expect(guard!.constraint.condition).toEqual({ provider: "epic" });
    });

    it("does not detect guard clause without equality check", () => {
      const files = makeFiles({
        "src/config.ts": `
          if (provider) {
            doSomething();
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [{ name: "provider", locations: [], kind: "setting" }],
      );

      const requires = result.filter((c) => c.constraint.kind === "requires");
      expect(requires).toHaveLength(0);
    });

    it("does not detect guard when body references no known parameters", () => {
      const files = makeFiles({
        "src/config.ts": `
          if (provider === "epic") {
            doSomething();
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [{ name: "provider", locations: [], kind: "setting" }],
      );

      const requires = result.filter((c) => c.constraint.kind === "requires");
      expect(requires).toHaveLength(0);
    });

    it("detects credential requirement guard clause", () => {
      const files = makeFiles({
        "src/auth.ts": `
          if (provider === "twilio") {
            const sid = twilioSid;
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [
          { name: "provider", locations: [], kind: "setting" },
          { name: "twilioSid", locations: [], kind: "credential" },
        ],
      );

      const requires = result.filter(
        (c) => c.constraint.kind === "requires" &&
               c.constraint.flags.includes("twilioSid"),
      );
      expect(requires.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Switch dispatch detection
  // -------------------------------------------------------------------------

  describe("switch dispatch detection", () => {
    it("detects enum constraint from switch with string cases", () => {
      const files = makeFiles({
        "src/dispatch.ts": `
          switch (integrationType) {
            case "fhir":
              handleFhir();
              break;
            case "hl7":
              handleHl7();
              break;
            case "csv":
              handleCsv();
              break;
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [{ name: "integrationType", locations: [], kind: "setting" }],
      );

      const enumConstraints = result.filter((c) => c.constraint.kind === "enum");
      expect(enumConstraints).toHaveLength(1);
      expect(enumConstraints[0]!.constraint.allowedValues).toEqual(["fhir", "hl7", "csv"]);
      expect(enumConstraints[0]!.flagName).toBe("integrationType");
    });

    it("does not detect enum for switch with fewer than 2 string cases", () => {
      const files = makeFiles({
        "src/dispatch.ts": `
          switch (mode) {
            case "default":
              handleDefault();
              break;
            default:
              handleOther();
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [{ name: "mode", locations: [], kind: "setting" }],
      );

      const enumConstraints = result.filter((c) => c.constraint.kind === "enum");
      expect(enumConstraints).toHaveLength(0);
    });

    it("does not detect enum when switch expression is not a known parameter", () => {
      const files = makeFiles({
        "src/dispatch.ts": `
          switch (unknownVar) {
            case "a": break;
            case "b": break;
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [{ name: "mode", locations: [], kind: "setting" }],
      );

      const enumConstraints = result.filter((c) => c.constraint.kind === "enum");
      expect(enumConstraints).toHaveLength(0);
    });

    it("detects enum on a flag name used in switch", () => {
      const files = makeFiles({
        "src/mode.ts": `
          switch (FEATURE_MODE) {
            case "dark": enableDark(); break;
            case "light": enableLight(); break;
          }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_MODE"),
      );

      const enumConstraints = result.filter((c) => c.constraint.kind === "enum");
      expect(enumConstraints).toHaveLength(1);
      expect(enumConstraints[0]!.constraint.allowedValues).toEqual(["dark", "light"]);
    });
  });

  // -------------------------------------------------------------------------
  // Conditional default detection
  // -------------------------------------------------------------------------

  describe("conditional default detection", () => {
    it("detects conditional constraint from ternary expression", () => {
      const files = makeFiles({
        "src/defaults.ts": `
          const timeout = isProduction ? 30000 : 5000;
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [
          { name: "isProduction", locations: [], kind: "setting" },
          { name: "timeout", locations: [], kind: "setting" },
        ],
      );

      const conditional = result.filter((c) => c.constraint.kind === "conditional");
      expect(conditional).toHaveLength(1);
      expect(conditional[0]!.constraint.flags).toContain("isProduction");
      expect(conditional[0]!.constraint.flags).toContain("timeout");
      expect(conditional[0]!.constraint.allowedValues).toContain(30000);
      expect(conditional[0]!.constraint.allowedValues).toContain(5000);
    });

    it("does not detect conditional when ternary has no known parameters", () => {
      const files = makeFiles({
        "src/defaults.ts": `
          const timeout = unknownVar ? 30000 : 5000;
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [{ name: "timeout", locations: [], kind: "setting" }],
      );

      const conditional = result.filter((c) => c.constraint.kind === "conditional");
      expect(conditional).toHaveLength(0);
    });

    it("detects conditional with string values", () => {
      const files = makeFiles({
        "src/config.ts": `
          const endpoint = useStaging ? "https://staging.api.com" : "https://api.com";
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        [],
        [
          { name: "useStaging", locations: [], kind: "flag" },
          { name: "endpoint", locations: [], kind: "setting" },
        ],
      );

      const conditional = result.filter((c) => c.constraint.kind === "conditional");
      expect(conditional).toHaveLength(1);
      expect(conditional[0]!.constraint.allowedValues).toEqual(
        expect.arrayContaining(["https://staging.api.com", "https://api.com"]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Combined patterns
  // -------------------------------------------------------------------------

  describe("combined constraint patterns", () => {
    it("detects multiple constraint types in same file", () => {
      const files = makeFiles({
        "src/config.ts": `
          if (provider === "twilio") {
            const sid = twilioSid;
          }

          switch (mode) {
            case "sms": break;
            case "email": break;
          }

          if (FEATURE_A) { doA(); } else if (FEATURE_B) { doB(); }
        `,
      });

      const result = extractConstraintsFromCode(
        files,
        makeFlags("FEATURE_A", "FEATURE_B"),
        [
          { name: "provider", locations: [], kind: "setting" },
          { name: "twilioSid", locations: [], kind: "credential" },
          { name: "mode", locations: [], kind: "setting" },
        ],
      );

      const mutex = result.filter((c) => c.constraint.kind === "mutex");
      const requires = result.filter((c) => c.constraint.kind === "requires");
      const enumC = result.filter((c) => c.constraint.kind === "enum");

      expect(mutex.length).toBeGreaterThanOrEqual(1);
      expect(requires.length).toBeGreaterThanOrEqual(1);
      expect(enumC.length).toBeGreaterThanOrEqual(1);
    });
  });
});
