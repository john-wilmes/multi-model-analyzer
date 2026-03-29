import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export type { IndexRepoResult, Stores, ContentItem, ToolResult } from "./tools/helpers.js";
import type { Stores } from "./tools/helpers.js";
// Tool group modules (sources: coreQueryTools.ts, architectureTools.ts, diagnosticsTools.ts,
// qualityTools.ts, patternsTools.ts, repoManagementTools.ts, symbolTools.ts)
import { registerCoreQueryTools } from "./tools/coreQueryTools.js";
import { registerArchitectureTools } from "./tools/architectureTools.js";
import { registerDiagnosticsTools } from "./tools/diagnosticsTools.js";
import { registerQualityTools } from "./tools/qualityTools.js";
import { registerPatternsTools } from "./tools/patternsTools.js";
import { registerRepoManagementTools } from "./tools/repoManagementTools.js";
import { registerSymbolTools } from "./tools/symbolTools.js";

/** Orientation blurb prepended to the first tool response in a session (stdio only). */
export const WELCOME_BLURB = [
  "[MMA] You are connected to the Multi-Model Analyzer with 31 tools across 5 categories.",
  "Quick start: 'search' finds symbols → 'get_callers'/'get_callees' traces the graph → 'get_blast_radius' shows impact.",
  "Responses include a _hints field with contextual next-step suggestions when available.",
  "For the full guide, use the 'mma-guide' prompt or read the mma://guide resource.",
].join("\n");

export interface RegisterToolsOptions {
  /** When true, prepend a one-time orientation blurb to the first tool response. */
  readonly welcomeOnFirstCall?: boolean;
}

export function registerTools(server: McpServer, stores: Stores, opts?: RegisterToolsOptions): void {
  registerCoreQueryTools(server, stores);
  registerArchitectureTools(server, stores);
  registerDiagnosticsTools(server, stores);
  registerQualityTools(server, stores);
  registerPatternsTools(server, stores);
  registerRepoManagementTools(server, stores);
  registerSymbolTools(server, stores);

  if (opts?.welcomeOnFirstCall) {
    installWelcomeMiddleware(server);
  }
}

/**
 * Wraps the server's tool handler to prepend the welcome blurb on the first call.
 * Uses the MCP SDK's `server.server` (low-level Server) to intercept responses.
 */
function installWelcomeMiddleware(server: McpServer): void {
  let welcomed = false;
  // Access the low-level Server to intercept tool call responses
  const lowLevel = (server as unknown as { server: { setRequestHandler: (schema: unknown, handler: (req: unknown) => Promise<unknown>) => void; _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> } }).server;
  const originalHandler = lowLevel._requestHandlers.get("tools/call");
  if (!originalHandler) return;

  lowLevel._requestHandlers.set("tools/call", async (req: unknown) => {
    const result = await originalHandler(req) as { content?: Array<{ type: string; text?: string }> };
    if (!welcomed && result?.content) {
      welcomed = true;
      result.content.unshift({ type: "text", text: WELCOME_BLURB });
    }
    return result;
  });
}
