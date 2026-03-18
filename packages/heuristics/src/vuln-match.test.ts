import { describe, it, expect } from "vitest";
import { isVulnerable, matchAdvisories, checkVulnReachability, vulnReachabilityToSarif, parseNpmAudit, checkTransitiveVulnReachability, vulnReachabilityToSarifWithCodeFlows } from "./vuln-match.js";
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
    const edges = [importEdge("src/app.ts", "lodash/merge")];
    const results = checkVulnReachability([match], edges);

    expect(results).toHaveLength(1);
    expect(results[0]!.reachable).toBe(true);
    expect(results[0]!.directImporters).toEqual(["src/app.ts"]);
  });

  it("detects reachable vulnerability via exact package name", () => {
    const edges = [importEdge("src/app.ts", "lodash")];
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
      importEdge("src/app.ts", "lodash/merge"),
      importEdge("src/app.ts", "lodash/get"),
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

describe("parseNpmAudit", () => {
  it("parses npm audit v2 format (npm 7+)", () => {
    const audit = JSON.stringify({
      vulnerabilities: {
        lodash: {
          severity: "high",
          range: ">=4.0.0 <4.17.21",
          via: [{ source: 1234, url: "https://ghsa.example/001" }],
        },
      },
    });
    const advisories = parseNpmAudit(audit);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.package).toBe("lodash");
    expect(advisories[0]!.severity).toBe("high");
    expect(advisories[0]!.vulnerableRange).toBe(">=4.0.0 <4.17.21");
    expect(advisories[0]!.id).toBe("1234");
  });

  it("parses npm audit v1 format (npm 6)", () => {
    const audit = JSON.stringify({
      advisories: {
        "1234": {
          id: 1234,
          module_name: "express",
          vulnerable_versions: ">=4.0.0 <4.18.2",
          severity: "moderate",
        },
      },
    });
    const advisories = parseNpmAudit(audit);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.package).toBe("express");
    expect(advisories[0]!.severity).toBe("moderate");
    expect(advisories[0]!.id).toBe("1234");
  });

  it("handles string via entries in v2 format", () => {
    const audit = JSON.stringify({
      vulnerabilities: {
        "dep-a": {
          severity: "high",
          range: "*",
          via: ["dep-b"],  // string reference, not an advisory object
        },
      },
    });
    const advisories = parseNpmAudit(audit);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.package).toBe("dep-a");
    expect(advisories[0]!.id).toBe("npm-audit-dep-a"); // fallback ID
  });

  it("returns empty array for empty audit output", () => {
    expect(parseNpmAudit("{}")).toHaveLength(0);
    expect(parseNpmAudit(JSON.stringify({ vulnerabilities: {} }))).toHaveLength(0);
    expect(parseNpmAudit(JSON.stringify({ advisories: {} }))).toHaveLength(0);
  });

  it("maps info severity to low", () => {
    const audit = JSON.stringify({
      vulnerabilities: {
        pkg: { severity: "info", range: "*", via: [{ source: 1 }] },
      },
    });
    const advisories = parseNpmAudit(audit);
    expect(advisories[0]!.severity).toBe("low");
  });
});

