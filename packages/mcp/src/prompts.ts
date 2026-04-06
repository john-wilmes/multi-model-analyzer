import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GUIDE_CONTENT } from "./guide-content.js";

export function registerPrompts(server: McpServer): void {
  server.prompt("mma-guide", "Complete orientation for using MMA tools, workflows, and concepts. Read this at the start of a session for best results.", () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: GUIDE_CONTENT,
      },
    }],
  }));
}
