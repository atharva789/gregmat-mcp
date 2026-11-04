// npm test — no credentials, no network to GregMAT.
//  1. Spawns dist/index.js over stdio with the SDK Client + StdioClientTransport,
//     lists all 9 tools, exercises the local log, and checks get_profile returns a
//     clean structured auth error.
//  2. Offline unit tests of pure helpers and auth/pagination against a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");
const EXPECTED_TOOLS = [
  "get_profile", "get_progress_summary", "list_completed_items", "get_quiz_results", "get_diagnostics",
  "get_study_plan_progress", "raw_get", "log_solved_problem", "list_local_log",
];

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gregmat-mcp-test-"));
process.on("exit", () => fs.rmSync(tmpHome, { recursive: true, force: true }));

// Child env: strip any real GregMAT creds; point API at a closed local port as a guard.
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GREGMAT_") && v !== undefined) env[k] = v;
  return { ...env, GREGMAT_MCP_HOME: tmpHome, GREGMAT_API_BASE: "http://127.0.0.1:9", GREGMAT_TIMEOUT_MS: "2000", ...extra };
}

const parse = (res) => JSON.parse(res.content.map((c) => c.text).join(""));

test("dist/index.js exists (run npm run build first)", () => {
  assert.ok(fs.existsSync(entry), `${entry} missing`);
});

test("--help prints usage", async () => {
  const { execFileSync } = await import("node:child_process");
  const outp = execFileSync(process.execPath, [entry, "--help"], { env: childEnv(), encoding: "utf8" });
  assert.match(outp, /--self-test/);
});

test("--self-test exits non-zero without credentials", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [entry, "--self-test"], { env: childEnv(), encoding: "utf8", timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /Auth/);
  assert.match(r.stdout, /FAILED/);
});

test("MCP stdio server: tools, local log, auth error", async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: childEnv(), stderr: "pipe" });
  const client = new Client({ name: "gregmat-mcp-smoke", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  await t.test("lists all 9 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
    for (const tool of tools) assert.ok(tool.description && tool.description.length > 10, `${tool.name} has description`);
  });

  await t.test("log_solved_problem writes to temp GREGMAT_MCP_HOME", async () => {
    const r1 = await client.callTool({
      name: "log_solved_problem",
      arguments: { section: "quant", topic: "Ratios", item: "ratio-drill-1", correct: true, time_minutes: 3, date: "2026-11-01" },
    });
    assert.ok(!r1.isError, JSON.stringify(r1));
    const b1 = parse(r1);
    assert.equal(b1.logged.section, "quant");
    assert.equal(b1.logged.source, "gregmat");
    assert.equal(b1.total_entries, 1);

    const r2 = await client.callTool({
      name: "log_solved_problem",
      arguments: { source: "manhattan5lb", section: "verbal", topic: "Text Completion", item: "TC set 4", correct: false, date: "2026-11-02", notes: "trap answer" },
    });
    assert.ok(!r2.isError);
    const r3 = await client.callTool({
      name: "log_solved_problem",
      arguments: { section: "quant", topic: "Ratios", item: "ratio-drill-2", correct: false, date: "2026-11-02" },
    });
    assert.ok(!r3.isError);
    const file = path.join(tmpHome, "log.json");
    assert.ok(fs.existsSync(file));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, 3);
  });

  await t.test("log_solved_problem validates input", async () => {
    const r = await client.callTool({ name: "log_solved_problem", arguments: { section: "math", topic: "x", item: "y" } });
    assert.ok(r.isError, "invalid section rejected");
    const r2 = await client.callTool({ name: "log_solved_problem", arguments: { section: "quant", topic: "x", item: "y", date: "not-a-date" } });
    assert.ok(r2.isError, "invalid date rejected");
  });

  await t.test("list_local_log returns entries + stats", async () => {
    const all = parse(await client.callTool({ name: "list_local_log", arguments: {} }));
    assert.equal(all.count, 3);
    assert.equal(all.stats.total.count, 3);
    assert.equal(all.stats.by_section.quant.count, 2);
    assert.equal(all.stats.by_section.quant.accuracy, 50);
    assert.equal(all.stats.by_day["2026-11-02"], 2);
    assert.ok(typeof all.days_until_test === "number");
    assert.equal(all.streak.longest, 2);

    const verbal = parse(await client.callTool({ name: "list_local_log", arguments: { section: "verbal" } }));
    assert.equal(verbal.count, 1);
    assert.equal(verbal.entries[0].source, "manhattan5lb");

    const since = parse(await client.callTool({ name: "list_local_log", arguments: { since: "2026-11-02", topic: "ratio" } }));
    assert.equal(since.count, 1);
    assert.equal(since.entries[0].item, "ratio-drill-2");
  });

  await t.test("get_profile without creds → clean structured auth error", async () => {
    const r = await client.callTool({ name: "get_profile", arguments: {} });
    assert.equal(r.isError, true);
    const body = parse(r);
    assert.match(body.error, /^auth_failed/);
    assert.equal(body.endpoint, "/authentication/me/");
    assert.equal(body.status, null);
    assert.match(body.hint, /src\/config\.ts/);
    assert.ok(Array.isArray(body.attempts));
    assert.ok(!JSON.stringify(body).includes("password\":"), "no secrets echoed");
  });

  await t.test("GregMAT tools degrade gracefully and still include local data", async () => {
    const sum = await client.callTool({ name: "get_progress_summary", arguments: {} });
    assert.ok(!sum.isError);
    const s = parse(sum);
    assert.equal(s.test_date, "2026-11-21");
    assert.equal(s.local_log.entries, 3);
    assert.ok(s.errors[0].error.startsWith("auth_failed"));
    assert.equal(s.activity.last_activity, "2026-11-02");

    const diag = parse(await client.callTool({ name: "get_diagnostics", arguments: { min_attempts: 1 } }));
    assert.equal(diag.derived, true);
    assert.equal(diag.sections.quant.accuracy, 50);
    assert.ok(diag.weakest_topics.some((x) => x.topic === "Text Completion"));
    assert.ok(diag.unattempted_high_yield.length > 0);

    const items = parse(await client.callTool({ name: "list_completed_items", arguments: { type: "problem" } }));
    assert.equal(items.total_matching, 3);
    assert.ok(items.errors.length >= 1);

    const plan = await client.callTool({ name: "get_study_plan_progress", arguments: {} });
    assert.equal(plan.isError, true);
    assert.ok(typeof parse(plan).days_until_test === "number");

    const quiz = await client.callTool({ name: "get_quiz_results", arguments: { slug: "some-quiz" } });
    assert.equal(quiz.isError, true);
    assert.ok(Array.isArray(parse(quiz).local_log_quizzes));
  });

  await t.test("raw_get enforces allowlist and GET-only paths", async () => {
    for (const p of ["/staff/qadmin/", "https://evil.example/ps/stats/", "/ps/quiz/solve/abc/", "/studyplans/done/5/", "/ps/../staff/", "/ps/stats/?x=1"]) {
      const r = await client.callTool({ name: "raw_get", arguments: { path: p } });
      assert.equal(r.isError, true, `refused ${p}`);
      assert.match(parse(r).hint, /Allowed prefixes/);
    }
    const ok = await client.callTool({ name: "raw_get", arguments: { path: "/ps/stats/" } });
    assert.equal(ok.isError, true);
    assert.match(parse(ok).error, /^auth_failed/, "allowed path proceeds to auth (which fails without creds)");
  });
});

