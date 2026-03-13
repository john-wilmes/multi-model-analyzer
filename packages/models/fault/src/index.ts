export { identifyLogRoots } from "./log-roots.js";
export type { LogRoot } from "./log-roots.js";

export { traceBackwardFromLog } from "./backward-trace.js";
export type { TraceStep, BackwardTrace, CrossServiceCall } from "./backward-trace.js";

export { buildFaultTree, analyzeGaps, faultTreeToCodeFlow, FAULT_RULES } from "./fault-tree.js";
