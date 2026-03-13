import type { ServiceAssertion } from "./types.js";

/**
 * Functional assertions validate that `docs:functional:<repo>` markdown contains
 * service name substrings. Matching is case-insensitive substring search against
 * the full markdown document text. Service names appear as `## <name>` headings.
 */
export const FUNCTIONAL_GROUND_TRUTH: ServiceAssertion[] = [
  // novu-libs — 16 assertions (33 services total, picking representative cross-section)
  {
    repo: "novu-libs",
    serviceNameSubstring: "application-generic",
    note: "Core application-generic package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/dal",
    note: "Data access layer package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/framework",
    note: "Framework SDK package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/shared",
    note: "Shared utilities package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/stateless",
    note: "Stateless package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/providers",
    note: "Notification providers package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/react",
    note: "React SDK package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/js",
    note: "JavaScript SDK package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/notifications",
    note: "Notifications package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "maily-core",
    note: "Maily core email editor package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/testing",
    note: "Testing utilities package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "api-examples",
    note: "API examples package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "@novu/api",
    note: "API client package service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "express",
    note: "Express framework integration service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "next",
    note: "Next.js integration service catalog entry",
  },
  {
    repo: "novu-libs",
    serviceNameSubstring: "remix",
    note: "Remix framework integration service catalog entry",
  },

  // novu-api — 4 assertions (1 service total)
  {
    repo: "novu-api",
    serviceNameSubstring: "api-service",
    note: "Primary API service catalog entry",
  },
  {
    repo: "novu-api",
    serviceNameSubstring: "@novu/api",
    note: "API package name appears in documentation",
  },
  {
    repo: "novu-api",
    serviceNameSubstring: "novu/api-service",
    note: "Full scoped package name appears in documentation",
  },
  {
    repo: "novu-api",
    serviceNameSubstring: "service",
    note: "Generic service reference in API documentation",
  },

  // novu-worker — 2 assertions (1 service total)
  {
    repo: "novu-worker",
    serviceNameSubstring: "@novu/worker",
    note: "Worker service catalog entry",
  },
  {
    repo: "novu-worker",
    serviceNameSubstring: "worker",
    note: "Worker reference in documentation",
  },

  // novu-dashboard — 2 assertions (2 services total)
  {
    repo: "novu-dashboard",
    serviceNameSubstring: "@novu/dashboard",
    note: "Dashboard service catalog entry",
  },
  {
    repo: "novu-dashboard",
    serviceNameSubstring: "dashboard",
    note: "Dashboard reference in documentation",
  },
];

export const FUNCTIONAL_STRUCTURAL = {
  "novu-libs": { minServices: 8, minDocChars: 10000 },
  "novu-api": { minServices: 1, minDocChars: 100 },
  "novu-worker": { minServices: 1, minDocChars: 100 },
  "novu-dashboard": { minServices: 1, minDocChars: 100 },
} as const;
