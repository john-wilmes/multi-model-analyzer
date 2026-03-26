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

export function registerTools(server: McpServer, stores: Stores): void {
  registerCoreQueryTools(server, stores);
  registerArchitectureTools(server, stores);
  registerDiagnosticsTools(server, stores);
  registerQualityTools(server, stores);
  registerPatternsTools(server, stores);
  registerRepoManagementTools(server, stores);
  registerSymbolTools(server, stores);
}
