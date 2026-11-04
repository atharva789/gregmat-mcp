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
    assert.match(body.hint, /--login/);
    assert.match(body.error, /--login/);
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
    assert.equal(diag.local_log.by_section.quant.accuracy, 50);
    assert.ok(diag.errors[0].error.startsWith("auth_failed"));

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
    for (const p of ["/staff/qadmin/", "https://evil.example/ps/stats/", "/ps/quiz/some-slug/", "/quizzes/quiz/", "/studyplans/done/5/", "/ps/../staff/", "/ps/stats/?x=1"]) {
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
// Offline unit tests (dist modules, mocked fetch). Fixtures are synthetic: they
// follow the response shapes in docs/API-FINDINGS.md and contain no real user data.
// ---------------------------------------------------------------------------
const dist = (m) => import(path.join(root, "dist", m));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (expOffsetSec) => `h.${b64({ exp: Math.floor(Date.now() / 1000) + expOffsetSec })}.s`;

const att = (iso, correct, first) => ({ answered_at: iso, correct, first, score: correct ? 1 : 0, score_denom: 1 });
const TOPIC = (slug, title) => ({ id: slug.length, slug, title, type: "topic" });
const CONTEXT = { id: 99, slug: "context_real_life", title: "Real Life", type: "context" };
const mkQ = (id, super_category, first_tlc, type, tags, status, attempts) => ({
  id, title: `Question ${id}`, slug: `question-${id}`, type, difficulty: "Medium", super_category, status, acceptance: 0.5,
  first_tlc, tags, user_answer_attempts: attempts, bookmarked: false, liked: false, plus_only: false, has_solution_video: false,
});
const QUESTIONS = {
  Quant: [
    mkQ(1, "Quant", "Arithmetic", "Quantitative Comparison", [TOPIC("topic_ratios", "Ratios"), CONTEXT], "Solved", [att("2026-11-01T10:00:00-05:00", true, true)]),
    mkQ(2, "Quant", "Arithmetic", "Multiple Choice", [TOPIC("topic_ratios", "Ratios")], "Attempted", [att("2026-11-02T09:00:00-05:00", false, true), att("2026-11-02T09:05:00-05:00", false, false)]),
    mkQ(3, "Quant", "Algebra", "Multiple Choice", [TOPIC("topic_exponents", "Exponents")], "Solved", [att("2026-11-02T20:00:00-05:00", false, true), att("2026-11-02T20:10:00-05:00", true, false)]),
    mkQ(4, "Quant", "Algebra", "Multiple Choice", [TOPIC("topic_exponents", "Exponents")], "ToDo", []),
    mkQ(5, "Quant", "Geometry", "Numeric Entry", [TOPIC("topic_circles", "Circles")], "ToDo", []),
    mkQ(6, "Quant", "Arithmetic", "Multiple Choice", [TOPIC("topic_ratios", "Ratios")], "Solved", [att("2026-11-03T08:00:00-05:00", true, true)]),
  ],
  Verbal: [
    mkQ(7, "Verbal", "Text Completion", "Text Completion", [], "Solved", [att("2026-11-03T09:00:00-05:00", true, true)]),
    mkQ(8, "Verbal", "Reading Comprehension", "Reading Comprehension", [], "ToDo", []),
  ],
};
const QUIZ = (id, title, attempts = []) => ({ id, title, slug: `quiz-${id}`, minutes: 30, super_category: "Quant", plus_only: false, max_score: 20, mean_score: 12, acceptance: 0.6, attempts, order_in_group: id });
const PLAN_LIST = [
  { slug: "plan-a", title: "Plan A", plus_only: false, flags: { planRole: "plan", planType: "gre" } },
  { slug: "plan-a-m2", title: "Plan A: Week 2", plus_only: false, flags: { planRole: "module", parentSlug: "plan-a", moduleIndex: 1 } },
  { slug: "plan-a-m1", title: "Plan A: Week 1", plus_only: false, flags: { planRole: "module", parentSlug: "plan-a", moduleIndex: 0 } },
  { slug: "plan-b", title: "Plan B", plus_only: false, flags: { planRole: "plan", planType: "gre" } },
  { slug: "plan-b-m1", title: "Plan B: Week 1", plus_only: false, flags: { planRole: "module", parentSlug: "plan-b", moduleIndex: 0 } },
];
const unit = (id, title, done, left = "") => ({ id, title, description: "<p>d</p>", left_side_title: "Watch", left_side: left, right_side_title: "", right_side: "", plus_only: false, two_sided: false, done });
const PLAN_DETAIL = {
  "plan-a": { title: "Plan A", slug: "plan-a", units: [], flags: { planRole: "plan" } },
  "plan-a-m1": { title: "Plan A: Week 1", slug: "plan-a-m1", flags: { planRole: "module", parentSlug: "plan-a", moduleIndex: 0 }, units: [unit(1, "Day 1", true), unit(2, "Day 2", false, "<p>Watch <a href='/x'>Ratios video</a> &amp; notes</p><p>Then drill</p>")] },
  "plan-a-m2": { title: "Plan A: Week 2", slug: "plan-a-m2", flags: { planRole: "module", parentSlug: "plan-a", moduleIndex: 1 }, units: [unit(3, "Day 8", false)] },
  "plan-b-m1": { title: "Plan B: Week 1", slug: "plan-b-m1", flags: {}, units: [unit(4, "B Day 1", true), unit(5, "B Day 2", true)] },
  "plan-b": { title: "Plan B", slug: "plan-b", units: [] },
};

/** Mock GregMAT backend. `calls` records every request. */
function makeBackend({ access, refreshAccess } = {}) {
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname, search: u.search, auth: init.headers?.Authorization });
    if (method === "POST") {
      if (u.pathname === "/authentication/auth/jwt/refresh/") {
        return JSON.parse(init.body).refresh === "good-refresh" ? json(200, { access: refreshAccess, refresh: "new-refresh" }) : json(401, { detail: "bad refresh" });
      }
      return json(405, {});
    }
    const p = u.pathname;
    if (p === "/authentication/me/") return json(200, { user: { email: "test@example.com", first_name: "Test", last_name: "User", is_plus: true, stripe_subscription_status: "active", current_period_end: "2027-01-01T00:00:00Z", subscriptions: [], per_site_access: {} } });
    if (p === "/ps/stats/") return json(200, { quant: 603, verbal: 315, mini_exams: 25 });
    if (p === "/ps/question-counts/") {
      assert.ok(u.searchParams.get("super_category"), "super_category is required");
      return json(200, { sections: { Quant: 603 }, question_types: {}, contexts: {}, tags: { topic_ratios: 40, topic_exponents: 67, topic_circles: 30, topic_untouched_thing: 12 } });
    }
    if (p === "/ps/questions/") {
      const cat = u.searchParams.get("super_category");
      const all = QUESTIONS[cat];
      assert.ok(all, `unexpected super_category ${cat}`);
      const limit = Number(u.searchParams.get("limit") ?? 200);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const next = offset + limit < all.length ? `https://gregmat-backend.herokuapp.com/ps/questions/?limit=${limit}&offset=${offset + limit}&super_category=${cat}` : null;
      return json(200, { count: all.length, next, previous: null, results: all.slice(offset, offset + limit) });
    }
    if (p === "/ps/quizgroup/gre-mini-exams/") return json(200, { title: "GRE Mini Exams", slug: "gre-mini-exams", body: "", quizzes: [QUIZ(1, "Mini Exam 1", [{ score: 15, score_denom: 20, finished_at: "2026-11-02T12:00:00Z" }]), QUIZ(2, "Mini Exam 2")] });
    if (p === "/ps/quizsupergroup/timed-gre-quant-sections/") return json(200, { title: "Timed Quant", slug: "timed-gre-quant-sections", body: "", quiz_groups: [{ title: "Set A", slug: "set-a", quizzes: [QUIZ(3, "Quant Section 1")] }] });
    if (p === "/ps/quizsupergroup/timed-gre-verbal-sections/") return json(200, { title: "Timed Verbal", slug: "timed-gre-verbal-sections", body: "", quiz_groups: [{ title: "Set B", slug: "set-b", quizzes: [{ ...QUIZ(4, "Verbal Section 1"), super_category: "Verbal" }] }] });
    if (p === "/sb/stats/me/") return json(200, { pairing: { total_questions: 50, total_attempts: 30, total_first_attempts: 20, total_correct_first_attempts: 15 }, blankclassification: { total_questions: 10, total_attempts: 0, total_first_attempts: 0, total_correct_first_attempts: 0 } });
    if (p === "/studyplans/") return json(200, { count: PLAN_LIST.length, next: null, previous: null, results: PLAN_LIST });
    const m = p.match(/^\/studyplans\/([^/]+)\/$/);
    if (m && PLAN_DETAIL[m[1]]) return json(200, PLAN_DETAIL[m[1]]);
    return json(404, { detail: "Not found." });
  };
  return { fetchImpl, calls };
}

