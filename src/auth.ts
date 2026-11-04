/**
 * Auth resolution order:
 *   1. GREGMAT_TOKEN (raw access JWT) / GREGMAT_COOKIE (cookie header; piniaAccess extracted)
 *   2. cached session ~/.gregmat-mcp/session.json (refresh via refresh token, check via /authentication/me/)
 *   3. GREGMAT_EMAIL / GREGMAT_PASSWORD login (body variants from config)
 * Secrets are never logged.
 */
import fs from "node:fs";
import path from "node:path";
import { API_BASE, AUTH, REQUEST_TIMEOUT_MS, USER_AGENT, env, sessionFile } from "./config.js";
import { AuthError } from "./errors.js";
import { log } from "./log.js";

export type AuthSource = "env_token" | "env_cookie" | "session_cache" | "session_refresh" | "login";

export interface StoredSession {
  access: string;
  refresh?: string;
  source: AuthSource;
  loginVariant?: string;
  savedAt: string;
}

export interface AuthInfo {
  source: AuthSource | null;
  loginVariant?: string;
  attempts: string[];
  tokenExpiresAt?: string | null;
}

type FetchLike = typeof fetch;

/** Decode the `exp` claim of a JWT without verifying it. */
export function jwtExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

export function isExpired(token: string, skewSeconds = 30): boolean {
  const exp = jwtExpiry(token);
  return exp !== null && exp.getTime() - skewSeconds * 1000 <= Date.now();
}

/** Normalise a token pasted by a user: strip quotes, "Bearer ", URL-encoding. */
export function cleanToken(raw: string): string {
  let t = raw.trim();
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep as-is */
  }
  t = t.replace(/^"+|"+$/g, "").replace(/^Bearer\s+/i, "").trim();
  return t;
}

/** Extract the piniaAccess value from a Cookie header string. */
export function tokenFromCookie(cookieHeader: string, name: string = AUTH.cookieName): string | null {
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      const v = cleanToken(part.slice(idx + 1));
      return v || null;
    }
  }
  // Allow pasting the bare value too.
  if (!cookieHeader.includes("=") && cookieHeader.split(".").length === 3) return cleanToken(cookieHeader);
  return null;
}

/** Find an access/refresh token in a login/refresh response defensively. */
export function extractTokens(body: unknown): { access?: string; refresh?: string } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  let access = str(b[AUTH.accessTokenField]) ?? str(b.access_token) ?? str(b.token) ?? str(b.key);
  let refresh = str(b[AUTH.refreshTokenField]) ?? str(b.refresh_token);
  for (const nestKey of ["token", "tokens", "data"]) {
    const nested = b[nestKey];
    if (nested && typeof nested === "object") {
      const inner = extractTokens(nested);
      access = access ?? inner.access;
      refresh = refresh ?? inner.refresh;
    }
  }
  return { access, refresh };
}

export class AuthManager {
  private access: string | null = null;
  private refreshToken: string | null = null;
  readonly info: AuthInfo = { source: null, attempts: [] };
  private resolving: Promise<string> | null = null;

  constructor(private fetchImpl: FetchLike = fetch) {}

  hasAnyCredentials(): boolean {
    return !!(
      env("GREGMAT_TOKEN") ||
      env("GREGMAT_COOKIE") ||
      (env("GREGMAT_EMAIL") && env("GREGMAT_PASSWORD")) ||
      fs.existsSync(sessionFile())
    );
  }

