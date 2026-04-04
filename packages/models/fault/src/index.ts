export { identifyLogRoots } from "./log-roots.js";
export type { LogRoot } from "./log-roots.js";

export { traceBackwardFromLog } from "./backward-trace.js";
export type { TraceStep, BackwardTrace, CrossServiceCall } from "./backward-trace.js";

export {
  buildFaultTree,
  analyzeGaps,
  analyzeCascadingRisk,
  analyzeTimeoutMissing,
  analyzeRetryWithoutBackoff,
  analyzeUncheckedNullReturn,
  faultTreeToCodeFlow,
  FAULT_RULES,
} from "./fault-tree.js";

// log-cooccurrence.ts — groups log templates that fire together
export { analyzeLogCoOccurrence } from "./log-cooccurrence.js";
export type { LogCoOccurrenceGroup, LogCoOccurrenceResult } from "./log-cooccurrence.js";
