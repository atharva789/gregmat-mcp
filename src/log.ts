/** stderr-only logger (stdout is reserved for the MCP protocol). Never pass secrets here. */
const DEBUG = !!process.env.GREGMAT_DEBUG && process.env.GREGMAT_DEBUG !== "0";

function write(level: string, msg: string): void {
  process.stderr.write(`[gregmat-mcp] ${level}: ${msg}\n`);
}

export const log = {
  info: (msg: string) => write("info", msg),
  warn: (msg: string) => write("warn", msg),
  error: (msg: string) => write("error", msg),
  debug: (msg: string) => {
    if (DEBUG) write("debug", msg);
  },
};

/** Mask a secret for display: keeps only a short prefix. */
export function mask(secret: string | undefined): string {
  if (!secret) return "(none)";
  return secret.length <= 8 ? "****" : `${secret.slice(0, 4)}…(${secret.length} chars)`;
}
