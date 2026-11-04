/** Pure token helpers (no I/O). Secrets are never logged here. */
import { AUTH } from "./config.js";

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
  return t.replace(/^"+|"+$/g, "").replace(/^Bearer\s+/i, "").trim();
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
