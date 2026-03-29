import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GUIDE_CONTENT } from "./guide-content.js"; // source: guide-content.ts

export function registerGuide(server: McpServer): void {
  server.resource("guide", "mma://guide", {
    description: "Comprehensive guide to MMA tools, workflows, and concepts — read this first when connecting to the MMA MCP server",
  }, async () => ({
    contents: [{
      uri: "mma://guide",
      mimeType: "text/markdown",
      text: GUIDE_CONTENT,
    }],
  }));
}
