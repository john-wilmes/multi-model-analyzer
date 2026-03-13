import { describe, it, expect } from "vitest";
import { isVulnerable, matchAdvisories, checkVulnReachability, vulnReachabilityToSarif } from "./vuln-match.js";
import type { Advisory, InstalledPackage } from "./vuln-match.js";
import type { GraphEdge } from "@mma/core";

describe("isVulnerable", () => {
  const advisory: Advisory = {
    id: "GHSA-001",
    package: "lodash",
    vulnerableRange: ">=4.0.0 <4.17.21",
    severity: "high",
  };

  it("returns true for version in vulnerable range", () => {
    const pkg: InstalledPackage = { name: "lodash", version: "4.17.20" };
    expect(isVulnerable(pkg, advisory)).toBe(true);
  });

  it("returns false for version outside vulnerable range", () => {
    const pkg: InstalledPackage = { name: "lodash", version: "4.17.21" };
    expect(isVulnerable(pkg, advisory)).toBe(false);
  });

  it("returns false for different package name", () => {
    const pkg: InstalledPackage = { name: "underscore", version: "4.17.20" };
    expect(isVulnerable(pkg, advisory)).toBe(false);
  });

  it("returns false for version below range", () => {
    const pkg: InstalledPackage = { name: "lodash", version: "3.10.0" };
    expect(isVulnerable(pkg, advisory)).toBe(false);
  });
});

describe("matchAdvisories", () => {
  const advisories: Advisory[] = [
    {
      id: "GHSA-001",
      package: "lodash",
      vulnerableRange: ">=4.0.0 <4.17.21",
      severity: "high",
    },
    {
      id: "GHSA-002",
      package: "express",
      vulnerableRange: ">=4.0.0 <4.18.2",
      severity: "moderate",
    },
  ];

  it("finds matching advisories for installed packages", () => {
    const installed: InstalledPackage[] = [
      { name: "lodash", version: "4.17.20" },
      { name: "express", version: "4.18.0" },
    ];
    const matches = matchAdvisories(installed, advisories);
    expect(matches).toHaveLength(2);
  });

  it("returns empty when no packages are vulnerable", () => {
    const installed: InstalledPackage[] = [
      { name: "lodash", version: "4.17.21" },
      { name: "express", version: "4.18.2" },
    ];
    const matches = matchAdvisories(installed, advisories);
    expect(matches).toHaveLength(0);
  });

  it("handles empty inputs", () => {
    expect(matchAdvisories([], advisories)).toHaveLength(0);
    expect(matchAdvisories([{ name: "lodash", version: "4.17.20" }], [])).toHaveLength(0);
  });

  it("matches package to correct advisory", () => {
    const installed: InstalledPackage[] = [
      { name: "express", version: "4.17.0" },
    ];
    const matches = matchAdvisories(installed, advisories);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.advisory.id).toBe("GHSA-002");
    expect(matches[0]!.pkg.name).toBe("express");
  });
});

function importEdge(source: string, target: string): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo: "test" } };
}

describe("checkVulnReachability", () => {
  const advisory: Advisory = {
    id: "GHSA-001",
    package: "lodash",
    vulnerableRange: ">=4.0.0 <4.17.21",
    severity: "high",
  };
  const pkg: InstalledPackage = { name: "lodash", version: "4.17.20" };
  const match = { pkg, advisory };

  it("detects reachable vulnerability via import edge", () => {
    const edges = [importEdge("src/app.ts", "node_modules/lodash/merge.js")];
    const results = checkVulnReachability([match], edges);

    expect(results).toHaveLength(1);
    expect(results[0]!.reachable).toBe(true);
    expect(results[0]!.directImporters).toEqual(["src/app.ts"]);
  });

  it("marks unreachable when no import edges match", () => {
    const edges = [importEdge("src/app.ts", "src/utils.ts")];
    const results = checkVulnReachability([match], edges);

    expect(results).toHaveLength(1);
    expect(results[0]!.reachable).toBe(false);
    expect(results[0]!.directImporters).toHaveLength(0);
  });

  it("deduplicates multiple imports from same file", () => {
    const edges = [
      importEdge("src/app.ts", "node_modules/lodash/merge.js"),
      importEdge("src/app.ts", "node_modules/lodash/get.js"),
    ];
    const results = checkVulnReachability([match], edges);

    expect(results[0]!.directImporters).toEqual(["src/app.ts"]);
  });
});

describe("vulnReachabilityToSarif", () => {
  it("converts reachable vulnerabilities to SARIF", () => {
    const results = [{
      advisory: { id: "GHSA-001", package: "lodash", vulnerableRange: ">=4.0.0 <4.17.21", severity: "high" as const },
      pkg: { name: "lodash", version: "4.17.20" },
      directImporters: ["src/app.ts"],
      reachable: true,
    }];
    const sarif = vulnReachabilityToSarif(results, "test-repo");

    expect(sarif).toHaveLength(1);
    expect(sarif[0]!.ruleId).toBe("vuln/reachable-dependency");
    expect(sarif[0]!.level).toBe("error"); // high severity
    expect(sarif[0]!.message.text).toContain("lodash");
  });

  it("skips unreachable vulnerabilities", () => {
    const results = [{
      advisory: { id: "GHSA-001", package: "lodash", vulnerableRange: "*", severity: "high" as const },
      pkg: { name: "lodash", version: "4.17.20" },
      directImporters: [],
      reachable: false,
    }];
    const sarif = vulnReachabilityToSarif(results, "test-repo");
    expect(sarif).toHaveLength(0);
  });
});
