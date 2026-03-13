import type { FaultAssertion } from "./types.js";

/**
 * Fault assertions validate that SARIF findings for rule "fault/unhandled-error-path"
 * exist for specific files. Each assertion's `signature` field is matched as a
 * case-sensitive substring against the SARIF message text, which has the form:
 *   "Catch block in <filepath>#<funcname> has no logging or re-throw"
 *
 * The `kind` field here is informational metadata; validation tests check structural
 * properties (finding counts, tree shapes) rather than kind matching, since the SARIF
 * rule is always "fault/unhandled-error-path".
 */
export const FAULT_GROUND_TRUTH: FaultAssertion[] = [
  // novu-libs — all 7 findings are in packages/application-generic
  {
    repo: "novu-libs",
    kind: "throw",
    signature: "packages/application-generic/src/decorators/retry-on-error-decorator.ts",
    note: "Retry decorator catch block has no logging or re-throw",
  },
  {
    repo: "novu-libs",
    kind: "throw",
    signature: "packages/application-generic/src/services/cron/cron.service.ts",
    note: "Cron service has multiple unhandled catch blocks",
  },
  {
    repo: "novu-libs",
    kind: "throw",
    signature: "packages/application-generic/src/services/analytic-logs/clickhouse-batch.service.ts",
    note: "ClickHouse batch flush catch block has no logging or re-throw",
  },
  {
    repo: "novu-libs",
    kind: "throw",
    signature: "packages/application-generic/src/services/socket-worker/socket-worker.service.ts",
    note: "Socket worker sendMessageInternal catch block has no logging or re-throw",
  },

  // novu-api — 3 findings: e2e setup and migrations
  {
    repo: "novu-api",
    kind: "throw",
    signature: "e2e/setup.ts",
    note: "E2E setup helper has unhandled catch blocks",
  },
  {
    repo: "novu-api",
    kind: "throw",
    signature: "migrations/layout-identifier-update/add-layout-identifier-migration.ts",
    note: "Layout identifier migration catch block has no logging or re-throw",
  },

  // novu-worker — 16 findings across e2e and src/app/workflow
  {
    repo: "novu-worker",
    kind: "throw",
    signature: "e2e/setup.ts",
    note: "Worker E2E setup has unhandled catch block",
  },
  {
    repo: "novu-worker",
    kind: "throw",
    signature: "src/app/workflow/services/active-jobs-metric.service.ts",
    note: "Active jobs metric service has unhandled catch block",
  },
  {
    repo: "novu-worker",
    kind: "throw",
    signature: "src/app/workflow/usecases/add-job/add-job.usecase.ts",
    note: "Add-job usecase has unhandled catch blocks",
  },
  {
    repo: "novu-worker",
    kind: "throw",
    signature: "src/app/workflow/usecases/send-message/send-message-push.usecase.ts",
    note: "Push send-message usecase has unhandled catch block",
  },
  {
    repo: "novu-worker",
    kind: "throw",
    signature: "src/app/workflow/usecases/send-message/send-message-chat.usecase.ts",
    note: "Chat send-message usecase has multiple unhandled catch blocks",
  },
  {
    repo: "novu-worker",
    kind: "throw",
    signature: "src/app/workflow/usecases/run-job/run-job.usecase.ts",
    note: "Run-job usecase has unhandled catch blocks",
  },

  // novu-dashboard — 14 findings in src/
  {
    repo: "novu-dashboard",
    kind: "throw",
    signature: "src/components/variable/utils/process-filters.ts",
    note: "Filter processing catch block has no logging or re-throw",
  },
  {
    repo: "novu-dashboard",
    kind: "throw",
    signature: "src/utils/better-auth/components/organization-create.tsx",
    note: "Organization create form submit has unhandled catch block",
  },
  {
    repo: "novu-dashboard",
    kind: "throw",
    signature: "src/utils/better-auth/index.tsx",
    note: "Better-auth session refresh has unhandled catch block",
  },
  {
    repo: "novu-dashboard",
    kind: "throw",
    signature: "src/components/workflow-editor/workflow-tabs.tsx",
    note: "Workflow editor tabs have multiple unhandled catch blocks",
  },
  {
    repo: "novu-dashboard",
    kind: "throw",
    signature: "src/hooks/use-create-translation-key.ts",
    note: "Create translation key hook has unhandled catch block",
  },
  {
    repo: "novu-dashboard",
    kind: "throw",
    signature: "src/utils/segment.ts",
    note: "Segment analytics constructor has unhandled catch block",
  },
];

export const FAULT_STRUCTURAL = {
  "novu-libs": { minFaultFindings: 3, minFaultTrees: 20 },
  "novu-api": { minFaultFindings: 1, minFaultTrees: 20 },
  "novu-worker": { minFaultFindings: 5, minFaultTrees: 10 },
  "novu-dashboard": { minFaultFindings: 5, minFaultTrees: 20 },
} as const;

export const VALID_FAULT_TREE_KINDS = [
  "top-event",
  "undeveloped",
  "basic-event",
  "or-gate",
] as const;
