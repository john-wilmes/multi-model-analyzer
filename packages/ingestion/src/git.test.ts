import { describe, it, expect } from "vitest";
import { parseNameStatus } from "./git.js";

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
});
