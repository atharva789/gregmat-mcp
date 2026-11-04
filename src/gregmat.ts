/** Data-access layer shared by tools and the self-test. Never throws: returns {ok,data}|{ok:false,error}. */
import { GregmatClient } from "./api.js";
import { ENDPOINTS, EndpointKey } from "./config.js";
import { ToolError, toToolError } from "./errors.js";
import {
  Profile, Question, QuizResult, StudyPlan, describeShape, findArray, findQuizzes, flattenNumbers, isObj,
  normalizeProfile, normalizeQuestion, normalizeQuiz, normalizeStudyPlan,
} from "./normalize.js";

export type Fetched<T> = { ok: true; data: T; endpoint: string } | { ok: false; error: ToolError };

export async function attempt<T>(endpoint: string, fn: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, data: await fn(), endpoint };
  } catch (e) {
    return { ok: false, error: toToolError(e, endpoint) };
  }
}

export interface ProfileData {
  profile: Profile;
  raw_shape: unknown;
}
export function fetchProfile(c: GregmatClient): Promise<Fetched<ProfileData>> {
  return attempt(ENDPOINTS.me.path, async () => {
    const r = await c.getEndpoint("me");
    return { profile: normalizeProfile(r.data), raw_shape: describeShape(r.data) };
  });
}

export interface StatsData {
  numbers: Record<string, number>;
  raw: unknown;
}
export function fetchStats(c: GregmatClient, key: "psStats" | "sbStats" | "psQuestionCounts"): Promise<Fetched<StatsData>> {
  return attempt(ENDPOINTS[key].path, async () => {
    const r = await c.getEndpoint(key);
    return { numbers: flattenNumbers(r.data), raw: capRaw(r.data) };
  });
}

export interface QuestionsData {
  questions: Question[];
  total_reported: number | null;
  fetched: number;
  truncated: boolean;
  first_page_keys: string[];
  status_known: boolean;
}
export function fetchQuestions(c: GregmatClient, maxItems = 1500): Promise<Fetched<QuestionsData>> {
  const def = ENDPOINTS.psQuestions;
  return attempt(def.path, async () => {
    const p = await c.paginate(def.path, { ...def.query }, { maxItems, pageSize: Number(def.query.limit), maxPages: Math.ceil(maxItems / Number(def.query.limit)) + 1 });
    const questions = p.items.map(normalizeQuestion);
    return {
      questions,
      total_reported: p.total,
      fetched: questions.length,
      truncated: p.truncated,
      first_page_keys: p.firstPageKeys,
      status_known: questions.some((q) => q.status !== "unknown"),
    };
  });
}

export interface StudyPlanData {
  plan: StudyPlan;
  raw_shape: unknown;
}
export function fetchStudyPlan(c: GregmatClient, slug: string): Promise<Fetched<StudyPlanData>> {
  const path = ENDPOINTS.studyPlan.path.replace("{slug}", slug);
  return attempt(path, async () => {
    const r = await c.getEndpoint("studyPlan", { slug });
    return { plan: normalizeStudyPlan(r.data, slug), raw_shape: describeShape(r.data, 2) };
  });
}

export interface QuizzesData {
  source: string;
  quizzes: QuizResult[];
  raw_shape: unknown;
}
/** slug → single quiz; group → quiz group (falls back to super group); neither → /quizzes/quiz/ listing. */
export async function fetchQuizzes(c: GregmatClient, opts: { slug?: string; group?: string }): Promise<Fetched<QuizzesData>> {
  const one = async (key: EndpointKey, params?: Record<string, string>) => {
    const r = await c.getEndpoint(key, params);
    const list = key === "psQuiz" ? [r.data] : (() => {
      const q = findQuizzes(r.data);
      return q.length ? q : findArray(r.data);
    })();
    return { source: r.path, quizzes: list.filter(isObj).map(normalizeQuiz), raw_shape: describeShape(r.data, 2) };
  };
  if (opts.slug) return attempt(ENDPOINTS.psQuiz.path.replace("{slug}", opts.slug), () => one("psQuiz", { slug: opts.slug! }));
  if (opts.group) {
    const g = await attempt(ENDPOINTS.psQuizGroup.path.replace("{slug}", opts.group), () => one("psQuizGroup", { slug: opts.group! }));
    if (g.ok) return g;
    const sg = await attempt(ENDPOINTS.psQuizSuperGroup.path.replace("{slug}", opts.group), () => one("psQuizSuperGroup", { slug: opts.group! }));
    return sg.ok ? sg : g;
  }
  return attempt(ENDPOINTS.quizzes.path, () => one("quizzes"));
}

/** Cap huge raw payloads so tool output stays readable. */
export function capRaw(v: unknown, maxChars = 20000): unknown {
  try {
    const s = JSON.stringify(v);
    if (s === undefined || s.length <= maxChars) return v;
    return { truncated: true, original_chars: s.length, shape: describeShape(v, 2), preview: s.slice(0, maxChars) };
  } catch {
    return String(v);
  }
}
