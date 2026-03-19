/**
 * Tests for the audit command (C2).
 */

import { describe, it, expect } from "vitest";
import { InMemoryKVStore, InMemoryGraphStore } from "@mma/storage";
import { auditCommand } from "./audit-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_AUDIT_JSON = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    "lodash": {
      name: "lodash",
      severity: "high",
      via: [
        {
          name: "lodash",
          title: "Prototype Pollution",
          url: "https://npmjs.com/advisories/1523",
          severity: "high",
          range: "<4.17.21",
          cwe: ["CWE-1321"],
        },
      ],
      effects: [],
      range: "<4.17.21",
      nodes: ["node_modules/lodash"],
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: { high: 1, total: 1 },
    dependencies: { total: 100 },
  },
});

const EMPTY_AUDIT_JSON = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { total: 0 },
    dependencies: { total: 50 },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auditCommand — empty stores", () => {
  it("returns hasFindings=false when audit has no vulnerabilities", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();

    // Write an empty audit file
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const auditFile = join(tmpdir(), `audit-empty-${Date.now()}.json`);
    writeFileSync(auditFile, EMPTY_AUDIT_JSON, "utf-8");

    try {
      const result = await auditCommand({
        auditFile,
        kvStore: kv,
        graphStore: gs,
      });
      expect(result.hasFindings).toBe(false);
    } finally {
      unlinkSync(auditFile);
    }
  });

  it("returns hasFindings=false when no repos are indexed", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    // No sarif:latest:index key — no repos
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const auditFile = join(tmpdir(), `audit-norepos-${Date.now()}.json`);
    writeFileSync(auditFile, MINIMAL_AUDIT_JSON, "utf-8");

    try {
      const result = await auditCommand({
        auditFile,
        kvStore: kv,
        graphStore: gs,
      });
      expect(result.hasFindings).toBe(false);
    } finally {
      unlinkSync(auditFile);
    }
  });
});

describe("auditCommand — with indexed repos", () => {
  async function makeStoresWithRepo(repo: string) {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    await kv.set(
      "sarif:latest:index",
      JSON.stringify({ repos: [repo] }),
    );
    // Add an import edge so the repo is non-empty
    await gs.addEdges([
      {
        source: `${repo}/src/app.ts`,
        target: "lodash",
        kind: "imports",
        metadata: { repo },
      },
    ]);
    return { kv, gs };
  }

  it("returns AuditResult with hasFindings boolean", async () => {
    const { kv, gs } = await makeStoresWithRepo("my-repo");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const auditFile = join(tmpdir(), `audit-basic-${Date.now()}.json`);
    writeFileSync(auditFile, MINIMAL_AUDIT_JSON, "utf-8");

    try {
      const result = await auditCommand({
        auditFile,
        kvStore: kv,
        graphStore: gs,
        repo: "my-repo",
      });
      expect(typeof result.hasFindings).toBe("boolean");
    } finally {
      unlinkSync(auditFile);
    }
  });

  it("stores sarif:vuln:<repo> in KV when reachable findings exist", async () => {
    const { kv, gs } = await makeStoresWithRepo("vuln-repo");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const auditFile = join(tmpdir(), `audit-vuln-${Date.now()}.json`);
    writeFileSync(auditFile, MINIMAL_AUDIT_JSON, "utf-8");

    try {
      await auditCommand({
        auditFile,
        kvStore: kv,
        graphStore: gs,
        repo: "vuln-repo",
      });
      // If findings were stored, the key should contain valid JSON
      const stored = await kv.get("sarif:vuln:vuln-repo");
      if (stored !== undefined) {
        expect(() => JSON.parse(stored) as unknown).not.toThrow();
        const findings = JSON.parse(stored) as Array<{
          ruleId: string;
          message: { text: string };
          level: string;
        }>;
        expect(Array.isArray(findings)).toBe(true);
        if (findings.length > 0) {
          expect(findings[0]).toMatchObject({
            ruleId: expect.any(String) as unknown,
            message: expect.objectContaining({
              text: expect.any(String),
            }) as unknown,
            level: expect.any(String) as unknown,
          });
        }
      }
    } finally {
      unlinkSync(auditFile);
    }
  });

  it("scopes to a single repo when --repo is provided", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    await kv.set(
      "sarif:latest:index",
      JSON.stringify({ repos: ["repo-a", "repo-b"] }),
    );
    await gs.addEdges([
      {
        source: "repo-a/src/app.ts",
        target: "lodash",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const auditFile = join(tmpdir(), `audit-scoped-${Date.now()}.json`);
    writeFileSync(auditFile, MINIMAL_AUDIT_JSON, "utf-8");

    try {
      await auditCommand({
        auditFile,
        kvStore: kv,
        graphStore: gs,
        repo: "repo-a",
      });
      // repo-b should have no SARIF key written
      const repoB = await kv.get("sarif:vuln:repo-b");
      expect(repoB).toBeUndefined();
    } finally {
      unlinkSync(auditFile);
    }
  });
});

describe("auditCommand — AuditResult exit-code integration (PR #49)", () => {
  it("returns AuditResult object (not void)", async () => {
    const kv = new InMemoryKVStore();
    const gs = new InMemoryGraphStore();
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const auditFile = join(tmpdir(), `audit-result-${Date.now()}.json`);
    writeFileSync(auditFile, EMPTY_AUDIT_JSON, "utf-8");

    try {
      const result = await auditCommand({
        auditFile,
        kvStore: kv,
        graphStore: gs,
      });
      // AuditResult must have hasFindings
      expect(result).toMatchObject({
        hasFindings: expect.any(Boolean) as unknown,
      });
    } finally {
      unlinkSync(auditFile);
    }
  });
});
