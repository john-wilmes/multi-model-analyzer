import { describe, it, expect } from "vitest";
import { evaluateArchRules, globMatch } from "./arch-rules.js";
import type { ArchitecturalRule, GraphEdge } from "@mma/core";

function importEdge(source: string, target: string): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo: "test" } };
}

describe("globMatch", () => {
  it("matches exact paths", () => {
    expect(globMatch("src/db/query.ts", "src/db/query.ts")).toBe(true);
    expect(globMatch("src/db/query.ts", "src/db/other.ts")).toBe(false);
  });

  it("matches single wildcard (*)", () => {
    expect(globMatch("src/db/query.ts", "src/db/*.ts")).toBe(true);
    expect(globMatch("src/db/deep/query.ts", "src/db/*.ts")).toBe(false);
  });

  it("matches double wildcard (**)", () => {
    expect(globMatch("src/db/deep/query.ts", "src/db/**")).toBe(true);
    expect(globMatch("src/db/query.ts", "src/db/**")).toBe(true);
    expect(globMatch("src/ui/component.ts", "src/db/**")).toBe(false);
  });

  it("matches controller pattern", () => {
    expect(globMatch("src/api/user.controller.ts", "**/*.controller.ts")).toBe(true);
    expect(globMatch("src/api/user.service.ts", "**/*.controller.ts")).toBe(false);
  });
});

describe("evaluateArchRules", () => {
  describe("layer-violation", () => {
    const layerRule: ArchitecturalRule = {
      id: "layers",
      description: "UI cannot import DB",
      kind: "layer-violation",
      severity: "warning",
      config: {
        layers: [
          { name: "ui", patterns: ["src/ui/**"], allowedDependencies: ["service"] },
          { name: "service", patterns: ["src/service/**"], allowedDependencies: ["db"] },
          { name: "db", patterns: ["src/db/**"], allowedDependencies: [] },
        ],
      },
    };

    it("detects layer violation: UI imports DB", () => {
      const edges = [importEdge("src/ui/page.ts", "src/db/query.ts")];
      const results = evaluateArchRules([layerRule], edges, "test");

      expect(results).toHaveLength(1);
      expect(results[0]!.ruleId).toBe("arch/layer-violation");
      expect(results[0]!.message.text).toContain("ui");
      expect(results[0]!.message.text).toContain("db");
    });

    it("allows permitted dependency: UI imports service", () => {
      const edges = [importEdge("src/ui/page.ts", "src/service/user.ts")];
      const results = evaluateArchRules([layerRule], edges, "test");
      expect(results).toHaveLength(0);
    });

    it("allows same-layer imports", () => {
      const edges = [importEdge("src/ui/page.ts", "src/ui/utils.ts")];
      const results = evaluateArchRules([layerRule], edges, "test");
      expect(results).toHaveLength(0);
    });
  });

  describe("forbidden-import", () => {
    const forbiddenRule: ArchitecturalRule = {
      id: "no-lodash",
      description: "Frontend cannot use lodash",
      kind: "forbidden-import",
      severity: "error",
      config: {
        from: ["src/frontend/**"],
        forbidden: ["node_modules/lodash/**"],
      },
    };

    it("detects forbidden import", () => {
      const edges = [importEdge("src/frontend/app.ts", "node_modules/lodash/merge.js")];
      const results = evaluateArchRules([forbiddenRule], edges, "test");

      expect(results).toHaveLength(1);
      expect(results[0]!.ruleId).toBe("arch/forbidden-import");
      expect(results[0]!.level).toBe("error");
    });

    it("allows non-forbidden imports", () => {
      const edges = [importEdge("src/frontend/app.ts", "src/frontend/utils.ts")];
      const results = evaluateArchRules([forbiddenRule], edges, "test");
      expect(results).toHaveLength(0);
    });

    it("allows forbidden import from non-matching source", () => {
      const edges = [importEdge("src/backend/server.ts", "node_modules/lodash/merge.js")];
      const results = evaluateArchRules([forbiddenRule], edges, "test");
      expect(results).toHaveLength(0);
    });
  });

  describe("dependency-direction", () => {
    const directionRule: ArchitecturalRule = {
      id: "no-reverse",
      description: "DB must not import UI",
      kind: "dependency-direction",
      severity: "warning",
      config: {
        allowed: [["src/ui/**", "src/service/**"]],
        denied: [["src/db/**", "src/ui/**"]],
      },
    };

    it("detects denied dependency direction", () => {
      const edges = [importEdge("src/db/repo.ts", "src/ui/config.ts")];
      const results = evaluateArchRules([directionRule], edges, "test");

      expect(results).toHaveLength(1);
      expect(results[0]!.ruleId).toBe("arch/dependency-direction");
    });

    it("does not flag non-denied pairs", () => {
      const edges = [importEdge("src/ui/page.ts", "src/service/api.ts")];
      const results = evaluateArchRules([directionRule], edges, "test");
      expect(results).toHaveLength(0);
    });
  });

  it("handles empty rules gracefully", () => {
    const edges = [importEdge("a.ts", "b.ts")];
    const results = evaluateArchRules([], edges, "test");
    expect(results).toHaveLength(0);
  });

  it("handles empty edges gracefully", () => {
    const rule: ArchitecturalRule = {
      id: "test",
      description: "test",
      kind: "layer-violation",
      severity: "warning",
      config: { layers: [{ name: "a", patterns: ["**"], allowedDependencies: [] }] },
    };
    const results = evaluateArchRules([rule], [], "test");
    expect(results).toHaveLength(0);
  });
});
