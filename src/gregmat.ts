/** Data-access layer shared by tools and the self-test. Never throws: returns {ok,data}|{ok:false,error}. */
import { GregmatClient } from "./api.js";
import { ENDPOINTS, QUESTIONS_PAGE_SIZE, QUIZ_SOURCES, QuizSource, SUPER_CATEGORIES, cacheTtlMs, defaultStudyPlan } from "./config.js";
import { ToolError, toToolError } from "./errors.js";
import {
  PlanSummary, Profile, Question, Quiz, SkillStat, StudyModule, describeShape, isObj, normalizePlanSummary, normalizeProfile,
  normalizeQuestion, normalizeQuiz, normalizeSbStats, normalizeStudyModule, pickNum,
} from "./normalize.js";

export type Fetched<T> = { ok: true; data: T; endpoint: string } | { ok: false; error: ToolError };

export async function attempt<T>(endpoint: string, fn: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, data: await fn(), endpoint };
  } catch (e) {
    return { ok: false, error: toToolError(e, endpoint) };
  }
}

// --- profile ---------------------------------------------------------------
export function fetchProfile(c: GregmatClient): Promise<Fetched<{ profile: Profile; raw_shape: unknown }>> {
  return attempt(ENDPOINTS.me.path, async () => {
    const r = await c.getEndpoint("me");
    return { profile: normalizeProfile(r.data), raw_shape: describeShape(r.data) };
  });
}

// --- site totals / skill building -------------------------------------------
export interface SiteTotals {
  quant: number | null;
  verbal: number | null;
  mini_exams: number | null;
}
export function fetchSiteTotals(c: GregmatClient): Promise<Fetched<SiteTotals>> {
  return attempt(ENDPOINTS.psStats.path, async () => {
    const d = (await c.getEndpoint("psStats")).data;
    return { quant: pickNum(d, ["quant"]), verbal: pickNum(d, ["verbal"]), mini_exams: pickNum(d, ["mini_exams"]) };
  });
}

export function fetchSkillStats(c: GregmatClient): Promise<Fetched<SkillStat[]>> {
  return attempt(ENDPOINTS.sbStats.path, async () => normalizeSbStats((await c.getEndpoint("sbStats")).data));
}

/** Site-wide topic totals: tag slug → count (from /ps/question-counts/?super_category=Quant). */
export function fetchTagCounts(c: GregmatClient, superCategory = "Quant"): Promise<Fetched<Record<string, number>>> {
  return attempt(ENDPOINTS.psQuestionCounts.path, async () => {
    const d = (await c.getEndpoint("psQuestionCounts", undefined, { super_category: superCategory })).data;
    const tags = isObj(d) && isObj(d.tags) ? d.tags : {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(tags)) if (typeof v === "number") out[k] = v;
    return out;
  });
}

// --- questions (cached ~5 min in memory) ------------------------------------
export interface QuestionsData {
  questions: Question[];
  by_category_reported: Record<string, number | null>;
  warnings: string[];
  fetched_at: string;
  from_cache: boolean;
}

const questionCache = new WeakMap<GregmatClient, { at: number; promise: Promise<Fetched<QuestionsData>> }>();

/** All GRE questions with the user's per-question attempts. Cached per client for GREGMAT_CACHE_TTL_MS (default 5 min). */
export function fetchQuestions(c: GregmatClient, opts: { refresh?: boolean } = {}): Promise<Fetched<QuestionsData>> {
  const hit = questionCache.get(c);
  const ttl = cacheTtlMs();
  if (hit && !opts.refresh && Date.now() - hit.at < ttl) {
    return hit.promise.then((r) => (r.ok ? { ...r, data: { ...r.data, from_cache: true } } : r));
  }
  const promise = loadQuestions(c);
  questionCache.set(c, { at: Date.now(), promise });
  // Never cache failures.
  promise.then((r) => {
    if (!r.ok && questionCache.get(c)?.promise === promise) questionCache.delete(c);
  });
  return promise;
}

async function loadQuestions(c: GregmatClient): Promise<Fetched<QuestionsData>> {
  const endpoint = ENDPOINTS.psQuestions.path;
  const warnings: string[] = [];
  const reported: Record<string, number | null> = {};
  const questions: Question[] = [];
  let firstError: ToolError | null = null;
  const results = await Promise.all(
    SUPER_CATEGORIES.map((cat) =>
      attempt(endpoint, async () => {
        const p = await c.paginate(endpoint, { super_category: cat }, { pageSize: QUESTIONS_PAGE_SIZE, maxPages: 15, maxItems: 5000 });
        return { cat, p };
      }),
    ),
  );
  for (const r of results) {
    if (!r.ok) {
      firstError ??= r.error;
      warnings.push(`${endpoint}: ${r.error.error}`);
      continue;
    }
    reported[r.data.cat] = r.data.p.total;
    if (r.data.p.truncated) warnings.push(`${r.data.cat}: fetched ${r.data.p.items.length} of ${r.data.p.total ?? "?"} questions`);
    for (const it of r.data.p.items) if (isObj(it)) questions.push(normalizeQuestion(it));
  }
  if (results.every((r) => !r.ok) && firstError) return { ok: false, error: firstError };
  return { ok: true, endpoint, data: { questions, by_category_reported: reported, warnings, fetched_at: new Date().toISOString(), from_cache: false } };
}