// ---------------------------------------------------------------------------
// Offline unit tests (dist modules, mocked fetch)
// ---------------------------------------------------------------------------
const dist = (m) => import(path.join(root, "dist", m));

test("normalize helpers", async () => {
  const n = await dist("normalize.js");
  const q = n.normalizeQuestion({ id: 7, slug: "qc-1", title: "QC ratio", tags: [{ name: "Ratios" }], is_solved: true, solved_at: "2026-10-30T10:00:00Z" });
  assert.equal(q.status, "solved");
  assert.equal(q.section, "quant");
  assert.deepEqual(q.tags, ["Ratios"]);
  assert.equal(n.normalizeQuestion({ title: "x", user_status: { attempted: true, correct: false } }).status, "attempted");
  assert.equal(n.normalizeQuestion({ title: "x" }).status, "unknown");
  assert.equal(n.classifySection("Text Completion"), "verbal");
  assert.equal(n.classifySection("Issue essay"), "awa");

  const plan = n.normalizeStudyPlan({ slug: "p", title: "Plan", days: [{ day: 1, tasks: [{ id: 1, title: "Video A", done: true }, { id: 2, title: "Quiz B", done: false }] }] });
  assert.equal(plan.units.length, 2);
  assert.equal(plan.units[0].day, "1");
  assert.equal(plan.units.filter((u) => u.done).length, 1);

  const quiz = n.normalizeQuiz({ slug: "q", title: "Quant quiz", score: 8, total: 10 });
  assert.equal(quiz.percent, 80);
  assert.equal(quiz.section, "quant");

  const now = new Date("2026-11-03T12:00:00");
  const s = n.computeStreak(["2026-11-01", "2026-11-02", "2026-11-03", "2026-10-20"], now);
  assert.equal(s.current, 3);
  assert.equal(s.longest, 3);
  assert.equal(n.computeStreak(["2026-10-01"], now).current, 0);
  assert.equal(n.daysUntil("2026-11-21", now), 18);
  assert.deepEqual(n.flattenNumbers({ a: 1, b: { c: 2, d: "x" } }), { a: 1, "b.c": 2 });
  assert.equal(n.normalizeProfile({ user: { id: 3, first_name: "A", last_name: "B", email: "a@b.c" } }).name, "A B");
});

