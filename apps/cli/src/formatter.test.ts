import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printJson, printTable, printSarif, validateFormat, validateReportFormat } from "./formatter.js";

describe("formatter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("printJson", () => {
    it("outputs pretty-printed JSON", () => {
      printJson({ foo: 1, bar: [2, 3] });
      expect(logSpy).toHaveBeenCalledOnce();
      const output = logSpy.mock.calls[0]![0] as string;
      expect(JSON.parse(output)).toEqual({ foo: 1, bar: [2, 3] });
      // Pretty-printed = contains newlines
      expect(output).toContain("\n");
    });

    it("handles null and primitives", () => {
      printJson(null);
      expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toBeNull();
    });
  });

  describe("printTable", () => {
    it("renders padded columns with separator", () => {
      printTable(["Name", "Score"], [
        ["alice", "95"],
        ["bob", "100"],
      ]);
      // printTable emits one console.log call with the full multi-line string
      expect(logSpy).toHaveBeenCalledOnce();
      const output = logSpy.mock.calls[0]![0] as string;
      const lines = output.split("\n");
      expect(lines).toHaveLength(4); // header + separator + 2 rows
      // Header
      expect(lines[0]).toContain("Name");
      expect(lines[0]).toContain("Score");
      // Separator
      expect(lines[1]).toMatch(/^-+\s+-+$/);
      // Data rows
      expect(lines[2]).toContain("alice");
      expect(lines[3]).toContain("bob");
      expect(lines[3]).toContain("100");
    });

    it("handles empty rows", () => {
      printTable(["A", "B"], []);
      expect(logSpy).toHaveBeenCalledOnce();
      const output = logSpy.mock.calls[0]![0] as string;
      const lines = output.split("\n");
      expect(lines).toHaveLength(2); // header + separator only
    });

    it("sizes columns to widest value", () => {
      printTable(["X", "Long Header"], [
        ["short", "y"],
      ]);
      const output = logSpy.mock.calls[0]![0] as string;
      // "Long Header" is 11 chars, wider than "y"
      expect(output).toContain("Long Header");
    });
  });

  describe("validateFormat", () => {
    it("returns default when format is undefined", () => {
      expect(validateFormat(undefined, "table")).toBe("table");
      expect(validateFormat(undefined, "json")).toBe("json");
    });

    it("returns valid format strings as-is", () => {
      expect(validateFormat("json", "table")).toBe("json");
      expect(validateFormat("table", "json")).toBe("table");
      expect(validateFormat("sarif", "table")).toBe("sarif");
    });

    it("exits with error for invalid format", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => validateFormat("xml", "table")).toThrow("exit");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("xml"));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("validateReportFormat", () => {
    it("returns default when format is undefined", () => {
      expect(validateReportFormat(undefined, "json")).toBe("json");
      expect(validateReportFormat(undefined, "markdown")).toBe("markdown");
    });

    it("returns valid format strings as-is", () => {
      expect(validateReportFormat("json", "table")).toBe("json");
      expect(validateReportFormat("table", "json")).toBe("table");
      expect(validateReportFormat("sarif", "json")).toBe("sarif");
      expect(validateReportFormat("markdown", "json")).toBe("markdown");
      expect(validateReportFormat("both", "json")).toBe("both");
    });

    it("exits with error for invalid format", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => validateReportFormat("xml", "json")).toThrow("exit");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("xml"));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("printSarif", () => {
    it("emits valid SARIF v2.1.0 log", () => {
      printSarif("test-tool", [
        { ruleId: "rule/one", level: "warning", message: "Something wrong" },
        { ruleId: "rule/two", level: "error", message: "Very bad", repo: "my-repo" },
      ]);
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as import("@mma/core").SarifLog;
      expect(output.version).toBe("2.1.0");
      expect(output.$schema).toContain("sarif");
      expect(output.runs).toHaveLength(1);

      const run = output.runs[0]!;
      expect(run.tool.driver.name).toBe("test-tool");
      expect(run.results).toHaveLength(2);

      // First result — no repo
      expect(run.results[0]!.ruleId).toBe("rule/one");
      expect(run.results[0]!.level).toBe("warning");
      expect(run.results[0]!.message.text).toBe("Something wrong");

      // Second result — has repo in location
      expect(run.results[1]!.ruleId).toBe("rule/two");
      expect(run.results[1]!.locations![0]!.logicalLocations![0]!.properties!["repo"]).toBe("my-repo");

      // Rules deduped
      expect(run.tool.driver.rules).toHaveLength(2);
      expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["rule/one", "rule/two"]);
    });

    it("handles empty results", () => {
      printSarif("test-tool", []);
      const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as import("@mma/core").SarifLog;
      expect(output.runs[0]!.results).toHaveLength(0);
      expect(output.runs[0]!.tool.driver.rules).toHaveLength(0);
    });
  });
});
