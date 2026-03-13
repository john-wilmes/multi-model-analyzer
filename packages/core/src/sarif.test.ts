/**
 * Tests for SARIF factory helpers: createSarifLog, createSarifRun,
 * createSarifResult, createLogicalLocation.
 */

import { describe, it, expect } from "vitest";
import {
  createSarifLog,
  createSarifRun,
  createSarifResult,
  createLogicalLocation,
} from "./sarif.js";

describe("createSarifLog", () => {
  it("produces a valid SARIF 2.1.0 log", () => {
    const log = createSarifLog([]);

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-schema-2.1.0");
    expect(log.runs).toEqual([]);
  });

  it("includes provided runs", () => {
    const run = createSarifRun("tool", "1.0", [], []);
    const log = createSarifLog([run]);

    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.tool.driver.name).toBe("tool");
  });
});

describe("createSarifRun", () => {
  it("produces a run with tool info, rules, and results", () => {
    const rules = [{ id: "R1", shortDescription: { text: "Rule 1" } }];
    const results = [createSarifResult("R1", "warning", "Issue found")];

    const run = createSarifRun("analyzer", "2.0", rules, results);

    expect(run.tool.driver.name).toBe("analyzer");
    expect(run.tool.driver.version).toBe("2.0");
    expect(run.tool.driver.rules).toHaveLength(1);
    expect(run.results).toHaveLength(1);
  });

  it("includes optional logicalLocations", () => {
    const loc = createLogicalLocation("repo", "module.ts");
    const run = createSarifRun("t", "1", [], [], {
      logicalLocations: [loc],
    });

    expect(run.logicalLocations).toHaveLength(1);
  });

  it("includes optional redactionTokens", () => {
    const run = createSarifRun("t", "1", [], [], {
      redactionTokens: ["[REDACTED]"],
    });

    expect(run.redactionTokens).toEqual(["[REDACTED]"]);
  });

  it("includes optional properties", () => {
    const run = createSarifRun("t", "1", [], [], {
      properties: { statistics: { totalResults: 5, errorCount: 1, warningCount: 2, noteCount: 2, rulesTriggered: 1, analysisTimestamp: "now" } },
    });

    expect(run.properties?.statistics?.totalResults).toBe(5);
  });
});

describe("createSarifResult", () => {
  it("produces a result with required fields", () => {
    const result = createSarifResult("R1", "error", "Something failed");

    expect(result.ruleId).toBe("R1");
    expect(result.level).toBe("error");
    expect(result.message.text).toBe("Something failed");
  });

  it("includes optional ruleIndex", () => {
    const result = createSarifResult("R1", "note", "Info", { ruleIndex: 0 });

    expect(result.ruleIndex).toBe(0);
  });

  it("includes optional locations", () => {
    const loc = { logicalLocations: [createLogicalLocation("repo", "file.ts")] };
    const result = createSarifResult("R1", "warning", "Issue", {
      locations: [loc],
    });

    expect(result.locations).toHaveLength(1);
    expect(result.locations![0]!.logicalLocations![0]!.name).toBe("file.ts");
  });

  it("includes optional properties", () => {
    const result = createSarifResult("R1", "note", "Info", {
      properties: { severity: "low" },
    });

    expect(result.properties?.["severity"]).toBe("low");
  });
});

describe("createLogicalLocation", () => {
  it("creates location with defaults", () => {
    const loc = createLogicalLocation("my-repo", "src/handler.ts");

    expect(loc.name).toBe("src/handler.ts");
    expect(loc.fullyQualifiedName).toBe("my-repo/src/handler.ts");
    expect(loc.kind).toBe("module");
    expect(loc.properties).toEqual({ repo: "my-repo" });
  });

  it("accepts custom fullyQualifiedName", () => {
    const loc = createLogicalLocation("repo", "mod.ts", "repo::mod::fn");

    expect(loc.fullyQualifiedName).toBe("repo::mod::fn");
  });

  it("accepts custom kind", () => {
    const loc = createLogicalLocation("repo", "cls.ts", undefined, "class");

    expect(loc.kind).toBe("class");
    expect(loc.fullyQualifiedName).toBe("repo/cls.ts"); // default FQN
  });
});
