/**
 * `mma compress` — Gzip the analysis database.
 * `mma dashboard` — Serve a local web dashboard over the analysis database.
 *
 * Modules (in apps/cli/src/commands/dashboard/):
 *   compress.ts     — compressCommand, maybeDecompress
 *   http-utils.ts   — parseQuery, sendJson, sendError, readBody, getAllowedOrigin, serveStatic, cache
 *   server.ts       — dashboardCommand, handleApi, DashboardOptions
 *   routes/metrics.ts     — /api/repos, /api/metrics-summary, /api/metrics-all, /api/metrics/:repo
 *   routes/graph.ts       — /api/dsm/:repo, /api/graph/:repo, /api/dependencies/:repo
 *   routes/analysis.ts    — /api/findings, /api/practices, /api/patterns, /api/hotspots,
 *                           /api/temporal-coupling, /api/atdi, /api/debt, /api/blast-radius
 *   routes/cross-repo.ts  — /api/cross-repo-graph, /api/cross-repo-impact,
 *                           /api/cross-repo-features, /api/cross-repo-faults,
 *                           /api/cross-repo-catalog, /api/repo-states
 */

export { compressCommand, maybeDecompress } from "./dashboard/compress.js";
export { dashboardCommand, handleApi } from "./dashboard/server.js";
export type { DashboardOptions } from "./dashboard/server.js";