// --- quizzes ----------------------------------------------------------------
export interface QuizzesData {
  quizzes: Quiz[];
  sources: { slug: string; label: string; endpoint: string; quizzes: number; ok: boolean; error?: string }[];
}

function quizSourcePath(s: QuizSource): "psQuizGroup" | "psQuizSuperGroup" {
  return s.kind === "quizgroup" ? "psQuizGroup" : "psQuizSuperGroup";
}

export async function fetchQuizzes(c: GregmatClient, only?: { source?: string }): Promise<Fetched<QuizzesData>> {
  const sources = QUIZ_SOURCES.filter((s) => !only?.source || s.slug === only.source);
  const quizzes: Quiz[] = [];
  const meta: QuizzesData["sources"] = [];
  const errors: ToolError[] = [];
  await Promise.all(
    sources.map(async (s) => {
      const key = quizSourcePath(s);
      const path = ENDPOINTS[key].path.replace("{slug}", s.slug);
      const r = await attempt(path, () => c.getEndpoint(key, { slug: s.slug }));
      if (!r.ok) {
        errors.push(r.error);
        meta.push({ slug: s.slug, label: s.label, endpoint: path, quizzes: 0, ok: false, error: r.error.error });
        return;
      }
      const d = r.data.data;
      const found: Quiz[] = [];
      const add = (list: unknown, group: string | null) => {
        if (!Array.isArray(list)) return;
        for (const q of list) if (isObj(q)) found.push(normalizeQuiz(q, { source: s.slug, group, section: s.section === "mixed" ? undefined : s.section }));
      };
      if (isObj(d)) {
        add(d.quizzes, typeof d.title === "string" ? d.title : s.label);
        if (Array.isArray(d.quiz_groups)) {
          for (const g of d.quiz_groups) if (isObj(g)) add(g.quizzes, typeof g.title === "string" ? g.title : null);
        }
      }
      quizzes.push(...found);
      meta.push({ slug: s.slug, label: s.label, endpoint: path, quizzes: found.length, ok: true });
    }),
  );
  if (errors.length === sources.length && errors.length > 0) return { ok: false, error: errors[0] };
  meta.sort((a, b) => a.slug.localeCompare(b.slug));
  return { ok: true, endpoint: "/ps/quizgroup|quizsupergroup/", data: { quizzes, sources: meta } };
}

// --- study plans ------------------------------------------------------------
export function fetchPlanList(c: GregmatClient): Promise<Fetched<PlanSummary[]>> {
  return attempt(ENDPOINTS.studyPlans.path, async () => {
    const p = await c.paginate(ENDPOINTS.studyPlans.path, { limit: 100 }, { pageSize: 100, maxPages: 10 });
    return p.items.map(normalizePlanSummary).filter((x): x is PlanSummary => !!x);
  });
}

export interface PlanData {
  slug: string;
  title: string | null;
  modules: StudyModule[];
  warnings: string[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Gather all modules of a parent plan (modules are the plans with flags.parentSlug == slug, ordered by moduleIndex). */
export async function fetchPlan(c: GregmatClient, slug: string, list: PlanSummary[]): Promise<Fetched<PlanData>> {
  const path = ENDPOINTS.studyPlan.path.replace("{slug}", slug);
  return attempt(path, async () => {
    const warnings: string[] = [];
    const parent = list.find((p) => p.slug === slug);
    const modules = list
      .filter((p) => p.parentSlug === slug)
      .sort((a, b) => (a.moduleIndex ?? 0) - (b.moduleIndex ?? 0));
    const targets = modules.length ? modules.map((m) => ({ slug: m.slug, index: m.moduleIndex })) : [{ slug, index: null as number | null }];
    const loaded = await mapLimit(targets, 5, async (t) => {
      const r = await attempt(ENDPOINTS.studyPlan.path.replace("{slug}", t.slug), () => c.getEndpoint("studyPlan", { slug: t.slug }));
      if (!r.ok) {
        warnings.push(`${t.slug}: ${r.error.error}`);
        return null;
      }
      return normalizeStudyModule(r.data.data, { slug: t.slug, index: t.index });
    });
    const ok = loaded.filter((m): m is StudyModule => !!m);
    if (ok.length === 0) throw new Error(warnings[0] ?? `study plan ${slug} not found`);
    return { slug, title: parent?.title ?? ok[0].title, modules: ok, warnings };
  });
}

export function defaultPlan(): string {
  return defaultStudyPlan();
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
