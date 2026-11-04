#!/usr/bin/env node
/** gregmat-mcp entry point. Default: MCP server over stdio. Logs go to stderr only. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./log.js";
import { VERSION, createServer } from "./server.js";

const HELP = `gregmat-mcp ${VERSION} — read-only MCP server for your GregMAT GRE prep progress

Usage:
  gregmat-mcp              Start the MCP server on stdio (what MCP clients run)
  gregmat-mcp --self-test  Authenticate, probe endpoints, print a progress summary
  gregmat-mcp --help       Show this help
  gregmat-mcp --version    Print version

Environment:
  GREGMAT_TOKEN       Access JWT (value of the piniaAccess cookie on gregmat.com)
  GREGMAT_COOKIE      Cookie header string from gregmat.com (piniaAccess is extracted)
  GREGMAT_EMAIL       Email for password login (with GREGMAT_PASSWORD)
  GREGMAT_PASSWORD    Password for password login
  GREGMAT_TEST_DATE   GRE date, YYYY-MM-DD (default 2026-11-21)
  GREGMAT_STUDY_PLAN  Study plan slug (default the-im-overwhelmed-study-plan)
  GREGMAT_MCP_HOME    Data dir for session.json/log.json (default ~/.gregmat-mcp)
  GREGMAT_API_BASE    Override API base URL
  GREGMAT_DEBUG=1     Verbose stderr logging (never prints secrets)
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.includes("--self-test") || args.includes("--check")) {
    const { runSelfTest } = await import("./selftest.js");
    process.exitCode = await runSelfTest();
    return;
  }
  const unknown = args.filter((a) => a.startsWith("-"));
  if (unknown.length) {
    process.stderr.write(`Unknown option(s): ${unknown.join(" ")}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`gregmat-mcp ${VERSION} running on stdio`);
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (e) => log.error(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`));

main().catch((e) => {
  log.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
