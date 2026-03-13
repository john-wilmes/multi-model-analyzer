import { describe, it, expect } from "vitest";
import { parseNameStatus, parseRevisionRange } from "./git.js";

describe("parseNameStatus", () => {
  it("parses tab-delimited add/modify/delete", () => {
    const output = "A\tsrc/new-file.ts\nM\tsrc/changed.ts\nD\tsrc/removed.ts\n";
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["src/new-file.ts"]);
    expect(result.modified).toEqual(["src/changed.ts"]);
    expect(result.deleted).toEqual(["src/removed.ts"]);
  });

  it("handles rename status with score", () => {
    const output = "R100\told/path.ts\tnew/path.ts\n";
    const result = parseNameStatus(output);
    expect(result.deleted).toEqual(["old/path.ts"]);
    expect(result.added).toEqual(["new/path.ts"]);
    expect(result.modified).toEqual([]);
  });

  it("handles copy status with score", () => {
    const output = "C085\tsrc/original.ts\tsrc/copy.ts\n";
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["src/copy.ts"]);
    expect(result.deleted).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it("handles mixed statuses", () => {
    const output = [
      "M\tsrc/a.ts",
      "A\tsrc/b.ts",
      "R100\tsrc/old.ts\tsrc/new.ts",
      "D\tsrc/c.ts",
      "C050\tsrc/d.ts\tsrc/d-copy.ts",
    ].join("\n");
    const result = parseNameStatus(output);
    expect(result.modified).toEqual(["src/a.ts"]);
    expect(result.added).toEqual(["src/b.ts", "src/new.ts", "src/d-copy.ts"]);
    expect(result.deleted).toEqual(["src/old.ts", "src/c.ts"]);
  });

  it("handles empty output", () => {
    const result = parseNameStatus("");
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("treats unknown status as modified", () => {
    const output = "T\tsrc/typechange.ts\n";
    const result = parseNameStatus(output);
    expect(result.modified).toEqual(["src/typechange.ts"]);
  });

  it("handles output without trailing newline", () => {
    const output = "A\tsrc/file.ts";
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["src/file.ts"]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("handles multiple consecutive blank lines in output", () => {
    const output = "A\tsrc/a.ts\n\n\nD\tsrc/b.ts\n";
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["src/a.ts"]);
    expect(result.deleted).toEqual(["src/b.ts"]);
    expect(result.modified).toEqual([]);
  });

  it("handles rename with low similarity score", () => {
    const output = "R025\tsrc/old-name.ts\tsrc/new-name.ts\n";
    const result = parseNameStatus(output);
    expect(result.deleted).toEqual(["src/old-name.ts"]);
    expect(result.added).toEqual(["src/new-name.ts"]);
  });

  it("handles single-file output with no newline", () => {
    const output = "M\tsrc/only-file.ts";
    const result = parseNameStatus(output);
    expect(result.modified).toEqual(["src/only-file.ts"]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("handles file paths with spaces", () => {
    const output = "A\tsrc/my file.ts\nM\tpath with spaces/index.js\n";
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["src/my file.ts"]);
    expect(result.modified).toEqual(["path with spaces/index.js"]);
  });

  it("handles multiple renames in a single output", () => {
    const output = [
      "R100\tsrc/old1.ts\tsrc/new1.ts",
      "R090\tsrc/old2.ts\tsrc/new2.ts",
      "R050\tsrc/old3.ts\tsrc/new3.ts",
    ].join("\n");
    const result = parseNameStatus(output);
    expect(result.deleted).toEqual(["src/old1.ts", "src/old2.ts", "src/old3.ts"]);
    expect(result.added).toEqual(["src/new1.ts", "src/new2.ts", "src/new3.ts"]);
    expect(result.modified).toEqual([]);
  });

  it("handles unmerged status U as modified (default)", () => {
    const output = "U\tsrc/conflict.ts\n";
    const result = parseNameStatus(output);
    expect(result.modified).toEqual(["src/conflict.ts"]);
  });

  it("handles deeply nested file paths", () => {
    const output = "A\tpackages/core/src/utils/helpers/deep/file.ts\n";
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["packages/core/src/utils/helpers/deep/file.ts"]);
  });

  it("handles only-whitespace output", () => {
    const result = parseNameStatus("   \n  \n");
    // The implementation trims and splits — a line with only spaces
    // will hit the default branch since parts[0] is spaces
    // This tests that it does not throw
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("handles large batch of all status types together", () => {
    const output = [
      "A\tnew1.ts",
      "A\tnew2.ts",
      "M\tmod1.ts",
      "M\tmod2.ts",
      "M\tmod3.ts",
      "D\tdel1.ts",
      "R100\told.ts\trenamed.ts",
      "C100\tsrc.ts\tcopy.ts",
      "T\ttype-change.ts",
    ].join("\n");
    const result = parseNameStatus(output);
    expect(result.added).toEqual(["new1.ts", "new2.ts", "renamed.ts", "copy.ts"]);
    expect(result.modified).toEqual(["mod1.ts", "mod2.ts", "mod3.ts", "type-change.ts"]);
    expect(result.deleted).toEqual(["del1.ts", "old.ts"]);
  });
});

describe("parseRevisionRange", () => {
  it("parses two-dot range", () => {
    const result = parseRevisionRange("abc123..def456");
    expect(result.from).toBe("abc123");
    expect(result.to).toBe("def456");
  });

  it("parses symbolic range", () => {
    const result = parseRevisionRange("main..feature");
    expect(result.from).toBe("main");
    expect(result.to).toBe("feature");
  });

  it("parses HEAD-relative range", () => {
    const result = parseRevisionRange("HEAD~3..HEAD");
    expect(result.from).toBe("HEAD~3");
    expect(result.to).toBe("HEAD");
  });

  it("treats single ref as from..HEAD", () => {
    const result = parseRevisionRange("HEAD~3");
    expect(result.from).toBe("HEAD~3");
    expect(result.to).toBe("HEAD");
  });

  it("treats single SHA as from..HEAD", () => {
    const result = parseRevisionRange("abc123");
    expect(result.from).toBe("abc123");
    expect(result.to).toBe("HEAD");
  });

  it("handles three-dot range by stripping extra dot", () => {
    const result = parseRevisionRange("main...feature");
    expect(result.from).toBe("main");
    expect(result.to).toBe("feature");
  });

  it("defaults from to HEAD when range starts with ..", () => {
    const result = parseRevisionRange("..feature");
    expect(result.from).toBe("HEAD");
    expect(result.to).toBe("feature");
  });

  it("defaults to to HEAD when range ends with ..", () => {
    const result = parseRevisionRange("main..");
    expect(result.from).toBe("main");
    expect(result.to).toBe("HEAD");
  });

  it("defaults both sides to HEAD for bare ..", () => {
    const result = parseRevisionRange("..");
    expect(result.from).toBe("HEAD");
    expect(result.to).toBe("HEAD");
  });

  it("handles full 40-char SHA refs", () => {
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);
    const result = parseRevisionRange(`${sha1}..${sha2}`);
    expect(result.from).toBe(sha1);
    expect(result.to).toBe(sha2);
  });

  it("handles refs with slashes (branch names)", () => {
    const result = parseRevisionRange("origin/main..origin/feature/xyz");
    expect(result.from).toBe("origin/main");
    expect(result.to).toBe("origin/feature/xyz");
  });

  it("handles refs with tilde and caret notation", () => {
    const result = parseRevisionRange("HEAD~5..HEAD^2");
    expect(result.from).toBe("HEAD~5");
    expect(result.to).toBe("HEAD^2");
  });

  it("handles three-dot range with empty from", () => {
    const result = parseRevisionRange("...feature");
    expect(result.from).toBe("HEAD");
    expect(result.to).toBe("feature");
  });

  it("handles three-dot range with empty to", () => {
    const result = parseRevisionRange("main...");
    expect(result.from).toBe("main");
    expect(result.to).toBe("HEAD");
  });

  it("handles empty string as single-ref (from=empty, to=HEAD)", () => {
    const result = parseRevisionRange("");
    expect(result.from).toBe("");
    expect(result.to).toBe("HEAD");
  });

  it("handles tag-like refs", () => {
    const result = parseRevisionRange("v1.0.0..v2.0.0");
    expect(result.from).toBe("v1.0.0");
    expect(result.to).toBe("v2.0.0");
  });

  it("preserves ref with @ notation", () => {
    const result = parseRevisionRange("main@{upstream}..HEAD");
    expect(result.from).toBe("main@{upstream}");
    expect(result.to).toBe("HEAD");
  });
});
