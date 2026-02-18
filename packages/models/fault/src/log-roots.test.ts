import { describe, it, expect } from "vitest";
import { identifyLogRoots } from "./log-roots.js";
import type { LogTemplateIndex, LogTemplate } from "@mma/core";

function tmpl(
  id: string,
  template: string,
  severity: "error" | "warn" | "info" | "debug",
  module: string = "src/app.ts",
): LogTemplate {
  return {
    id,
    template,
    severity,
    locations: [{ repo: "test-repo", module, fullyQualifiedName: `${module}:10` }],
    frequency: 1,
  };
}

describe("identifyLogRoots", () => {
  it("identifies error and warn templates as log roots", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [
        tmpl("t1", "database connection failed", "error"),
        tmpl("t2", "cache miss for key <*>", "warn"),
        tmpl("t3", "request received", "info"),
        tmpl("t4", "entering function", "debug"),
      ],
    };

    const roots = identifyLogRoots(index);
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.template.severity === "error" || r.template.severity === "warn")).toBe(true);
  });

  it("classifies severity as critical for fatal/crash/data loss", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [tmpl("t1", "fatal error: data loss detected", "error")],
    };

    const roots = identifyLogRoots(index);
    expect(roots[0]!.severity).toBe("critical");
  });

  it("classifies severity as high for failed/error/timeout", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [tmpl("t1", "request failed with timeout", "error")],
    };

    const roots = identifyLogRoots(index);
    expect(roots[0]!.severity).toBe("high");
  });

  it("classifies severity as medium for warn/deprecated/retry", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [tmpl("t1", "deprecated API call, will retry", "warn")],
    };

    const roots = identifyLogRoots(index);
    expect(roots[0]!.severity).toBe("medium");
  });

  it("classifies severity as low for generic messages", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [tmpl("t1", "unexpected state", "warn")],
    };

    const roots = identifyLogRoots(index);
    expect(roots[0]!.severity).toBe("low");
  });

  it("sorts roots by severity (critical first)", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [
        tmpl("t1", "something warned about deprecation", "warn"),
        tmpl("t2", "fatal crash", "error"),
        tmpl("t3", "operation failed", "error"),
      ],
    };

    const roots = identifyLogRoots(index);
    expect(roots[0]!.severity).toBe("critical");
    expect(roots[1]!.severity).toBe("high");
    expect(roots[2]!.severity).toBe("medium");
  });

  it("infers context from template text", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [
        tmpl("t1", "database query failed", "error"),
        tmpl("t2", "http request timeout", "error"),
        tmpl("t3", "auth token expired", "error"),
      ],
    };

    const roots = identifyLogRoots(index);
    const contexts = roots.map((r) => r.context);
    expect(contexts).toContain("database");
    expect(contexts).toContain("network");
    expect(contexts).toContain("authentication");
  });

  it("creates one root per location", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [
        {
          id: "t1",
          template: "connection failed",
          severity: "error",
          locations: [
            { repo: "test-repo", module: "src/a.ts", fullyQualifiedName: "src/a.ts:5" },
            { repo: "test-repo", module: "src/b.ts", fullyQualifiedName: "src/b.ts:10" },
          ],
          frequency: 2,
        },
      ],
    };

    const roots = identifyLogRoots(index);
    expect(roots).toHaveLength(2);
  });

  it("returns empty for index with no error/warn templates", () => {
    const index: LogTemplateIndex = {
      repo: "test-repo",
      templates: [tmpl("t1", "info message", "info")],
    };

    expect(identifyLogRoots(index)).toHaveLength(0);
  });
});
