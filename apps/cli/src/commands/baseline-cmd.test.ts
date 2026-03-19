import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryKVStore } from "@mma/storage";
import type { SarifLog } from "@mma/core";
import {
  baselineCreateCommand,
  baselineCheckCommand,
  type BaselineFile,
} from "./baseline-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mma-baseline-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeSarifLog(results: Array<{ ruleId: string; fqns: string[] }>): SarifLog {
  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: results.map((r) => ({
          ruleId: r.ruleId,
          level: "warning" as const,
          message: { text: `Finding ${r.ruleId}` },
          locations: [
            {
              logicalLocations: r.fqns.map((fqn) => ({
                fullyQualifiedName: fqn,
              })),
            },
          ],
        })),
      },
    ],
  };
}

async function seedSarif(
  kv: InMemoryKVStore,
  results: Array<{ ruleId: string; fqns: string[] }>,
): Promise<void> {
  await kv.set("sarif:latest", JSON.stringify(makeSarifLog(results)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("baseline create", () => {
  it("writes correct fingerprints from sarif:latest", async () => {
    const kv = new InMemoryKVStore();
    await seedSarif(kv, [
      { ruleId: "sdp/violation", fqns: ["moduleA", "moduleB"] },
      { ruleId: "god-module", fqns: ["moduleC"] },
    ]);

    const outputPath = join(tempDir, "baseline.json");
    const result = await baselineCreateCommand({ kvStore: kv, output: outputPath });

    expect(result.count).toBe(2);

    const raw = await readFile(outputPath, "utf-8");
    const baseline = JSON.parse(raw) as BaselineFile;
    expect(baseline.version).toBe(1);
    expect(baseline.tool).toBe("mma");
    expect(baseline.totalFindings).toBe(2);
    expect(baseline.fingerprints).toHaveLength(2);
    expect(baseline.fingerprints[0]).toBe("sdp/violation::moduleA|moduleB");
    expect(baseline.fingerprints[1]).toBe("god-module::moduleC");
  });

  it("handles empty sarif:latest gracefully", async () => {
    const kv = new InMemoryKVStore();
    const outputPath = join(tempDir, "baseline.json");
    const result = await baselineCreateCommand({ kvStore: kv, output: outputPath });

    expect(result.count).toBe(0);

    const baseline = JSON.parse(await readFile(outputPath, "utf-8")) as BaselineFile;
    expect(baseline.totalFindings).toBe(0);
    expect(baseline.fingerprints).toHaveLength(0);
  });
});

describe("baseline check", () => {
  it("returns empty newFindings when nothing changed", async () => {
    const kv = new InMemoryKVStore();
    const findings = [
      { ruleId: "sdp/violation", fqns: ["moduleA", "moduleB"] },
      { ruleId: "god-module", fqns: ["moduleC"] },
    ];
    await seedSarif(kv, findings);

    // Create baseline from current state
    const baselinePath = join(tempDir, "baseline.json");
    await baselineCreateCommand({ kvStore: kv, output: baselinePath });

    // Check — same findings
    const result = await baselineCheckCommand({ kvStore: kv, baselinePath });

    expect(result.totalCurrent).toBe(2);
    expect(result.totalBaseline).toBe(2);
    expect(result.newFindings).toHaveLength(0);
    expect(result.absentFindings).toBe(0);
  });

  it("detects new findings not in baseline", async () => {
    const kv = new InMemoryKVStore();

    // Baseline has one finding
    await seedSarif(kv, [{ ruleId: "god-module", fqns: ["moduleC"] }]);
    const baselinePath = join(tempDir, "baseline.json");
    await baselineCreateCommand({ kvStore: kv, output: baselinePath });

    // Current has two findings (one new)
    await seedSarif(kv, [
      { ruleId: "god-module", fqns: ["moduleC"] },
      { ruleId: "sdp/violation", fqns: ["moduleA", "moduleB"] },
    ]);

    const result = await baselineCheckCommand({ kvStore: kv, baselinePath });

    expect(result.totalCurrent).toBe(2);
    expect(result.totalBaseline).toBe(1);
    expect(result.newFindings).toHaveLength(1);
    expect(result.newFindings[0]!.ruleId).toBe("sdp/violation");
    expect(result.absentFindings).toBe(0);
  });

  it("reports absent findings (in baseline but no longer present)", async () => {
    const kv = new InMemoryKVStore();

    // Baseline has two findings
    await seedSarif(kv, [
      { ruleId: "god-module", fqns: ["moduleC"] },
      { ruleId: "sdp/violation", fqns: ["moduleA", "moduleB"] },
    ]);
    const baselinePath = join(tempDir, "baseline.json");
    await baselineCreateCommand({ kvStore: kv, output: baselinePath });

    // Current has only one (the other was fixed)
    await seedSarif(kv, [{ ruleId: "god-module", fqns: ["moduleC"] }]);

    const result = await baselineCheckCommand({ kvStore: kv, baselinePath });

    expect(result.totalCurrent).toBe(1);
    expect(result.totalBaseline).toBe(2);
    expect(result.newFindings).toHaveLength(0);
    expect(result.absentFindings).toBe(1);
  });

  it("handles missing baseline file", async () => {
    const kv = new InMemoryKVStore();
    const baselinePath = join(tempDir, "nonexistent.json");

    await expect(
      baselineCheckCommand({ kvStore: kv, baselinePath }),
    ).rejects.toThrow(/Could not read baseline file/);
  });

  it("handles malformed baseline file", async () => {
    const kv = new InMemoryKVStore();
    const baselinePath = join(tempDir, "bad.json");
    await writeFile(baselinePath, "not json at all", "utf-8");

    await expect(
      baselineCheckCommand({ kvStore: kv, baselinePath }),
    ).rejects.toThrow(/Could not read baseline file/);
  });

  it("handles empty sarif:latest with existing baseline", async () => {
    const kv = new InMemoryKVStore();

    // Create baseline with findings
    await seedSarif(kv, [{ ruleId: "god-module", fqns: ["moduleC"] }]);
    const baselinePath = join(tempDir, "baseline.json");
    await baselineCreateCommand({ kvStore: kv, output: baselinePath });

    // Clear sarif:latest
    await kv.delete("sarif:latest");

    const result = await baselineCheckCommand({ kvStore: kv, baselinePath });

    expect(result.totalCurrent).toBe(0);
    expect(result.totalBaseline).toBe(1);
    expect(result.newFindings).toHaveLength(0);
    expect(result.absentFindings).toBe(1);
  });
});
