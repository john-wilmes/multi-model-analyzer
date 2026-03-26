/**
 * Dashboard HTTP server: request dispatcher and server lifecycle.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KVStore, GraphStore } from "@mma/storage";
import { parseQuery, sendError, serveStatic, getAllowedOrigin } from "./http-utils.js";
import {
  handleRepos,
  handleMetricsSummary,
  handleMetricsAll,
  handleMetricsRepo,
} from "./routes/metrics.js";
import { handleDsm, handleGraph, handleDependencies } from "./routes/graph.js";
import {
  handleFindings,
  handlePractices,
  handlePatterns,
  handleHotspots,
  handleTemporalCouplingAll,
  handleTemporalCouplingRepo,
  handleAtdiSystem,
  handleAtdiRepo,
  handleDebtSystem,
  handleDebtRepo,
  handleBlastRadius,
  handleRepoStates,
} from "./routes/analysis.js";
import {
  handleCrossRepoGraph,
  handleCrossRepoImpact,
  handleCrossRepoFeatures,
  handleCrossRepoFaults,
  handleCrossRepoCatalog,
} from "./routes/cross-repo.js";

export interface DashboardOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly port: number;
  readonly host: string;
  readonly staticDir: string;
  /** Explicit origins allowed for CORS. Empty set = no CORS headers (localhost-only default). */
  readonly corsOrigins?: ReadonlySet<string>;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  graphStore: GraphStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0]!;
  const query = parseQuery(url);

  if (path === "/api/repos") return handleRepos(req, res, kvStore, corsOrigin);
  if (path === "/api/metrics-summary") return handleMetricsSummary(req, res, kvStore, corsOrigin);
  if (path === "/api/metrics-all") return handleMetricsAll(req, res, kvStore, query, corsOrigin);

  const dsmMatch = path.match(/^\/api\/dsm\/(.+)$/);
  if (dsmMatch) return handleDsm(req, res, graphStore, decodeURIComponent(dsmMatch[1]!), query, corsOrigin);

  const metricsMatch = path.match(/^\/api\/metrics\/(.+)$/);
  if (metricsMatch) return handleMetricsRepo(req, res, kvStore, decodeURIComponent(metricsMatch[1]!), corsOrigin);

  if (path === "/api/findings" || path.startsWith("/api/findings/")) return handleFindings(req, res, kvStore, path, query, corsOrigin);

  const graphMatch = path.match(/^\/api\/graph\/(.+)$/);
  if (graphMatch) return handleGraph(req, res, graphStore, decodeURIComponent(graphMatch[1]!), query, corsOrigin);

  const depsMatch = path.match(/^\/api\/dependencies\/(.+)$/);
  if (depsMatch) return handleDependencies(req, res, kvStore, graphStore, decodeURIComponent(depsMatch[1]!), query, corsOrigin);

  if (path === "/api/practices") return handlePractices(req, res, kvStore, corsOrigin);

  const patternsMatch = path.match(/^\/api\/patterns\/(.+)$/);
  if (patternsMatch) return handlePatterns(req, res, kvStore, decodeURIComponent(patternsMatch[1]!), corsOrigin);

  if (path === "/api/hotspots") return handleHotspots(req, res, kvStore, query, corsOrigin);

  if (path === "/api/temporal-coupling") return handleTemporalCouplingAll(req, res, kvStore, corsOrigin);

  const tcRepoMatch = path.match(/^\/api\/temporal-coupling\/(.+)$/);
  if (tcRepoMatch) return handleTemporalCouplingRepo(req, res, kvStore, decodeURIComponent(tcRepoMatch[1]!), corsOrigin);

  if (path === "/api/atdi") return handleAtdiSystem(req, res, kvStore, corsOrigin);

  const atdiMatch = path.match(/^\/api\/atdi\/(.+)$/);
  if (atdiMatch) return handleAtdiRepo(req, res, kvStore, decodeURIComponent(atdiMatch[1]!), corsOrigin);

  if (path === "/api/debt") return handleDebtSystem(req, res, kvStore, corsOrigin);

  const debtMatch = path.match(/^\/api\/debt\/(.+)$/);
  if (debtMatch) return handleDebtRepo(req, res, kvStore, decodeURIComponent(debtMatch[1]!), corsOrigin);

  if (path === "/api/cross-repo-graph") return handleCrossRepoGraph(req, res, kvStore, query, corsOrigin);

  if (path === "/api/cross-repo-impact" && req.method === "POST") return handleCrossRepoImpact(req, res, kvStore, graphStore, corsOrigin);

  if (path === "/api/cross-repo-features") return handleCrossRepoFeatures(req, res, kvStore, query, corsOrigin);

  if (path === "/api/cross-repo-faults") return handleCrossRepoFaults(req, res, kvStore, query, corsOrigin);

  if (path === "/api/cross-repo-catalog") return handleCrossRepoCatalog(req, res, kvStore, query, corsOrigin);

  if (path === "/api/repo-states") return handleRepoStates(req, res, kvStore, query, corsOrigin);

  const blastMatch = path.match(/^\/api\/blast-radius\/(.+)$/);
  if (blastMatch) return handleBlastRadius(req, res, kvStore, graphStore, decodeURIComponent(blastMatch[1]!), query, corsOrigin);

  return sendError(res, "Not found", 404, corsOrigin);
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const { kvStore, graphStore, port, staticDir } = options;
  const corsOrigins = options.corsOrigins ?? new Set<string>();

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = req.url ?? "/";
      const path = url.split("?")[0]!;
      const corsOrigin = getAllowedOrigin(req, corsOrigins);

      if (req.method === "OPTIONS") {
        const headers: Record<string, string | number> = { Allow: "GET, POST, OPTIONS" };
        if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
        res.writeHead(204, headers);
        res.end();
        return;
      }

      if (path.startsWith("/api/")) {
        handleApi(req, res, kvStore, graphStore, corsOrigin).catch((err: unknown) => {
          if (!res.headersSent) {
            sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
          }
        });
      } else {
        serveStatic(req, res, staticDir).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(port, options.host, () => resolve());
    server.once("error", reject);
  });

  const browseHost = options.host === "0.0.0.0" ? "localhost" : options.host;
  const url = `http://${browseHost}:${port}`;
  console.log(`Dashboard running at ${url}${options.host === "0.0.0.0" ? " (listening on all interfaces)" : ""}`);

  // Auto-open browser (best-effort, platform-aware, no shell interpolation)
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", url], { stdio: "ignore" })
      .on("error", () => { /* ignore – browser open is best-effort */ })
      .unref();
  } else {
    const binary = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(binary, [url], { stdio: "ignore" })
      .on("error", () => { /* ignore – browser open is best-effort */ })
      .unref();
  }

  // Clean shutdown on SIGINT / SIGTERM
  const shutdown = (): void => {
    console.log("\nShutting down dashboard…");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Keep the process alive
  await new Promise<never>(() => { /* runs until signal */ });
}
