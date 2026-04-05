/**
 * Worker thread for computeReachCounts.
 *
 * Self-contained: no imports from @mma/* packages. Receives serialized edges
 * via workerData, runs SCC + bitset propagation, posts [key, value][] back.
 */

import { workerData, parentPort } from "node:worker_threads";

// ---------------------------------------------------------------------------
// Pure computation helpers (copied from blast-radius.ts)
// ---------------------------------------------------------------------------

/** Popcount for a 32-bit integer (Knuth SWAR / Hamming weight). */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** Count total set bits across a Uint32Array bitset. */
function bitsetPopcount(bs: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < bs.length; i++) count += popcount32(bs[i]!);
  return count;
}

/** OR src into dst in-place. */
function bitsetOr(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! |= src[i]!;
}

/**
 * Iterative Tarjan's SCC on integer-indexed graph.
 * Returns SCCs in reverse topological order (sinks first).
 */
function tarjanSCC(V: number, adj: number[][]): number[][] {
  const index = new Int32Array(V).fill(-1);
  const lowlink = new Int32Array(V);
  const onStack = new Uint8Array(V);
  const sccs: number[][] = [];
  const stack: number[] = [];
  let nextIndex = 0;

  const dfsStack: Array<[number, number]> = [];

  for (let start = 0; start < V; start++) {
    if (index[start] !== -1) continue;

    dfsStack.push([start, 0]);
    index[start] = lowlink[start] = nextIndex++;
    stack.push(start);
    onStack[start] = 1;

    while (dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1]!;
      const v = frame[0];
      const neighbors = adj[v]!;

      if (frame[1] < neighbors.length) {
        const w = neighbors[frame[1]++]!;
        if (index[w] === -1) {
          index[w] = lowlink[w] = nextIndex++;
          stack.push(w);
          onStack[w] = 1;
          dfsStack.push([w, 0]);
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v]!, index[w]!);
        }
      } else {
        if (lowlink[v] === index[v]) {
          const scc: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            scc.push(w);
          } while (w !== v);
          sccs.push(scc);
        }
        dfsStack.pop();
        if (dfsStack.length > 0) {
          const parent = dfsStack[dfsStack.length - 1]![0];
          lowlink[parent] = Math.min(lowlink[parent]!, lowlink[v]!);
        }
      }
    }
  }

  return sccs;
}

// ---------------------------------------------------------------------------
// Main worker computation
// ---------------------------------------------------------------------------

interface WorkerInput {
  readonly edges: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}

function computeInWorker(
  edges: ReadonlyArray<{ readonly source: string; readonly target: string }>,
): [string, number][] {
  // Build reverse adjacency: "A imports B" → reverse: B -> [A]
  const reverseAdj = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    allNodes.add(edge.source);
    allNodes.add(edge.target);
    let deps = reverseAdj.get(edge.target);
    if (!deps) {
      deps = [];
      reverseAdj.set(edge.target, deps);
    }
    deps.push(edge.source);
  }

  const V = allNodes.size;
  if (V === 0) return [];

  // Map node names to integer IDs
  const nodeToId = new Map<string, number>();
  const idToNode: string[] = [];
  for (const node of allNodes) {
    nodeToId.set(node, idToNode.length);
    idToNode.push(node);
  }

  // Build integer-indexed reverse adjacency
  const intAdj: number[][] = new Array(V);
  for (let i = 0; i < V; i++) intAdj[i] = [];
  for (const [target, sources] of reverseAdj) {
    const tId = nodeToId.get(target)!;
    for (const src of sources) {
      intAdj[tId]!.push(nodeToId.get(src)!);
    }
  }

  // Tarjan's SCC on reverse graph — returns SCCs in reverse topo order (sinks first)
  const sccs = tarjanSCC(V, intAdj);
  const numSCCs = sccs.length;

  // Map each node to its SCC index
  const sccOf = new Int32Array(V);
  for (let s = 0; s < numSCCs; s++) {
    for (const v of sccs[s]!) sccOf[v] = s;
  }

  // Build condensed DAG edges (SCC → SCC, deduplicated)
  const condensedAdj: Set<number>[] = new Array(numSCCs);
  for (let s = 0; s < numSCCs; s++) condensedAdj[s] = new Set();
  for (let v = 0; v < V; v++) {
    const sv = sccOf[v]!;
    for (const w of intAdj[v]!) {
      const sw = sccOf[w]!;
      if (sv !== sw) condensedAdj[sv]!.add(sw);
    }
  }

  // Bitset propagation: each SCC gets a bitset of size ceil(V/32)
  const words = (V + 31) >>> 5;
  const bitsets: Uint32Array[] = new Array(numSCCs);
  for (let s = 0; s < numSCCs; s++) {
    const bs = new Uint32Array(words);
    for (const v of sccs[s]!) {
      const word = v >>> 5;
      bs[word] = (bs[word] ?? 0) | (1 << (v & 31));
    }
    bitsets[s] = bs;
  }

  // Propagate in Tarjan output order (sinks first = already correct order)
  for (let s = 0; s < numSCCs; s++) {
    for (const succ of condensedAdj[s]!) {
      bitsetOr(bitsets[s]!, bitsets[succ]!);
    }
  }

  // Extract results
  const result: [string, number][] = [];
  for (let v = 0; v < V; v++) {
    const count = bitsetPopcount(bitsets[sccOf[v]!]!) - 1; // exclude self
    result.push([idToNode[v]!, count]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

if (!parentPort) {
  throw new Error("reach-worker.ts must be run as a worker thread");
}

const input = workerData as WorkerInput;

try {
  const result = computeInWorker(input.edges);
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
