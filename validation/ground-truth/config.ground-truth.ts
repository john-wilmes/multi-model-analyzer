import type { FlagAssertion } from "./types.js";

export const CONFIG_GROUND_TRUTH: FlagAssertion[] = [
  // novu-libs — analytics domain
  {
    repo: "novu-libs",
    flagName: "IS_ANALYTICS_PAGE_ENABLED",
    note: "Analytics page feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_ANALYTICS_WORKFLOW_FILTER_ENABLED",
    note: "Analytics workflow filter feature flag",
  },

  // novu-libs — billing domain
  {
    repo: "novu-libs",
    flagName: "IS_BILLING_USAGE_CLICKHOUSE_ENABLED",
    note: "Billing usage ClickHouse storage flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_BILLING_USAGE_CLICKHOUSE_SHADOW_ENABLED",
    note: "Billing usage ClickHouse shadow mode flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_BILLING_USAGE_DETAILED_DIAGNOSTICS_ENABLED",
    note: "Billing usage detailed diagnostics flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_USAGE_ALERTS_ENABLED",
    note: "Usage alerts feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_USAGE_REPORT_ENABLED",
    note: "Usage report feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_USAGE_REPORT_DELAY_ENABLED",
    note: "Usage report delay feature flag",
  },

  // novu-libs — rate limiting domain
  {
    repo: "novu-libs",
    flagName: "IS_API_RATE_LIMITING_ENABLED",
    note: "API rate limiting feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_API_RATE_LIMITING_DRY_RUN_ENABLED",
    note: "API rate limiting dry run flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_API_RATE_LIMITING_KEYLESS_DRY_RUN_ENABLED",
    note: "API rate limiting keyless dry run flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_API_IDEMPOTENCY_ENABLED",
    note: "API idempotency feature flag",
  },

  // novu-libs — webhooks domain
  {
    repo: "novu-libs",
    flagName: "IS_INBOUND_WEBHOOKS_ENABLED",
    note: "Inbound webhooks feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_INBOUND_WEBHOOKS_CONFIGURATION_ENABLED",
    note: "Inbound webhooks configuration flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_OUTBOUND_WEBHOOKS_ENABLED",
    note: "Outbound webhooks feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_WEBHOOKS_MANAGEMENT_ENABLED",
    note: "Webhooks management feature flag",
  },

  // novu-libs — ClickHouse / tracing domain
  {
    repo: "novu-libs",
    flagName: "IS_CLICKHOUSE_BATCHING_ENABLED",
    note: "ClickHouse batching feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_TRACE_LOGS_ENABLED",
    note: "Trace logs write feature flag (also present in novu-api)",
  },
  {
    repo: "novu-libs",
    flagName: "IS_WORKFLOW_RUN_LOGS_READ_ENABLED",
    note: "Workflow run logs read feature flag",
  },
  {
    repo: "novu-libs",
    flagName: "IS_WORKFLOW_RUN_LOGS_WRITE_ENABLED",
    note: "Workflow run logs write feature flag",
  },

  // novu-api — all 4 flags
  {
    repo: "novu-api",
    flagName: "IS_ANALYTICS_LOGS_ENABLED",
    note: "Analytics logs flag — unique to novu-api",
  },
  {
    repo: "novu-api",
    flagName: "IS_EVENT_QUOTA_THROTTLER_ENABLED",
    note: "Event quota throttler flag",
  },
  {
    repo: "novu-api",
    flagName: "IS_TRACE_LOGS_ENABLED",
    note: "Trace logs flag (shared with novu-libs)",
  },
  {
    repo: "novu-api",
    flagName: "IS_TRACE_LOGS_READ_ENABLED",
    note: "Trace logs read flag — unique to novu-api",
  },
];

export const CONFIG_STRUCTURAL = {
  "novu-libs": { minFlags: 20, minFindings: 100 },
  "novu-api": { minFlags: 2, minFindings: 1 },
} as const;
