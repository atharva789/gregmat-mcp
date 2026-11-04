/** `gregmat-mcp --login`: interactive browser sign-in; caches the session (mode 600). */
import { AuthManager } from "./auth.js";
import { GregmatClient } from "./api.js";
import { sessionFile } from "./config.js";
import { AuthError } from "./errors.js";
import { fetchProfile } from "./gregmat.js";

export async function runLogin(): Promise<number> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const auth = new AuthManager();
  try {
    await auth.interactiveLogin();
  } catch (e) {
    out(`Login failed: ${(e as Error).message}`);
    if (e instanceof AuthError) for (const a of e.attempts) out(`  - ${a}`);
    return 1;
  }
  out(`Logged in. Session cached at ${sessionFile()} (mode 600).`);
  if (auth.info.tokenExpiresAt) out(`Access token expires: ${auth.info.tokenExpiresAt} (refreshed automatically while the refresh token is valid).`);
  const me = await fetchProfile(new GregmatClient(auth));
  out(me.ok ? "Verified against /authentication/me/." : `Warning: could not verify the session: ${me.error.error}`);
  return me.ok ? 0 : 1;
}
