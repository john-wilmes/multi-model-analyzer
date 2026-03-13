import { describe, it, expect } from "vitest";
import { redactSarifLog } from "./redaction.js";
import type { SarifLog } from "@mma/core";

function makeSarifLog(overrides: {
  messageText?: string;
  repoProperty?: string;
}): SarifLog {
  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "test",
            version: "0.1.0",
            rules: [],
          },
        },
        results: [
          {
            ruleId: "test/rule-1",
            level: "warning",
            message: { text: overrides.messageText ?? "some message" },
            locations: [
              {
                logicalLocations: [
                  {
                    name: "ModA",
                    fullyQualifiedName: "my-repo/ModA",
                    kind: "module",
                    properties: overrides.repoProperty
                      ? { repo: overrides.repoProperty }
                      : undefined,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("redaction", () => {
  describe("file path redaction", () => {
    it("hashes file paths in message text when redactFilePaths is true", () => {
      const log = makeSarifLog({
        messageText: "Dead export in src/utils/helpers.ts is unused",
      });
      const redacted = redactSarifLog(log, {
        salt: "test",
        redactFilePaths: true,
      });

      const text = redacted.runs[0]!.results[0]!.message.text;
      expect(text).not.toContain("src/utils/helpers.ts");
      expect(text).toContain("[REDACTED:");
      expect(text).toContain("is unused");
    });

    it("preserves file paths when redactFilePaths is false", () => {
      const log = makeSarifLog({
        messageText: "Dead export in src/utils/helpers.ts is unused",
      });
      const redacted = redactSarifLog(log, {
        salt: "test",
        redactFilePaths: false,
      });

      const text = redacted.runs[0]!.results[0]!.message.text;
      expect(text).toContain("src/utils/helpers.ts");
    });

    it("preserves file paths by default (redactFilePaths not set)", () => {
      const log = makeSarifLog({
        messageText: "Dead export in src/utils/helpers.ts is unused",
      });
      const redacted = redactSarifLog(log, { salt: "test" });

      const text = redacted.runs[0]!.results[0]!.message.text;
      expect(text).toContain("src/utils/helpers.ts");
    });

    it("hashes multiple file paths in the same message", () => {
      const log = makeSarifLog({
        messageText: "Import from ./lib/auth.ts to ../shared/types.tsx",
      });
      const redacted = redactSarifLog(log, {
        salt: "test",
        redactFilePaths: true,
      });

      const text = redacted.runs[0]!.results[0]!.message.text;
      expect(text).not.toContain("lib/auth.ts");
      expect(text).not.toContain("shared/types.tsx");
    });
  });

  describe("repo property redaction", () => {
    it("hashes repo property in logical location properties", () => {
      const log = makeSarifLog({ repoProperty: "my-secret-repo" });
      const redacted = redactSarifLog(log, { salt: "test" });

      const loc =
        redacted.runs[0]!.results[0]!.locations![0]!.logicalLocations![0]!;
      expect(loc.properties?.["repo"]).not.toBe("my-secret-repo");
      expect(loc.properties?.["repo"]).toContain("[REDACTED:");
    });

    it("uses consistent hashing for the same repo name", () => {
      const log = makeSarifLog({ repoProperty: "my-secret-repo" });
      const r1 = redactSarifLog(log, { salt: "same" });
      const r2 = redactSarifLog(log, { salt: "same" });

      const repo1 =
        r1.runs[0]!.results[0]!.locations![0]!.logicalLocations![0]!
          .properties?.["repo"];
      const repo2 =
        r2.runs[0]!.results[0]!.locations![0]!.logicalLocations![0]!
          .properties?.["repo"];
      expect(repo1).toBe(repo2);
    });

    it("produces different hashes with different salts", () => {
      const log = makeSarifLog({ repoProperty: "my-secret-repo" });
      const r1 = redactSarifLog(log, { salt: "salt-a" });
      const r2 = redactSarifLog(log, { salt: "salt-b" });

      const repo1 =
        r1.runs[0]!.results[0]!.locations![0]!.logicalLocations![0]!
          .properties?.["repo"];
      const repo2 =
        r2.runs[0]!.results[0]!.locations![0]!.logicalLocations![0]!
          .properties?.["repo"];
      expect(repo1).not.toBe(repo2);
    });
  });
});