test("auth helpers", async () => {
  const a = await dist("auth.js");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
  assert.equal(a.tokenFromCookie(`foo=1; piniaAccess=${encodeURIComponent('"' + jwt + '"')}; bar=2`), jwt);
  assert.equal(a.tokenFromCookie("foo=1"), null);
  assert.equal(a.isExpired(jwt), false);
  const old = Buffer.from(JSON.stringify({ exp: 1000 })).toString("base64url");
  assert.equal(a.isExpired(`h.${old}.s`), true);
  assert.deepEqual(a.extractTokens({ access: "x", refresh: "y" }), { access: "x", refresh: "y" });
  assert.deepEqual(a.extractTokens({ token: { access: "x" } }), { access: "x", refresh: undefined });
});

test("raw path validation", async () => {
  const { validateRawPath } = await dist("tools.js");
  assert.equal(validateRawPath("/ps/stats/").ok, true);
  assert.equal(validateRawPath("ps/questions/").ok, true);
  assert.equal(validateRawPath("/ps/question/solve/abc/").ok, false);
  assert.equal(validateRawPath("/ps/%2e%2e/staff/").ok, false);
  assert.equal(validateRawPath("//evil.com/x").ok, false);
});

test("login body variants + session cache + pagination (mocked fetch, no network)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gregmat-mcp-auth-"));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("GREGMAT_")) delete process.env[k];
  process.env.GREGMAT_MCP_HOME = home;
  process.env.GREGMAT_EMAIL = "test@example.com";
  process.env.GREGMAT_PASSWORD = "not-a-real-password";
  try {
    const { AuthManager } = await dist("auth.js");
    const { GregmatClient } = await dist("api.js");
    const exp = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const access = `h.${exp}.s`;
    const calls = [];
    const mockFetch = async (url, init = {}) => {
      const u = new URL(String(url));
      const method = init.method ?? "GET";
      calls.push(`${method} ${u.pathname}${u.search}`);
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (method === "POST" && u.pathname === "/authentication/sidebaseMultiplexedLogin/") {
        const body = JSON.parse(init.body);
        return body.username ? json(200, { access, refresh: "r1" }) : json(400, { detail: "email field unknown" });
      }
      if (method !== "GET") return json(405, {});
      assert.equal(init.headers.Authorization, `Bearer ${access}`);
      if (u.pathname === "/ps/questions/") {
        const offset = Number(u.searchParams.get("offset"));
        const all = Array.from({ length: 5 }, (_, i) => ({ id: i, title: `Q${i}`, tags: ["Ratios"], solved: i % 2 === 0 }));
        const page = all.slice(offset, offset + 2);
        return json(200, { count: 5, next: offset + 2 < 5 ? `https://gregmat-backend.herokuapp.com/ps/questions/?limit=2&offset=${offset + 2}` : null, results: page });
      }
      if (u.pathname === "/authentication/me/") return json(200, { id: 1, email: "test@example.com" });
      return json(404, { detail: "Not found." });
    };
    process.env.GREGMAT_API_BASE = "https://gregmat-backend.herokuapp.com";
    const auth = new AuthManager(mockFetch);
    const client = new GregmatClient(auth, mockFetch);
    const tok = await auth.getToken();
    assert.equal(tok, access);
    assert.equal(auth.info.source, "login");
    assert.equal(auth.info.loginVariant, "username", "falls back to {username,password}");
    const sessionPath = path.join(home, "session.json");
    assert.ok(fs.existsSync(sessionPath));
    assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);

    const p = await client.paginate("/ps/questions/", {}, { pageSize: 2 });
    assert.equal(p.items.length, 5);
    assert.equal(p.total, 5);
    assert.equal(p.pagesFetched, 3);
    assert.equal(p.truncated, false);

    await assert.rejects(client.get("/ps/stats/"), (e) => e.name === "ApiError" && e.status === 404);
    assert.ok(calls.every((c) => c.startsWith("GET") || c.startsWith("POST /authentication/sidebaseMultiplexedLogin/")), "only GETs besides login");

    // Second manager reuses the cached session (checked via /me/), no login POST.
    calls.length = 0;
    const auth2 = new AuthManager(mockFetch);
    await auth2.getToken();
    assert.equal(auth2.info.source, "session_cache");
    assert.ok(!calls.some((c) => c.startsWith("POST")));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
