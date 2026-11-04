/**
 * Auth resolution order:
 *   1. GREGMAT_TOKEN (raw access JWT) / GREGMAT_COOKIE (cookie header; piniaAccess extracted)
 *   2. cached session ~/.gregmat-mcp/session.json (access + refresh; JWT exp check; refresh via refresh token)
 *   3. browser login (Playwright, headed) using GREGMAT_EMAIL / GREGMAT_PASSWORD
 * The login endpoint needs a reCAPTCHA token, so plain-HTTP login is impossible; run
 * `gregmat-mcp --login` once to sign in by hand (Google/Apple work) and cache the session.
 * Secrets are never logged.
 */
import fs from "node:fs";
import path from "node:path";
import { API_BASE, AUTH, REQUEST_TIMEOUT_MS, USER_AGENT, env, sessionFile } from "./config.js";
import { BrowserLoginFn, BrowserTokens, defaultBrowserLogin } from "./browserLogin.js";
import { AuthError } from "./errors.js";
import { log } from "./log.js";
import { cleanToken, extractTokens, isExpired, jwtExpiry, tokenFromCookie } from "./tokens.js";

export { cleanToken, extractTokens, isExpired, jwtExpiry, tokenFromCookie };

export type AuthSource = "env_token" | "env_cookie" | "session_cache" | "session_refresh" | "browser_login";

export interface StoredSession {
  access: string;
  refresh?: string;
  source: AuthSource;
  savedAt: string;
}

export interface AuthInfo {
  source: AuthSource | null;
  attempts: string[];
  tokenExpiresAt?: string | null;
}

type FetchLike = typeof fetch;

export const LOGIN_HELP =
  "Run `gregmat-mcp --login` (opens a browser; Google/Apple sign-in works) to cache a session, or set GREGMAT_TOKEN / GREGMAT_COOKIE, " +
  "or set GREGMAT_EMAIL + GREGMAT_PASSWORD for automatic browser login (needs a display; on headless Linux use xvfb-run).";

export function loadSession(): StoredSession | null {
  const file = sessionFile();
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data.access === "string" ? (data as StoredSession) : null;
  } catch (e) {
    log.warn(`could not read session cache: ${(e as Error).message}`);
    return null;
  }
}

/** Write the session file with mode 0600 (dir 0700). Never called for env-provided tokens. */
export function saveSession(s: StoredSession): void {
  const file = sessionFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (e) {
    log.warn(`could not write session cache: ${(e as Error).message}`);
  }
}

export class AuthManager {
  private access: string | null = null;
  private refreshToken: string | null = null;
  readonly info: AuthInfo = { source: null, attempts: [] };
  private resolving: Promise<string> | null = null;

  constructor(
    private fetchImpl: FetchLike = fetch,
    private browserLogin: BrowserLoginFn = defaultBrowserLogin,
  ) {}

  hasAnyCredentials(): boolean {
    return !!(env("GREGMAT_TOKEN") || env("GREGMAT_COOKIE") || (env("GREGMAT_EMAIL") && env("GREGMAT_PASSWORD")) || fs.existsSync(sessionFile()));
  }

  /** Return a usable access token, resolving auth on first call. */
  async getToken(): Promise<string> {
    if (this.access && !isExpired(this.access)) return this.access;
    if (this.refreshToken) {
      const r = await this.tryRefresh();
      if (r) return r;
    }
    if (!this.resolving) {
      this.resolving = this.resolve().finally(() => {
        this.resolving = null;
      });
    }
    return this.resolving;
  }

  /** Called by the API client after a 401. Returns a new token or null. */
  async handleUnauthorized(): Promise<string | null> {
    this.info.attempts.push(`401 with ${this.info.source ?? "unknown"} token`);
    if (this.refreshToken) {
      const r = await this.tryRefresh();
      if (r) return r;
    }
    const email = env("GREGMAT_EMAIL");
    const password = env("GREGMAT_PASSWORD");
    if (email && password && this.info.source !== "browser_login") {
      try {
        return await this.runBrowserLogin({ email, password });
      } catch (e) {
        log.warn(`re-login failed: ${(e as Error).message}`);
      }
    }
    this.access = null;
    return null;
  }