function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("GREGMAT_")) delete process.env[k];
  Object.assign(process.env, { GREGMAT_API_BASE: "https://gregmat-backend.herokuapp.com", ...vars });
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
  return Promise.resolve(fn()).finally(restore);
}

test("config: verified endpoints, QUIZ_SOURCES, no broken guesses", async () => {
  const c = await dist("config.js");
  assert.deepEqual(c.QUIZ_SOURCES.map((s) => `${s.kind}:${s.slug}`), ["quizgroup:gre-mini-exams", "quizsupergroup:timed-gre-quant-sections", "quizsupergroup:timed-gre-verbal-sections"]);
  assert.deepEqual([...c.SUPER_CATEGORIES], ["Quant", "Verbal"]);
  assert.equal(c.ENDPOINTS.psQuestionCounts.query.super_category, "Quant");
  for (const [k, d] of Object.entries(c.ENDPOINTS)) assert.equal(d.verified, true, `${k} verified`);
  for (const b of c.BROKEN_ENDPOINTS) assert.ok(!Object.values(c.ENDPOINTS).some((d) => d.path === b), `${b} must not be an endpoint`);
});

test("normalize helpers", async () => {
  const n = await dist("normalize.js");
  const q = n.normalizeQuestion(QUESTIONS.Quant[2]);
  assert.equal(q.status, "solved");
  assert.equal(q.section, "quant");
  assert.equal(q.category, "Algebra");
  assert.equal(q.first_attempt_correct, false, "first attempt wrong even though later solved");
  assert.equal(q.attempts.length, 2);
  assert.equal(q.last_attempt_at, new Date("2026-11-02T20:10:00-05:00").toISOString());
  assert.equal(n.normalizeQuestion(QUESTIONS.Quant[3]).status, "todo");
  assert.equal(n.normalizeQuestion(QUESTIONS.Quant[3]).first_attempt_correct, null);
  assert.equal(n.normalizeQuestion(QUESTIONS.Verbal[0]).section, "verbal");
  assert.deepEqual(n.topicTags(n.normalizeQuestion(QUESTIONS.Quant[0])).map((t) => t.title), ["Ratios"]);

  const quiz = n.normalizeQuiz(QUIZ(1, "Mini", [{ score: 15, score_denom: 20, finished_at: "2026-11-02T12:00:00Z" }, { weird: true }]), { source: "s" });
  assert.equal(quiz.attempts[0].percent, 75);
  assert.equal(quiz.attempts[0].date, "2026-11-02T12:00:00.000Z");
  assert.equal(quiz.attempts[1].percent, null, "unknown attempt shape tolerated");
  assert.equal(n.normalizeQuiz({ title: "x" }, { source: "s", section: "verbal" }).section, "verbal");

  const mod = n.normalizeStudyModule(PLAN_DETAIL["plan-a-m1"], { slug: "x" });
  assert.equal(mod.units.length, 2);
  assert.equal(mod.units[1].preview, "Watch Ratios video & notes\nThen drill");
  assert.equal(n.normalizePlanSummary(PLAN_LIST[1]).parentSlug, "plan-a");
  assert.equal(n.normalizeSbStats({ pairing: { total_first_attempts: 20, total_correct_first_attempts: 15 } })[0].first_attempt_accuracy, 75);

  const s = n.computeStreak(["2026-11-01", "2026-11-02", "2026-11-03", "2026-10-20"], new Date("2026-11-03T12:00:00"));
  assert.equal(s.current, 3);
  assert.equal(n.daysUntil("2026-11-21", new Date("2026-11-03T12:00:00")), 18);
  assert.equal(n.normalizeProfile({ user: { first_name: "A", last_name: "B", email: "a@b.c", is_plus: true } }).name, "A B");
});

