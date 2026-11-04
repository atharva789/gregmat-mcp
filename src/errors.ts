export interface ToolError {
  error: string;
  endpoint?: string;
  status?: number | null;
  hint: string;
  [k: string]: unknown;
}

export const CONFIG_HINT = "edit src/config.ts";

/** Error raised by the HTTP client for a specific GregMAT endpoint. */
export class ApiError extends Error {
  constructor(
    message: string,
    public endpoint: string,
    public status: number | null,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Raised when no usable credentials are available or login fails. */
export class AuthError extends Error {
  constructor(message: string, public attempts: string[] = []) {
    super(message);
    this.name = "AuthError";
  }
}

export function toToolError(err: unknown, endpoint?: string): ToolError {
  if (err instanceof AuthError) {
    return {
      error: `auth_failed: ${err.message}`,
      endpoint: endpoint ?? "/authentication/me/",
      status: null,
      hint:
        "Set GREGMAT_TOKEN (piniaAccess cookie value), GREGMAT_COOKIE, or GREGMAT_EMAIL + GREGMAT_PASSWORD in the MCP server env, then run `npm run check`. If auth endpoints changed, edit src/config.ts",
      attempts: err.attempts,
    };
  }
  if (err instanceof ApiError) {
    return {
      error: err.message,
      endpoint: err.endpoint,
      status: err.status,
      hint:
        err.status === 404 || err.status === 405
          ? `Endpoint path probably wrong — ${CONFIG_HINT}`
          : err.status === 401 || err.status === 403
            ? "Token rejected/expired — refresh credentials, or " + CONFIG_HINT
            : CONFIG_HINT,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: message, endpoint, status: null, hint: CONFIG_HINT };
}
