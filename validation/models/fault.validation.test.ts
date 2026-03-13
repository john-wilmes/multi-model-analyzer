import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { KVStore } from "@mma/storage";
import { openValidationDb, closeValidationDb } from "../helpers/db.js";
import { ValidationReporter } from "../helpers/reporter.js";
import {
  FAULT_GROUND_TRUTH,
  FAULT_STRUCTURAL,
  VALID_FAULT_TREE_KINDS,
} from "../ground-truth/fault.ground-truth.js";

interface SarifResult {
  ruleId?: string;
  message: { text: string };
}

interface FaultTreeNode {
  kind: string;
  children?: FaultTreeNode[];
}

interface FaultTree {
  topEvent?: FaultTreeNode;
  nodes?: FaultTreeNode[];
}

/** Collect all node kinds recursively from a fault tree. */
function collectKinds(node: FaultTreeNode, out: Set<string>): void {
  out.add(node.kind);
  if (node.children) {
    for (const child of node.children) collectKinds(child, out);
  }
}

/** Flatten all nodes from a fault tree regardless of storage shape. */
function allNodes(tree: FaultTree): FaultTreeNode[] {
  const nodes: FaultTreeNode[] = [];
  if (tree.topEvent) {
    const visit = (n: FaultTreeNode): void => {
      nodes.push(n);
      if (n.children) n.children.forEach(visit);
    };
    visit(tree.topEvent);
  }
  if (tree.nodes) {
    nodes.push(...tree.nodes);
  }
  return nodes;
}

describe("Fault Model Validation", () => {
  let kvStore: KVStore;
  const reporter = new ValidationReporter();

  beforeAll(() => {
    const stores = openValidationDb();
    if (!stores) throw new Error("Validation DB not found — run indexing first");
    kvStore = stores.kvStore;
  });

  afterAll(() => {
    reporter.printSummary();
    closeValidationDb();
  });

  describe("unhandled-error-path detection", () => {
    // Group assertions by repo to avoid repeated KV reads for the same repo.
    const byRepo = new Map<string, typeof FAULT_GROUND_TRUTH>();
    for (const assertion of FAULT_GROUND_TRUTH) {
      const list = byRepo.get(assertion.repo) ?? [];
      list.push(assertion);
      byRepo.set(assertion.repo, list);
    }

    for (const [repo, assertions] of byRepo) {
      describe(repo, () => {
        let results: SarifResult[] | null = null;

        beforeAll(async () => {
          const raw = await kvStore.get(`sarif:fault:${repo}`);
          if (raw) results = JSON.parse(raw) as SarifResult[];
        });

        for (const assertion of assertions) {
          it(`contains path substring "${assertion.signature}" (${assertion.note})`, () => {
            if (!results) {
              reporter.skip("fault", repo, assertion.signature, "no SARIF data");
              expect.soft(results).toBeTruthy();
              return;
            }
            const found = results.some((r) =>
              r.message.text.includes(assertion.signature),
            );
            if (found) {
              reporter.pass("fault", repo, assertion.signature);
            } else {
              reporter.fail(
                "fault",
                repo,
                assertion.signature,
                `not found in ${results.length} findings`,
              );
            }
            expect.soft(found).toBe(true);
          });
        }
      });
    }
  });

  describe("structural checks — SARIF findings", () => {
    for (const [repo, expected] of Object.entries(FAULT_STRUCTURAL)) {
      it(`${repo}: has >= ${expected.minFaultFindings} fault findings`, async () => {
        const raw = await kvStore.get(`sarif:fault:${repo}`);
        if (!raw) return; // skip — no data
        const results = JSON.parse(raw) as unknown[];
        expect(results.length).toBeGreaterThanOrEqual(expected.minFaultFindings);
      });
    }
  });

  describe("structural checks — fault trees", () => {
    for (const [repo, expected] of Object.entries(FAULT_STRUCTURAL)) {
      it(`${repo}: has >= ${expected.minFaultTrees} fault trees`, async () => {
        const raw = await kvStore.get(`faultTrees:${repo}`);
        if (!raw) return; // skip — no data
        const trees = JSON.parse(raw) as FaultTree[];
        expect(trees.length).toBeGreaterThanOrEqual(expected.minFaultTrees);
      });

      it(`${repo}: all fault tree node kinds are valid`, async () => {
        const raw = await kvStore.get(`faultTrees:${repo}`);
        if (!raw) return; // skip — no data
        const trees = JSON.parse(raw) as FaultTree[];
        const validKinds = new Set<string>(VALID_FAULT_TREE_KINDS);
        const invalidKinds = new Set<string>();

        for (const tree of trees) {
          for (const node of allNodes(tree)) {
            if (!validKinds.has(node.kind)) invalidKinds.add(node.kind);
          }
        }

        expect(
          invalidKinds.size,
          `Invalid kinds found: ${[...invalidKinds].join(", ")}`,
        ).toBe(0);
      });

      it(`${repo}: every fault tree has a top-event node`, async () => {
        const raw = await kvStore.get(`faultTrees:${repo}`);
        if (!raw) return; // skip — no data
        const trees = JSON.parse(raw) as FaultTree[];
        const missingTopEvent: number[] = [];

        trees.forEach((tree, idx) => {
          const nodes = allNodes(tree);
          const hasTopEvent = nodes.some((n) => n.kind === "top-event");
          if (!hasTopEvent) missingTopEvent.push(idx);
        });

        expect(
          missingTopEvent.length,
          `Trees at indices [${missingTopEvent.join(", ")}] have no top-event`,
        ).toBe(0);
      });
    }
  });
});