describe("checkTransitiveVulnReachability", () => {
  const advisory: Advisory = {
    id: "GHSA-001",
    package: "lodash",
    vulnerableRange: ">=4.0.0 <4.17.21",
    severity: "high",
  };
  const pkg: InstalledPackage = { name: "lodash", version: "4.17.20" };
  const match = { pkg, advisory };

  it("finds direct importers like checkVulnReachability", () => {
    const edges: GraphEdge[] = [importEdge("src/app.ts", "lodash")];
    const results = checkTransitiveVulnReachability([match], edges);
    expect(results[0]!.reachable).toBe(true);
    expect(results[0]!.directImporters).toEqual(["src/app.ts"]);
  });

  it("finds transitive chain: A→B→lodash", () => {
    const edges: GraphEdge[] = [
      importEdge("src/app.ts", "src/utils.ts"),
      importEdge("src/utils.ts", "lodash"),
    ];
    const results = checkTransitiveVulnReachability([match], edges);
    expect(results[0]!.reachable).toBe(true);
    expect(results[0]!.directImporters).toEqual(["src/utils.ts"]);
    expect(results[0]!.transitiveImporters).toContain("src/app.ts");
    expect(results[0]!.totalReach).toBe(2);
  });

  it("respects maxDepth limit", () => {
    const edges: GraphEdge[] = [
      importEdge("src/deep.ts", "src/mid.ts"),
      importEdge("src/mid.ts", "src/app.ts"),
      importEdge("src/app.ts", "lodash"),
    ];
    const results = checkTransitiveVulnReachability([match], edges, { maxDepth: 1 });
    expect(results[0]!.directImporters).toEqual(["src/app.ts"]);
    // maxDepth=1 means BFS stops after 1 hop from direct importers
    // so src/mid.ts should be found but src/deep.ts should not
    expect(results[0]!.transitiveImporters).toContain("src/mid.ts");
    expect(results[0]!.transitiveImporters).not.toContain("src/deep.ts");
  });

  it("deduplicates diamond paths", () => {
    const edges: GraphEdge[] = [
      importEdge("src/top.ts", "src/left.ts"),
      importEdge("src/top.ts", "src/right.ts"),
      importEdge("src/left.ts", "lodash"),
      importEdge("src/right.ts", "lodash"),
    ];
    const results = checkTransitiveVulnReachability([match], edges);
    // direct: left.ts, right.ts. transitive: top.ts (only once)
    expect([...results[0]!.directImporters].sort()).toEqual(["src/left.ts", "src/right.ts"]);
    expect(results[0]!.transitiveImporters).toEqual(["src/top.ts"]);
    expect(results[0]!.totalReach).toBe(3);
  });

  it("returns unchanged result for unreachable vulns", () => {
    const edges: GraphEdge[] = [importEdge("src/app.ts", "src/utils.ts")];
    const results = checkTransitiveVulnReachability([match], edges);
    expect(results[0]!.reachable).toBe(false);
    expect(results[0]!.transitiveImporters).toBeUndefined();
  });
});

describe("vulnReachabilityToSarifWithCodeFlows", () => {
  it("includes codeFlows when transitiveImporters exist", () => {
    const results = [{
      advisory: { id: "GHSA-001", package: "lodash", vulnerableRange: "*", severity: "high" as const },
      pkg: { name: "lodash", version: "4.17.20" },
      directImporters: ["src/utils.ts"],
      reachable: true,
      transitiveImporters: ["src/app.ts"],
      totalReach: 2,
      maxDepth: 1,
    }];
    const sarif = vulnReachabilityToSarifWithCodeFlows(results, "test-repo");

    expect(sarif).toHaveLength(1);
    expect(sarif[0]!.codeFlows).toBeDefined();
    const flow = sarif[0]!.codeFlows![0]!;
    const locs = flow.threadFlows[0]!.locations;
    expect(locs[0]!.nestingLevel).toBe(0); // transitive
    expect(locs[1]!.nestingLevel).toBe(1); // direct
    expect(locs[2]!.nestingLevel).toBe(2); // package
  });

  it("has correct nestingLevel progression", () => {
    const results = [{
      advisory: { id: "GHSA-001", package: "lodash", vulnerableRange: "*", severity: "critical" as const },
      pkg: { name: "lodash", version: "4.17.20" },
      directImporters: ["src/utils.ts"],
      reachable: true,
      transitiveImporters: ["src/app.ts", "src/main.ts"],
      totalReach: 3,
      maxDepth: 2,
    }];
    const sarif = vulnReachabilityToSarifWithCodeFlows(results, "test-repo");

    const locs = sarif[0]!.codeFlows![0]!.threadFlows[0]!.locations;
    // 2 transitive at level 0, 1 direct at level 1, 1 package at level 2
    expect(locs.filter(l => l.nestingLevel === 0)).toHaveLength(2);
    expect(locs.filter(l => l.nestingLevel === 1)).toHaveLength(1);
    expect(locs.filter(l => l.nestingLevel === 2)).toHaveLength(1);
  });

  it("omits codeFlows when no transitiveImporters", () => {
    const results = [{
      advisory: { id: "GHSA-001", package: "lodash", vulnerableRange: "*", severity: "high" as const },
      pkg: { name: "lodash", version: "4.17.20" },
      directImporters: ["src/app.ts"],
      reachable: true,
    }];
    const sarif = vulnReachabilityToSarifWithCodeFlows(results, "test-repo");

    expect(sarif).toHaveLength(1);
    expect(sarif[0]!.codeFlows).toBeUndefined();
  });
});
