/**
 * src/config.ts — THE ONLY place for GregMAT base URLs, endpoint paths, login
 * body variants, page URLs and Playwright selectors.
 *
 * Everything marked `verified: false` / `// GUESS:` was inferred from public JS
 * bundles without logging in. If `npm run check` prints
 * "NEEDS UPDATE: src/config.ts <key>", fix the matching entry here.
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
// Auth
// ---------------------------------------------------------------------------
export const AUTH = {
  /** CONFIRMED: sidebase local provider signIn endpoint. */
  loginPath: { path: "/authentication/sidebaseMultiplexedLogin/", verified: true },
  /** CONFIRMED: session endpoint. */
  mePath: { path: "/authentication/me/", verified: true },
  /** CONFIRMED: refreshOnlyToken refresh endpoint, body {refresh}. */
  refreshPath: { path: "/authentication/auth/jwt/refresh/", verified: true },
  /** CONFIRMED: response token pointers. */
  accessTokenField: "access",
  refreshTokenField: "refresh",
  /** CONFIRMED: browser cookie holding the access token. */
  cookieName: "piniaAccess",
  cookieDomain: "gregmat.com",
  /** Access token max age in the browser (7 days). */
  cookieMaxAgeSeconds: 7 * 24 * 3600,
  // GUESS: request body shape for sign-in. Tried in order; the first that
  // returns an `access` token wins and is reported by `npm run check`.
  loginBodyVariants: [
    { name: "email", verified: false, build: (email: string, password: string) => ({ email, password }) },
    { name: "username", verified: false, build: (email: string, password: string) => ({ username: email, password }) },
  ],
} as const;

// ---------------------------------------------------------------------------
// Endpoints (GET only — this server is read-only against GregMAT)
// ---------------------------------------------------------------------------
export type ExpectShape = "object" | "list" | "paginated" | "any";

export interface EndpointDef {
  /** Path relative to API_BASE; `{name}` placeholders are filled from params. */
  path: string;
  description: string;
  verified: boolean;
  /** GUESS of the response shape, used by the self-test to flag mismatches. */
  expect: ExpectShape;
  /** Default query params. */
  query?: Record<string, string | number | boolean>;
  /** Params used by the self-test when the path has placeholders. */
  sampleParams?: Record<string, string>;
  /** Skip in the self-test (e.g. needs an id we don't have). */
  skipSelfTest?: boolean;
}

export const ENDPOINTS = {
  me: { path: "/authentication/me/", description: "Current user profile/session", verified: true, expect: "object" },
  // GUESS: shape unknown ("getProblemsCount" in bundle).
  psStats: { path: "/ps/stats/", description: "Problem-solving stats", verified: false, expect: "object" },
  // GUESS: paginated DRF list with `results`; per-user solved flags assumed.
  psQuestions: {
    path: "/ps/questions/",
    description: "Problem-solving questions (paginated, may include per-user status)",
    verified: false,
    expect: "paginated",
    query: { limit: 100, offset: 0, include_unlisted: "false" },
  },
  // GUESS: shape unknown.
  psQuestionCounts: { path: "/ps/question-counts/", description: "Question counts", verified: false, expect: "any" },
  // GUESS: shape unknown (list of tags?).
  psQuestionTags: { path: "/ps/question-tags/", description: "Question tags/topics", verified: false, expect: "any" },
  // GUESS: quiz group / super group / quiz by slug.
  psQuizGroup: { path: "/ps/quizgroup/{slug}/", description: "Quiz group by slug", verified: false, expect: "object", skipSelfTest: true },
  psQuizSuperGroup: { path: "/ps/quizsupergroup/{slug}/", description: "Quiz super group by slug", verified: false, expect: "object", skipSelfTest: true },
  psQuiz: { path: "/ps/quiz/{slug}/", description: "Quiz by slug (may include attempts/score)", verified: false, expect: "object", skipSelfTest: true },
  // GUESS: quizzes app listings.
  quizCollection: { path: "/quizzes/collection/", description: "Quiz collections", verified: false, expect: "any" },
  quizGroups: { path: "/quizzes/quiz-group/", description: "Quiz groups", verified: false, expect: "any" },
  quizzes: { path: "/quizzes/quiz/", description: "Quizzes (may include user attempts)", verified: false, expect: "any" },
  // GUESS: skill-building stats.
  sbStats: { path: "/sb/stats/me/", description: "Skill-building stats for current user", verified: false, expect: "object" },
  sbPerType: { path: "/sb/pertype/{type}/", description: "Skill-building stats per exercise type", verified: false, expect: "any", skipSelfTest: true },
  // GUESS: study plan detail with units + done flags. Note: the frontend page
  // is /study-plans/<slug>/ but the API path observed is studyplans/<slug>/.
  studyPlan: {
    path: "/studyplans/{slug}/",
    description: "Study plan with units and done flags",
    verified: false,
    expect: "object",
    sampleParams: { slug: DEFAULT_STUDY_PLAN },
  },
  classesUpcoming: { path: "/classes/upcoming/", description: "Upcoming classes", verified: false, expect: "any" },
  content: { path: "/content/content/{id}/", description: "Content item (video/lesson) by id", verified: false, expect: "object", skipSelfTest: true },
} satisfies Record<string, EndpointDef>;

export type EndpointKey = keyof typeof ENDPOINTS;

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
  "/ps/question/",
  "/ps/quizgroup/",
  "/ps/quizsupergroup/",
  "/ps/quiz/",
  "/quizzes/",
  "/sb/stats/",
  "/sb/pertype/",
  "/studyplans/",
  "/classes/upcoming/",
  "/classes/upcomingBrief/",
  "/classes/recentClasses/",
  "/content/content/",
  "/practice/",
  "/mountains/",
  "/essays/prompts/",
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

// ---------------------------------------------------------------------------
// Pages + selectors for the optional Playwright scraper.
// ---------------------------------------------------------------------------
export const PAGES = {
  // GUESS: sectional tests page lists tests and (when logged in) scores.
  sectionalTests: { url: `${SITE_BASE}/practice/sectional-tests/`, verified: false },
  // GUESS: study plan page.
  studyPlan: { url: `${SITE_BASE}/study-plans/{slug}/`, verified: false },
  // GUESS: problem solving landing page.
  problemSolving: { url: `${SITE_BASE}/practice/custom-practice/`, verified: false },
} as const;

export const SELECTORS = {
  // GUESS: generic selectors; tighten after inspecting the logged-in DOM.
  sectionalTestRow: { css: "table tr, [class*='test'] li, [class*='card']", verified: false },
  pageMain: { css: "main, #__nuxt", verified: false },
} as const;

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

/** GUESS: high-yield GRE topics for "unattempted high-yield" suggestions. */
export const HIGH_YIELD_TOPICS = {
  quant: [
    "Quantitative Comparison", "Percents", "Ratios", "Number Properties", "Exponents",
    "Algebra", "Inequalities", "Coordinate Geometry", "Triangles", "Circles",
    "Data Interpretation", "Statistics", "Probability", "Combinatorics", "Rates & Work",
  ],
  verbal: [
    "Text Completion", "Sentence Equivalence", "Reading Comprehension",
    "Critical Reasoning", "Paragraph Argument", "Vocabulary",
  ],
};
