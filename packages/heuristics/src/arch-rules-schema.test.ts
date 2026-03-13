import { describe, it, expect } from "vitest";
import { validateArchRules } from "./arch-rules-schema.js";
import type { RawArchRule } from "./arch-rules-schema.js";

describe("validateArchRules", () => {
  it("validates a correct layer-violation rule", () => {
    const raw: RawArchRule[] = [{
      id: "layers",
      kind: "layer-violation",
      severity: "warning",
      config: {
        layers: [
          { name: "ui", patterns: ["src/ui/**"], allowedDependencies: ["service"] },
          { name: "service", patterns: ["src/svc/**"], allowedDependencies: [] },
        ],
      },
    }];
    const { rules, errors } = validateArchRules(raw);
    expect(errors).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe("layer-violation");
  });

  it("validates a correct forbidden-import rule", () => {
    const raw: RawArchRule[] = [{
      id: "no-lodash",
      kind: "forbidden-import",
      severity: "error",
      config: { from: ["src/**"], forbidden: ["node_modules/lodash/**"] },
    }];
    const { rules, errors } = validateArchRules(raw);
    expect(errors).toHaveLength(0);
    expect(rules).toHaveLength(1);
  });

  it("validates a correct dependency-direction rule", () => {
    const raw: RawArchRule[] = [{
      id: "no-reverse",
      kind: "dependency-direction",
      config: { denied: [["src/db/**", "src/ui/**"]] },
    }];
    const { rules, errors } = validateArchRules(raw);
    expect(errors).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.severity).toBe("warning"); // default
  });

  it("rejects rule without id", () => {
    const raw: RawArchRule[] = [{ kind: "layer-violation", config: { layers: [] } }];
    const { rules, errors } = validateArchRules(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("id");
    expect(rules).toHaveLength(0);
  });

  it("rejects rule with invalid kind", () => {
    const raw: RawArchRule[] = [{ id: "test", kind: "unknown-kind", config: {} }];
    const { errors } = validateArchRules(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("kind");
  });

  it("rejects rule with invalid severity", () => {
    const raw: RawArchRule[] = [{
      id: "test",
      kind: "forbidden-import",
      severity: "critical",
      config: { from: [], forbidden: [] },
    }];
    const { errors } = validateArchRules(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("severity");
  });

  it("rejects layer rule without layers array", () => {
    const raw: RawArchRule[] = [{
      id: "test",
      kind: "layer-violation",
      config: { layers: "not-an-array" },
    }];
    const { errors } = validateArchRules(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("config.layers");
  });

  it("rejects forbidden-import without from array", () => {
    const raw: RawArchRule[] = [{
      id: "test",
      kind: "forbidden-import",
      config: { forbidden: ["**"] },
    }];
    const { errors } = validateArchRules(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("config.from");
  });

  it("rejects dependency-direction without denied array", () => {
    const raw: RawArchRule[] = [{
      id: "test",
      kind: "dependency-direction",
      config: {},
    }];
    const { errors } = validateArchRules(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("config.denied");
  });

  it("validates multiple rules and reports errors per-rule", () => {
    const raw: RawArchRule[] = [
      { id: "good", kind: "forbidden-import", config: { from: ["a"], forbidden: ["b"] } },
      { kind: "bad" }, // missing id
      { id: "also-good", kind: "dependency-direction", config: { denied: [] } },
    ];
    const { rules, errors } = validateArchRules(raw);
    expect(rules).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ruleIndex).toBe(1);
  });

  it("handles empty rules array", () => {
    const { rules, errors } = validateArchRules([]);
    expect(rules).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