test("analytics: first-attempt accuracy, weakest first, untouched topics", async () => {
  const n = await dist("normalize.js");
  const a = await dist("analytics.js");
  const qs = [...QUESTIONS.Quant, ...QUESTIONS.Verbal].map(n.normalizeQuestion);
  const topics = a.byTopic(qs);
  const ratios = topics.find((t) => t.name === "Ratios");
  assert.equal(ratios.total, 3);
  assert.equal(ratios.attempted, 3);
  assert.equal(ratios.first_attempts, 3);
  assert.equal(ratios.first_attempt_correct, 2);
  assert.equal(ratios.accuracy, 66.7);
  const exp = topics.find((t) => t.name === "Exponents");
  assert.equal(exp.accuracy, 0);
  assert.equal(exp.solved, 1);
  const weakest = a.weakestFirst(topics);
  assert.equal(weakest[0].name, "Exponents");
  assert.equal(weakest.at(-1).accuracy, null, "ungraded groups last");
  assert.equal(a.byCategory(qs).find((c) => c.name === "Arithmetic").total, 3);
  assert.equal(a.byType(qs).find((c) => c.name === "Text Completion").accuracy, 100);
  const sec = a.bySection(qs);
  assert.equal(sec.find((s) => s.name === "Quant").solved, 3);
  const untouched = a.untouchedTopics(qs, { topic_circles: 30, topic_untouched_thing: 12, topic_ratios: 40, not_a_topic: 5 });
  assert.deepEqual(untouched.map((t) => t.topic), ["Circles", "untouched thing"]);
  assert.equal(untouched[0].questions_available, 30);
  assert.equal(a.pct(1, 3), 33.3);
});

