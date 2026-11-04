/**
 * src/config.ts — THE ONLY place for GregMAT base URLs, endpoint paths, quiz
 * sources, browser-login selectors and param names.
 *
 * Entries flagged `verified: true` were confirmed against a logged-in session
 * (see docs/API-FINDINGS.md). If `npm run check` prints
 * "NEEDS UPDATE: src/config.ts <key>", the site changed: fix that entry.
 */
import os from "node:os";
import path from "node:path";

/** Read an env var, treating blank strings as unset. */
export function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
}

// CONFIRMED (nuxt-auth runtime config in the public bundle).
export const API_BASE = (env("GREGMAT_API_BASE") ?? "https://gregmat-backend.herokuapp.com").replace(/\/+$/, "");
// CONFIRMED: Nuxt 3 SPA frontend.
export const SITE_BASE = "https://gregmat.com";

export const DEFAULT_TEST_DATE = "2026-11-21";
export const DEFAULT_STUDY_PLAN = "the-im-overwhelmed-study-plan";
export const REQUEST_TIMEOUT_MS = Number(env("GREGMAT_TIMEOUT_MS") ?? 20000);
export const USER_AGENT = "gregmat-mcp/0.1 (+local read-only MCP server)";

export function testDate(): string {
  return env("GREGMAT_TEST_DATE") ?? DEFAULT_TEST_DATE;
}
export function defaultStudyPlan(): string {
  return env("GREGMAT_STUDY_PLAN") ?? DEFAULT_STUDY_PLAN;
}
export function homeDir(): string {
  return env("GREGMAT_MCP_HOME") ?? path.join(os.homedir(), ".gregmat-mcp");
}
export function sessionFile(): string {
  return path.join(homeDir(), "session.json");
}
export function logFile(): string {
  return path.join(homeDir(), "log.json");
}

// ---------------------------------------------------------------------------
// Auth (all VERIFIED against a logged-in session, see docs/API-FINDINGS.md)
// ---------------------------------------------------------------------------
export const AUTH = {
  /**
   * POST body is {email, password, recaptcha, vthree, platform}. The backend
   * rejects requests without a valid Google reCAPTCHA token (400), so pure-HTTP
   * login is impossible: login happens in a real, headed browser instead.
   */
  loginPath: { path: "/authentication/sidebaseMultiplexedLogin/", verified: true },
  mePath: { path: "/authentication/me/", verified: true },
  /** Body {refresh}. Verified to exist; on any failure we fall back to browser login. */
  refreshPath: { path: "/authentication/auth/jwt/refresh/", verified: true },
  accessTokenField: "access",
  refreshTokenField: "refresh",
  cookieName: "piniaAccess",
  cookieDomain: "gregmat.com",
} as const;

/** Browser login (Playwright). Selectors/labels are the ones that worked in the live probe. */
export const BROWSER_LOGIN = {
  startUrl: `${SITE_BASE}/`,
  /** Visible text of the header button that opens the login form (tried in order). */
  openLoginTexts: ["Log ?in", "Sign ?in"],
  emailSelector: "input[type=email], input[name*=email i], input[placeholder*=mail i]",
  passwordSelector: "input[type=password]",
  /** Reduces reCAPTCHA failures in automated Chrome. */
  launchArgs: ["--disable-blink-features=AutomationControlled"],
  autoTimeoutMs: 90_000,
  manualTimeoutMs: 5 * 60_000,
} as const;

/** Path to a system Chrome/Chromium binary (optional). Otherwise channel "chrome" is tried first. */
export function chromePath(): string | undefined {
  return env("GREGMAT_CHROME_PATH");
}

