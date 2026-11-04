#!/usr/bin/env node
/** gregmat-mcp entry point. Default: MCP server over stdio. Logs go to stderr only. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./log.js";
import { VERSION, createServer } from "./server.js";

const HELP = `gregmat-mcp ${VERSION} — read-only MCP server for your GregMAT GRE prep progress

Usage:
  gregmat-mcp              Start the MCP server on stdio (what MCP clients run)
  gregmat-mcp --login      Open a browser, sign in to GregMAT by hand (Google/Apple/email), cache the session
  gregmat-mcp --self-test  Authenticate, probe endpoints, print a progress summary
  gregmat-mcp --help       Show this help
  gregmat-mcp --version    Print version

Auth (first that works): GREGMAT_TOKEN / GREGMAT_COOKIE -> cached session (~/.gregmat-mcp/session.json,
refreshed automatically) -> browser login with GREGMAT_EMAIL + GREGMAT_PASSWORD. GregMAT's login needs a
reCAPTCHA, so login always happens in a real browser window; it needs a display (headless Linux: xvfb-run).

Environment:
  GREGMAT_TOKEN       Access JWT (value of the piniaAccess cookie on gregmat.com)
  GREGMAT_COOKIE      Cookie header string from gregmat.com (piniaAccess is extracted)
  GREGMAT_EMAIL       Email for automatic browser login (with GREGMAT_PASSWORD)
  GREGMAT_PASSWORD    Password for automatic browser login
  GREGMAT_CHROME_PATH Path to a Chrome/Chromium binary for browser login (default: system Chrome, then bundled Chromium)
  GREGMAT_TEST_DATE   GRE date, YYYY-MM-DD (default 2026-11-21)
  GREGMAT_STUDY_PLAN  Parent study plan slug (default the-im-overwhelmed-study-plan)
  GREGMAT_MCP_HOME    Data dir for session.json/log.json (default ~/.gregmat-mcp)
  GREGMAT_API_BASE    Override API base URL
  GREGMAT_CACHE_TTL_MS  /ps/questions cache lifetime in ms (default 300000)
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
  if (args.includes("--login")) {
    const { runLogin } = await import("./login.js");
    process.exitCode = await runLogin();
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