test("auth helpers", async () => {
  const a = await dist("auth.js");
  const token = jwt(3600);
  assert.equal(a.tokenFromCookie(`foo=1; piniaAccess=${encodeURIComponent('"' + token + '"')}; bar=2`), token);
  assert.equal(a.tokenFromCookie("foo=1"), null);
  assert.equal(a.isExpired(token), false);
  assert.equal(a.isExpired(jwt(-10)), true);
  assert.ok(a.jwtExpiry(token) instanceof Date);
  assert.deepEqual(a.extractTokens({ access: "x", refresh: "y" }), { access: "x", refresh: "y" });
});

test("browser login: no-display error is clear", async () => {
  const b = await dist("browserLogin.js");
  assert.throws(() => b.assertDisplay("linux", {}), (e) => e.name === "AuthError" && /xvfb-run/.test(e.message) && /--login/.test(e.message));
  assert.doesNotThrow(() => b.assertDisplay("linux", { DISPLAY: ":0" }));
  assert.doesNotThrow(() => b.assertDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" }));
  assert.doesNotThrow(() => b.assertDisplay("darwin", {}));
});

test("auth: cached session, JWT exp, refresh, browser login (mocked, no network, no browser)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gregmat-mcp-auth-"));
  try {
    await withEnv({ GREGMAT_MCP_HOME: home }, async () => {
      const { AuthManager, saveSession, loadSession } = await dist("auth.js");
      const sessionPath = path.join(home, "session.json");
      const noBrowser = async () => assert.fail("browser must not be opened");

      // 1. valid cached access token: used as-is, zero network.
      const validAccess = jwt(3600);
      saveSession({ access: validAccess, refresh: "good-refresh", source: "browser_login", savedAt: new Date().toISOString() });
      assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
      let be = makeBackend({ refreshAccess: jwt(7200) });
      let auth = new AuthManager(be.fetchImpl, noBrowser);
      assert.equal(await auth.getToken(), validAccess);
      assert.equal(auth.info.source, "session_cache");
      assert.equal(be.calls.length, 0);

      // 2. expired access + good refresh token: refreshed, session rewritten (0600).
      const fresh = jwt(7200);
      saveSession({ access: jwt(-100), refresh: "good-refresh", source: "browser_login", savedAt: new Date().toISOString() });
      be = makeBackend({ refreshAccess: fresh });
      auth = new AuthManager(be.fetchImpl, noBrowser);
      assert.equal(await auth.getToken(), fresh);
      assert.equal(auth.info.source, "session_refresh");
      assert.deepEqual(be.calls.map((c) => `${c.method} ${c.path}`), ["POST /authentication/auth/jwt/refresh/"]);
      assert.equal(loadSession().access, fresh);
      assert.equal(loadSession().refresh, "new-refresh");
      assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);

      // 3. refresh fails, no creds: clear error mentioning --login.
      saveSession({ access: jwt(-100), refresh: "bad-refresh", source: "browser_login", savedAt: new Date().toISOString() });
      auth = new AuthManager(makeBackend().fetchImpl, noBrowser);
      await assert.rejects(auth.getToken(), (e) => e.name === "AuthError" && /--login/.test(e.message) && e.attempts.some((x) => /refresh failed/.test(x)));

      // 4. refresh fails + GREGMAT_EMAIL/PASSWORD: automatic browser login, tokens cached.
      process.env.GREGMAT_EMAIL = "test@example.com";
      process.env.GREGMAT_PASSWORD = "not-a-real-password";
      const loginAccess = jwt(9000);
      let opts;
      auth = new AuthManager(makeBackend().fetchImpl, async (o) => ((opts = o), { access: loginAccess, refresh: "r-login" }));
      assert.equal(await auth.getToken(), loginAccess);
      assert.equal(auth.info.source, "browser_login");
      assert.equal(opts.email, "test@example.com");
      assert.ok(!opts.manual);
      assert.equal(loadSession().refresh, "r-login");
      assert.ok(!fs.readFileSync(sessionPath, "utf8").includes("not-a-real-password"), "password never stored");

      // 5. interactive (--login) path is manual and persists the session.
      fs.rmSync(sessionPath);
      auth = new AuthManager(makeBackend().fetchImpl, async (o) => ((opts = o), { access: loginAccess, refresh: "r2" }));
      await auth.interactiveLogin();
      assert.equal(opts.manual, true);
      assert.equal(loadSession().refresh, "r2");

      // 6. env token wins and is never written to disk.
      fs.rmSync(sessionPath);
      const envTok = jwt(600);
      process.env.GREGMAT_TOKEN = envTok;
      auth = new AuthManager(makeBackend().fetchImpl, noBrowser);
      assert.equal(await auth.getToken(), envTok);
      assert.equal(auth.info.source, "env_token");
      assert.ok(!fs.existsSync(sessionPath));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("raw path validation", async () => {
  const { validateRawPath } = await dist("tools.js");
  assert.equal(validateRawPath("/ps/stats/").ok, true);
  assert.equal(validateRawPath("ps/questions/").ok, true);
  assert.equal(validateRawPath("/studyplans/plan-a/").ok, true);
  assert.equal(validateRawPath("/quizzes/quiz/").ok, false, "known-404 prefix removed");
  assert.equal(validateRawPath("/ps/question/solve/abc/").ok, false);
  assert.equal(validateRawPath("/ps/%2e%2e/staff/").ok, false);
  assert.equal(validateRawPath("//evil.com/x").ok, false);
});

test("data layer + all tools against mocked backend shapes (no network)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gregmat-mcp-tools-"));
  try {
    await withEnv({ GREGMAT_MCP_HOME: home, GREGMAT_TOKEN: jwt(3600), GREGMAT_TEST_DATE: "2026-11-21" }, async () => {
      const { AuthManager } = await dist("auth.js");
      const { GregmatClient } = await dist("api.js");
      const { createServer } = await dist("server.js");
      const { fetchQuestions } = await dist("gregmat.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const be = makeBackend();
      const client = new GregmatClient(new AuthManager(be.fetchImpl, async () => assert.fail("no browser")), be.fetchImpl);

      // pagination across pages (limit 200 default → mock count is small, so also test tiny pages).
      const p = await client.paginate("/ps/questions/", { super_category: "Quant" }, { pageSize: 2 });
      assert.equal(p.items.length, 6);
      assert.equal(p.pagesFetched, 3);
      be.calls.length = 0;

      // /ps/questions/ cache: second fetch makes no requests.
      const r1 = await fetchQuestions(client);
      assert.ok(r1.ok);
      assert.equal(r1.data.questions.length, 8);
      assert.equal(r1.data.from_cache, false);
      const n1 = be.calls.length;
      assert.ok(be.calls.every((c) => c.path === "/ps/questions/" && ["Quant", "Verbal"].includes(new URLSearchParams(c.search).get("super_category")) && new URLSearchParams(c.search).get("limit") === "200"));
      const r2 = await fetchQuestions(client);
      assert.equal(r2.data.from_cache, true);
      assert.equal(be.calls.length, n1, "cache hit: no new requests");
      await fetchQuestions(client, { refresh: true });
      assert.equal(be.calls.length, n1 * 2, "refresh bypasses cache");

      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = createServer(client);
      await server.connect(a);
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mcp = new Client({ name: "t", version: "0" });
      await mcp.connect(b);
      const call = async (name, args = {}) => {
        const res = await mcp.callTool({ name, arguments: args });
        assert.ok(!res.isError, `${name}: ${JSON.stringify(res.content)}`);
        return parse(res);
      };
      try {
        const prof = await call("get_profile");
        assert.equal(prof.profile.is_plus, true);
        assert.equal(prof.auth.source, "env_token");

        // list_completed_items
        const items = await call("list_completed_items", {});
        const probs = items.items.filter((i) => i.type === "problem");
        assert.equal(probs.length, 5, "5 questions have attempts");
        assert.equal(probs.find((i) => i.title === "Question 3").correct, false, "correct = first attempt");
        assert.equal(probs.find((i) => i.title === "Question 3").attempts, 2);
        assert.equal(items.items.filter((i) => i.type === "quiz").length, 1);
        assert.equal(items.items.filter((i) => i.type === "quiz")[0].percent, 75);
        assert.equal(items.items.filter((i) => i.type === "video").length, 3, "done units of the plan(s) in use: plan-a Day 1 + plan-b ×2");
        assert.equal(items.items.filter((i) => i.type === "skill").length, 1);
        assert.deepEqual(items.items.filter((i) => i.type === "problem").map((i) => i.title).slice(0, 2), ["Question 7", "Question 6"], "newest first");
        const sinceItems = await call("list_completed_items", { type: "problem", since: "2026-11-03" });
        assert.ok(sinceItems.items.every((i) => i.date));

        // quiz results
        const quiz = await call("get_quiz_results", {});
        assert.equal(quiz.quizzes_found, 4);
        assert.equal(quiz.quizzes_taken, 1);
        assert.equal(quiz.average_best_percent, 75);
        assert.equal(quiz.sources.length, 3);
        assert.ok(quiz.quizzes.some((q) => q.group === "Set A" && q.section === "quant"));
        assert.equal((await call("get_quiz_results", { group: "timed-gre-verbal-sections" })).quizzes_found, 1);
        assert.equal((await call("get_quiz_results", { slug: "quiz-1" })).quizzes[0].attempts_count, 1);

        // diagnostics
        const diag = await call("get_diagnostics", { min_attempts: 1, weakest_n: 2 });
        assert.equal(diag.derived, true);
        assert.equal(diag.weakest_topics[0].name, "Exponents");
        assert.equal(diag.weakest_topics[0].accuracy, 0);
        assert.equal(diag.by_category.find((c) => c.name === "Arithmetic").accuracy, 66.7);
        assert.ok(diag.by_type.some((t) => t.name === "Quantitative Comparison"));
        assert.deepEqual(diag.untouched_topics.map((t) => t.topic), ["Circles", "untouched thing"]);
        assert.equal(diag.skill_building_first_attempt_accuracy.find((s) => s.kind === "pairing").accuracy, 75);
        assert.equal(diag.quiz_average_by_section.quant.average_best_percent, 75);
        const strict = await call("get_diagnostics", { min_attempts: 3 });
        assert.deepEqual(strict.by_topic.map((t) => t.name), ["Ratios"], "only topics with ≥3 first attempts are ranked");

        // study plan
        const plan = await call("get_study_plan_progress", { slug: "plan-a", next_n: 5 });
        assert.equal(plan.total, 3);
        assert.equal(plan.done, 1);
        assert.equal(plan.percent, 33.3);
        assert.deepEqual(plan.modules.map((m) => m.slug), ["plan-a-m1", "plan-a-m2"], "ordered by moduleIndex");
        assert.equal(plan.next_units[0].title, "Day 2");
        assert.match(plan.next_units[0].preview, /Ratios video/);
        assert.equal(plan.plan_in_use, true);
        assert.equal(plan.days_until_test, Math.round((Date.UTC(2026, 10, 21) - Date.UTC(...new Date().toLocaleDateString("en-CA").split("-").map((x, i) => (i === 1 ? +x - 1 : +x)))) / 86400000));
        // default plan (not in mock list) has no progress → scans other plans.
        const none = await call("get_study_plan_progress", {});
        assert.equal(none.slug, "the-im-overwhelmed-study-plan");

        // summary
        const sum = await call("get_progress_summary", { study_plan: "plan-b" });
        const g = sum.gregmat;
        assert.deepEqual(g.site_totals, { quant: 603, verbal: 315, mini_exams: 25 });
        assert.equal(g.questions.solved, 4);
        assert.equal(g.questions.attempted, 5);
        const quant = g.questions.by_section.find((s) => s.name === "Quant");
        assert.equal(quant.solved, 3);
        assert.equal(quant.total, 6);
        assert.equal(g.questions.by_topic.find((t) => t.name === "Ratios").attempted, 3);
        assert.equal(g.study_plan.done, 2);
        assert.equal(g.study_plan.plan_in_use, true);
        assert.equal(g.quizzes.by_section.quant.taken, 1);
        assert.equal(sum.activity.last_activity.slice(0, 4), "2026");
        assert.ok(sum.activity.active_days >= 3);
        assert.ok(!sum.errors);
      } finally {
        await mcp.close();
      }
      assert.ok(be.calls.every((c) => c.method === "GET"), "only GETs against GregMAT");
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("study plan: default plan without progress reports the plan in use, or none", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gregmat-mcp-plan-"));
  try {
    await withEnv({ GREGMAT_MCP_HOME: home, GREGMAT_TOKEN: jwt(3600), GREGMAT_STUDY_PLAN: "plan-a" }, async () => {
      const { AuthManager } = await dist("auth.js");
      const { GregmatClient } = await dist("api.js");
      const { createServer } = await dist("server.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const run = async (mutate) => {
        const saved = JSON.stringify(PLAN_DETAIL);
        mutate();
        try {
          const be = makeBackend();
          const c = new GregmatClient(new AuthManager(be.fetchImpl), be.fetchImpl);
          const [x, y] = InMemoryTransport.createLinkedPair();
          await createServer(c).connect(x);
          const mcp = new Client({ name: "t", version: "0" });
          await mcp.connect(y);
          const r = parse(await mcp.callTool({ name: "get_study_plan_progress", arguments: {} }));
          await mcp.close();
          return r;
        } finally {
          Object.assign(PLAN_DETAIL, JSON.parse(saved));
        }
      };
      // plan-a has no done units; plan-b does.
      let r = await run(() => PLAN_DETAIL["plan-a-m1"].units.forEach((u) => (u.done = false)));
      assert.equal(r.plan_in_use, false);
      assert.deepEqual(r.other_plans_with_progress.map((p) => p.slug), ["plan-b"]);
      // nothing done anywhere.
      r = await run(() => {
        for (const d of Object.values(PLAN_DETAIL)) for (const u of d.units) u.done = false;
      });
      assert.match(r.note, /No plan progress recorded/);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
