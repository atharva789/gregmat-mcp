/** `npm run check`: authenticate, probe every configured endpoint, print a progress summary. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GregmatClient, endpointPath } from "./api.js";
import { API_BASE, ENDPOINTS, EndpointDef, EndpointKey, defaultStudyPlan, env, homeDir, testDate } from "./config.js";
import { LOGIN_HELP } from "./auth.js";
import { ApiError, AuthError } from "./errors.js";
import { findArray, isObj } from "./normalize.js";
import { createServer } from "./server.js";

const out = (s = "") => process.stdout.write(s + "\n");

function shapeMatches(expect: EndpointDef["expect"], data: unknown): boolean {
  switch (expect) {
    case "object":
      return isObj(data);
    case "list":
      return Array.isArray(data) || (isObj(data) && Array.isArray(data.results));
    case "paginated":
      return isObj(data) && Array.isArray(data.results);
    default:
      return data !== null && data !== undefined;
  }
}

export async function runSelfTest(): Promise<number> {
  out("gregmat-mcp self-test");
  out(`  API base:      ${API_BASE}`);
  out(`  data dir:      ${homeDir()}`);
  out(`  test date:     ${testDate()}`);
  out(`  study plan:    ${defaultStudyPlan()}`);
  const set = ["GREGMAT_TOKEN", "GREGMAT_COOKIE", "GREGMAT_EMAIL", "GREGMAT_PASSWORD"].filter((k) => env(k));
  out(`  creds in env:  ${set.length ? set.join(", ") : "(none)"}`);
  out();

  const client = new GregmatClient();
  out("== Auth ==");
  try {
    await client.auth.getToken();
  } catch (e) {
    out(`  FAILED: ${(e as Error).message}`);
    if (e instanceof AuthError) for (const a of e.attempts) out(`    - ${a}`);
    out(`  Fix: ${LOGIN_HELP}`);
    return 1;
  }
  const info = client.auth.info;
  out(`  OK via ${info.source}`);
  if (info.tokenExpiresAt) out(`  token expires: ${info.tokenExpiresAt}`);
  for (const a of info.attempts) out(`    - ${a}`);
  try {
    await client.getEndpoint("me");
  } catch (e) {
    out(`  /authentication/me/ rejected the token: ${(e as Error).message}`);
    return 1;
  }
  out();

  out("== Endpoints ==");
  const needsUpdate: string[] = [];
  for (const [key, def] of Object.entries(ENDPOINTS) as [EndpointKey, EndpointDef][]) {
    let p: string;
    try {
      p = endpointPath(key, def.sampleParams);
    } catch (e) {
      out(`  [skip] ${key.padEnd(18)} ${(e as Error).message}`);
      continue;
    }
    try {
      const r = await client.get(p, { ...(def.query ?? {}), ...(def.selfTestQuery ?? {}) });
      const d = r.data;
      const keys = isObj(d) ? Object.keys(d).slice(0, 15).join(", ") : Array.isArray(d) ? `(array)` : typeof d;
      const count = isObj(d) && typeof d.count === "number" ? `count=${d.count}, ` : "";
      const items = findArray(d).length;
      const ok = shapeMatches(def.expect, d);
      out(`  [${r.status}] ${key.padEnd(18)} ${p}  keys: ${keys}  (${count}items=${items})${def.verified ? "" : " [unverified]"}`);
      if (!ok) {
        out(`         NEEDS UPDATE: src/config.ts ${key} (expected ${def.expect}, got ${Array.isArray(d) ? "array" : typeof d})`);
        needsUpdate.push(key);
      }
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      out(`  [${status ?? "ERR"}] ${key.padEnd(18)} ${p}  ${(e as Error).message}`);
      out(`         NEEDS UPDATE: src/config.ts ${key}`);
      needsUpdate.push(key);
    }
  }
  out();

  out("== Progress summary ==");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(client);
  await server.connect(a);
  const mcp = new Client({ name: "gregmat-self-test", version: "0.0.0" });
  await mcp.connect(b);
  const res = await mcp.callTool({ name: "get_progress_summary", arguments: {} });
  const content = res.content as { type: string; text?: string }[];
  out(content.map((c) => c.text ?? "").join("\n"));
  await mcp.close();
  out();
  out(needsUpdate.length ? `Endpoints needing attention: ${needsUpdate.join(", ")} (see README "Fixing guessed endpoints")` : "All probed endpoints responded with the expected shape.");
  return 0;
}