  /** Return a usable access token, resolving auth on first call. */
  async getToken(): Promise<string> {
    if (this.access && !isExpired(this.access)) return this.access;
    if (this.access && this.refreshToken) {
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
    if (email && password && this.info.source !== "login") {
      try {
        return await this.login(email, password);
      } catch (e) {
        log.warn(`re-login failed: ${(e as Error).message}`);
      }
    }
    this.access = null;
    return null;
  }

  private async resolve(): Promise<string> {
    const attempts = this.info.attempts;
    attempts.length = 0;

    // 1a. Raw token from env.
    const envToken = env("GREGMAT_TOKEN");
    if (envToken) {
      const t = cleanToken(envToken);
      if (isExpired(t)) {
        attempts.push("GREGMAT_TOKEN: expired (JWT exp in the past)");
      } else {
        return this.use(t, undefined, "env_token");
      }
    }
    // 1b. Cookie header from env.
    const envCookie = env("GREGMAT_COOKIE");
    if (envCookie) {
      const t = tokenFromCookie(envCookie);
      if (!t) attempts.push(`GREGMAT_COOKIE: no ${AUTH.cookieName} cookie found`);
      else if (isExpired(t)) attempts.push("GREGMAT_COOKIE: piniaAccess token expired");
      else return this.use(t, undefined, "env_cookie");
    }

    // 2. Cached session.
    const cached = this.loadSession();
    if (cached) {
      if (cached.access && !isExpired(cached.access) && (await this.checkMe(cached.access))) {
        return this.use(cached.access, cached.refresh, "session_cache", cached.loginVariant);
      }
      attempts.push("session cache: access token expired or rejected");
      if (cached.refresh) {
        const refreshed = await this.refreshWith(cached.refresh);
        if (refreshed && (await this.checkMe(refreshed.access))) {
          const tok = this.use(refreshed.access, refreshed.refresh ?? cached.refresh, "session_refresh", cached.loginVariant);
          this.saveSession();
          return tok;
        }
        attempts.push("session cache: refresh failed");
      }
    } else {
      attempts.push("session cache: none");
    }

    // 3. Email/password login.
    const email = env("GREGMAT_EMAIL");
    const password = env("GREGMAT_PASSWORD");
    if (email && password) {
      return this.login(email, password);
    }
    attempts.push("GREGMAT_EMAIL/GREGMAT_PASSWORD: not set");
    throw new AuthError(
      "No valid GregMAT credentials. Set GREGMAT_TOKEN, GREGMAT_COOKIE, or GREGMAT_EMAIL + GREGMAT_PASSWORD.",
      [...attempts],
    );
  }

  private use(access: string, refresh: string | undefined, source: AuthSource, variant?: string): string {
    this.access = access;
    this.refreshToken = refresh ?? null;
    this.info.source = source;
    this.info.loginVariant = variant;
    const exp = jwtExpiry(access);
    this.info.tokenExpiresAt = exp ? exp.toISOString() : null;
    log.debug(`auth via ${source}${variant ? ` (variant ${variant})` : ""}`);
    return access;
  }

  async login(email: string, password: string): Promise<string> {
    const url = API_BASE + AUTH.loginPath.path;
    const errors: string[] = [];
    for (const variant of AUTH.loginBodyVariants) {
      try {
        const res = await this.post(url, variant.build(email, password));
        const body = await safeJson(res);
        const { access, refresh } = extractTokens(body);
        if (res.ok && access) {
          this.info.attempts.push(`login variant "${variant.name}": OK`);
          const tok = this.use(access, refresh, "login", variant.name);
          this.saveSession();
          return tok;
        }
        const msg = `login variant "${variant.name}": HTTP ${res.status}${access ? "" : " (no access token in response)"}`;
        errors.push(msg);
        this.info.attempts.push(msg);
      } catch (e) {
        const msg = `login variant "${variant.name}": ${(e as Error).message}`;
        errors.push(msg);
        this.info.attempts.push(msg);
      }
    }
    throw new AuthError(`Login failed (${errors.join("; ")})`, [...this.info.attempts]);
  }

  private async tryRefresh(): Promise<string | null> {
    if (!this.refreshToken) return null;
    const r = await this.refreshWith(this.refreshToken);
    if (!r) return null;
    const tok = this.use(r.access, r.refresh ?? this.refreshToken, "session_refresh", this.info.loginVariant);
    this.saveSession();
    return tok;
  }

  private async refreshWith(refresh: string): Promise<{ access: string; refresh?: string } | null> {
    try {
      const res = await this.post(API_BASE + AUTH.refreshPath.path, { refresh });
      if (!res.ok) return null;
      const { access, refresh: newRefresh } = extractTokens(await safeJson(res));
      return access ? { access, refresh: newRefresh } : null;
    } catch (e) {
      log.debug(`refresh failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async checkMe(access: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(API_BASE + AUTH.mePath.path, {
        headers: { Authorization: `Bearer ${access}`, Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private post(url: string, body: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private loadSession(): StoredSession | null {
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

  /** Persist login-derived sessions only (env tokens are never written to disk). */
  private saveSession(): void {
    if (!this.access || this.info.source === "env_token" || this.info.source === "env_cookie") return;
    const file = sessionFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const data: StoredSession = {
        access: this.access,
        refresh: this.refreshToken ?? undefined,
        source: this.info.source ?? "login",
        loginVariant: this.info.loginVariant,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch (e) {
      log.warn(`could not write session cache: ${(e as Error).message}`);
    }
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
