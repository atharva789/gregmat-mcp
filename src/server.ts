import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GregmatClient } from "./api.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

export function createServer(client: GregmatClient = new GregmatClient()): McpServer {
  const server = new McpServer(
    { name: "gregmat-mcp", version: VERSION },
    {
      instructions:
        "Read-only access to the user's GregMAT (gregmat.com) GRE prep progress plus a local study log. " +
        "GregMAT response shapes are partly guessed: if a tool returns {error, endpoint, hint}, use raw_get to inspect the endpoint. " +
        "Diagnostics are derived from per-question results, not an official GregMAT diagnostic.",
    },
  );
  registerTools(server, client);
  return server;
}