  /** Interactive login for the `--login` CLI: user signs in by hand, session is cached. */
  async interactiveLogin(): Promise<string> {
    return this.runBrowserLogin({ manual: true });
  }

  private async resolve(): Promise<string> {
    const attempts = this.info.attempts;
    attempts.length = 0;

    const envToken = env("GREGMAT_TOKEN");
    if (envToken) {
      const t = cleanToken(envToken);
      if (isExpired(t)) attempts.push("GREGMAT_TOKEN: expired (JWT exp in the past)");
      else return this.use(t, undefined, "env_token");
    }
    const envCookie = env("GREGMAT_COOKIE");
    if (envCookie) {
      const t = tokenFromCookie(envCookie);
      if (!t) attempts.push(`GREGMAT_COOKIE: no ${AUTH.cookieName} cookie found`);
      else if (isExpired(t)) attempts.push("GREGMAT_COOKIE: piniaAccess token expired");
      else return this.use(t, undefined, "env_cookie");
    }

    const cached = loadSession();
    if (cached) {
      if (cached.access && !isExpired(cached.access)) return this.use(cached.access, cached.refresh, "session_cache");
      attempts.push("session cache: access token expired");
      if (cached.refresh && !isExpired(cached.refresh, 0)) {
        const refreshed = await this.refreshWith(cached.refresh);
        if (refreshed) {
          const tok = this.use(refreshed.access, refreshed.refresh ?? cached.refresh, "session_refresh");
          this.persist();
          return tok;
        }
        attempts.push("session cache: refresh failed");
      } else if (cached.refresh) {
        attempts.push("session cache: refresh token expired");
      }
    } else {
      attempts.push("session cache: none");
    }

    const email = env("GREGMAT_EMAIL");
    const password = env("GREGMAT_PASSWORD");
    if (email && password) return this.runBrowserLogin({ email, password });
    attempts.push("GREGMAT_EMAIL/GREGMAT_PASSWORD: not set");
    throw new AuthError(`No valid GregMAT credentials. ${LOGIN_HELP}`, [...attempts]);
  }

  private async runBrowserLogin(opts: { manual?: boolean; email?: string; password?: string }): Promise<string> {
    let t: BrowserTokens;
    try {
      t = await this.browserLogin(opts);
    } catch (e) {
      const msg = e instanceof AuthError ? e.message : `browser login failed: ${(e as Error).message}`;
      this.info.attempts.push(`browser login: ${msg}`);
      throw e instanceof AuthError ? new AuthError(e.message, [...this.info.attempts]) : new AuthError(msg, [...this.info.attempts]);
    }
    this.info.attempts.push("browser login: OK");
    const tok = this.use(t.access, t.refresh, "browser_login");
    this.persist();
    return tok;
  }

  private use(access: string, refresh: string | undefined, source: AuthSource): string {
    this.access = access;
    this.refreshToken = refresh ?? null;
    this.info.source = source;
    const exp = jwtExpiry(access);
    this.info.tokenExpiresAt = exp ? exp.toISOString() : null;
    log.debug(`auth via ${source}`);
    return access;
  }

  private async tryRefresh(): Promise<string | null> {
    if (!this.refreshToken) return null;
    const r = await this.refreshWith(this.refreshToken);
    if (!r) return null;
    const tok = this.use(r.access, r.refresh ?? this.refreshToken, "session_refresh");
    this.persist();
    return tok;
  }

  private async refreshWith(refresh: string): Promise<{ access: string; refresh?: string } | null> {
    try {
      const res = await this.fetchImpl(API_BASE + AUTH.refreshPath.path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ refresh }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const { access, refresh: newRefresh } = extractTokens(await res.json().catch(() => null));
      return access ? { access, refresh: newRefresh } : null;
    } catch (e) {
      log.debug(`refresh failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Persist browser-login/refresh sessions only (env tokens are never written to disk). */
  private persist(): void {
    if (!this.access || this.info.source === "env_token" || this.info.source === "env_cookie") return;
    saveSession({
      access: this.access,
      refresh: this.refreshToken ?? undefined,
      source: this.info.source ?? "browser_login",
      savedAt: new Date().toISOString(),
    });
  }
}