/** /ps/questions results are cached in memory for this long. */
export function cacheTtlMs(): number {
  const v = Number(env("GREGMAT_CACHE_TTL_MS") ?? 5 * 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 5 * 60_000;
}

// ---------------------------------------------------------------------------
// Endpoints (GET only — this server is read-only against GregMAT)
// ---------------------------------------------------------------------------
export type ExpectShape = "object" | "list" | "paginated" | "any";

export interface EndpointDef {
  /** Path relative to API_BASE; `{name}` placeholders are filled from params. */
  path: string;
  description: string;
  verified: boolean;
  expect: ExpectShape;
  /** Default query params. */
  query?: Record<string, string | number | boolean>;
  /** Params used by the self-test when the path has placeholders. */
  sampleParams?: Record<string, string>;
  /** Query override for the self-test (keeps probes small). */
  selfTestQuery?: Record<string, string | number | boolean>;
}

/** GRE super categories as the API spells them (NOT "GRE-Quant"). */
export const SUPER_CATEGORIES = ["Quant", "Verbal"] as const;
export type SuperCategory = (typeof SUPER_CATEGORIES)[number];

export const QUESTIONS_PAGE_SIZE = 200;

export const ENDPOINTS = {
  me: { path: "/authentication/me/", description: "Current user ({user:{email,first_name,is_plus,...}})", verified: true, expect: "object" },
  psStats: { path: "/ps/stats/", description: "TOTAL questions on the site {quant,verbal,mini_exams} (not user progress)", verified: true, expect: "object" },
  psQuestionCounts: {
    path: "/ps/question-counts/",
    description: "Site totals per section/type/tag. super_category is REQUIRED",
    verified: true,
    expect: "object",
    query: { super_category: "Quant" },
  },
  psQuestionTags: { path: "/ps/question-tags/", description: "Paginated question tags", verified: true, expect: "paginated" },
  psQuestions: {
    path: "/ps/questions/",
    description: "Paginated questions incl. per-user status + user_answer_attempts. Needs super_category=Quant|Verbal",
    verified: true,
    expect: "paginated",
    query: { limit: QUESTIONS_PAGE_SIZE, offset: 0, super_category: "Quant" },
    selfTestQuery: { limit: 1 },
  },
  psQuizGroup: {
    path: "/ps/quizgroup/{slug}/",
    description: "Quiz group {title,slug,body,quizzes:[quiz]}",
    verified: true,
    expect: "object",
    sampleParams: { slug: "gre-mini-exams" },
  },
  psQuizSuperGroup: {
    path: "/ps/quizsupergroup/{slug}/",
    description: "Quiz super group {title,slug,body,quiz_groups:[{quizzes}]}",
    verified: true,
    expect: "object",
    sampleParams: { slug: "timed-gre-quant-sections" },
  },
  sbStats: { path: "/sb/stats/me/", description: "Skill-building (verbal drill) stats keyed by drill kind", verified: true, expect: "object" },
  studyPlans: {
    path: "/studyplans/",
    description: "Paginated plans + modules (flags.planRole/parentSlug/moduleIndex)",
    verified: true,
    expect: "paginated",
    query: { limit: 100 },
  },
  studyPlan: {
    path: "/studyplans/{slug}/",
    description: "Study plan/module with units[{id,title,done,...}]",
    verified: true,
    expect: "object",
    sampleParams: { slug: DEFAULT_STUDY_PLAN },
  },
  classesUpcoming: { path: "/classes/upcoming/", description: "Upcoming classes (paginated)", verified: true, expect: "paginated" },
} satisfies Record<string, EndpointDef>;

export type EndpointKey = keyof typeof ENDPOINTS;

/**
 * Former guesses that the live probe showed to be 404 / frontend-only routes.
 * Do not call them: /quizzes/collection/, /quizzes/quiz-group/, /quizzes/quiz/,
 * /ps/quiz/{slug}/ (404 for diagnostic slugs), /practice/sectional-tests/ (page 404).
 * Unverified and dropped: /sb/pertype/{type}/, /content/content/{id}/.
 */
export const BROKEN_ENDPOINTS = ["/quizzes/collection/", "/quizzes/quiz-group/", "/quizzes/quiz/", "/ps/quiz/{slug}/", "/practice/sectional-tests/"] as const;

/** Quiz sources aggregated by get_quiz_results / list_completed_items / diagnostics (all verified). */
export interface QuizSource {
  kind: "quizgroup" | "quizsupergroup";
  slug: string;
  label: string;
  section: "quant" | "verbal" | "mixed";
}
export const QUIZ_SOURCES: readonly QuizSource[] = [
  { kind: "quizgroup", slug: "gre-mini-exams", label: "GRE Mini Exams", section: "mixed" },
  { kind: "quizsupergroup", slug: "timed-gre-quant-sections", label: "Timed GRE Quant Sections", section: "quant" },
  { kind: "quizsupergroup", slug: "timed-gre-verbal-sections", label: "Timed GRE Verbal Sections", section: "verbal" },
];

/**
 * raw_get allowlist: only GET paths starting with one of these prefixes are
 * permitted. Deliberately excludes write-ish paths (solve/action/done/crud...).
 */
export const RAW_GET_ALLOWED_PREFIXES = [
  "/authentication/me/",
  "/ps/stats/",
  "/ps/questions/",
  "/ps/question-counts/",
  "/ps/question-tags/",
  "/ps/quizgroup/",
  "/ps/quizsupergroup/",
  "/sb/stats/",
  "/studyplans/",
  "/classes/upcoming/",
];

/** Path fragments that are never allowed through raw_get, even under an allowed prefix. */
export const RAW_GET_DENY_FRAGMENTS = [
  "/solve/",
  "/action/",
  "/done/",
  "/reset_progress/",
  "/feedback/",
  "/emotion/",
  "/crud/",
  "/submit/",
  "/generate/",
  "/random/",
];

/** Section classification for tags/topics (used when the API lacks a section field). */
export const QUANT_KEYWORDS = [
  "quant", "math", "algebra", "arithmetic", "geometry", "data", "statistics", "probability",
  "percent", "ratio", "number", "integer", "fraction", "exponent", "inequal", "equation",
  "coordinate", "circle", "triangle", "polygon", "rate", "work", "mixture", "interest",
  "combinator", "permutation", "sequence", "function", "qc", "quantitative comparison",
  "mean", "median", "standard deviation", "remainder", "prime", "divisib",
];
export const VERBAL_KEYWORDS = [
  "verbal", "text completion", "tc", "sentence equivalence", "se", "reading", "rc",
  "vocab", "critical reasoning", "cr", "paragraph", "passage", "argument", "word",
];
export const AWA_KEYWORDS = ["awa", "essay", "issue", "analytical writing"];
