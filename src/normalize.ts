/**
 * Mappers from GregMAT JSON (shapes verified in docs/API-FINDINGS.md) to normalized types.
 * Unknown quiz-attempt shapes are mapped defensively and returned with their `raw` object.
 */
import { AWA_KEYWORDS, QUANT_KEYWORDS, VERBAL_KEYWORDS } from "./config.js";

export type Section = "quant" | "verbal" | "awa" | "unknown";
type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** First present (non-null, non-empty) value among candidate keys; supports dotted paths. */
export function pick(o: unknown, keys: string[]): unknown {
  if (!isObj(o)) return undefined;
  for (const k of keys) {
    let cur: unknown = o;
    for (const part of k.split(".")) cur = isObj(cur) ? cur[part] : undefined;
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}
export function pickStr(o: unknown, keys: string[]): string | null {
  const v = pick(o, keys);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (isObj(v)) return pickStr(v, ["name", "title", "slug", "label"]);
  return null;
}
export function pickNum(o: unknown, keys: string[]): number | null {
  const v = pick(o, keys);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
export function pickBool(o: unknown, keys: string[]): boolean | null {
  const v = pick(o, keys);
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "true" || v === "1" || v === "yes") return true;
  if (v === 0 || v === "false" || v === "0" || v === "no") return false;
  return null;
}
export function pickDate(o: unknown, keys: string[] = DATE_KEYS): string | null {
  const v = pick(o, keys);
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

const DATE_KEYS = [
  "solved_at", "solvedAt", "completed_at", "completedAt", "done_at", "doneAt", "attempted_at",
  "last_attempt", "lastAttempt", "last_attempted", "submitted_at", "date", "updated_at", "updatedAt",
  "created_at", "createdAt", "timestamp", "user_status.date", "progress.date",
];

/** Locate the main array in a response: the array itself, `results`, `data`, `items`, or the largest array field. */
export function findArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isObj(raw)) return [];
  for (const k of ["results", "data", "items", "questions", "quizzes", "units", "objects"]) {
    if (Array.isArray(raw[k])) return raw[k] as unknown[];
  }
  let best: unknown[] = [];
  for (const v of Object.values(raw)) if (Array.isArray(v) && v.length > best.length) best = v;
  return best;
}

/** Short structural description of an unknown value (keys, array lengths) for debugging. */
export function describeShape(raw: unknown, depth = 1): unknown {
  if (Array.isArray(raw)) return { type: "array", length: raw.length, first: raw.length ? describeShape(raw[0], depth - 1) : null };
  if (isObj(raw)) {
    if (depth < 0) return "object";
    const out: Obj = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = Array.isArray(v) ? `array(${v.length})` : isObj(v) ? (depth > 0 ? describeShape(v, depth - 1) : "object") : typeof v;
    }
    return out;
  }
  return typeof raw;
}

function matchesAny(text: string, words: string[]): boolean {
  return words.some((w) => (w.length <= 3 ? new RegExp(`\\b${w}\\b`, "i").test(text) : text.includes(w)));
}

/** Classify a section from free text (section field, tags, title, slug). */
export function classifySection(...texts: (string | null | undefined)[]): Section {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return "unknown";
  if (matchesAny(t, AWA_KEYWORDS)) return "awa";
  const q = matchesAny(t, QUANT_KEYWORDS);
  const v = matchesAny(t, VERBAL_KEYWORDS);
  if (q && !v) return "quant";
  if (v && !q) return "verbal";
  if (q && v) {
    // Explicit section words win.
    if (/\b(quant|quantitative|math)\b/.test(t)) return "quant";
    if (/\bverbal\b/.test(t)) return "verbal";
  }
  return "unknown";
}

export function normalizeSection(v: unknown): Section {
  if (typeof v !== "string") return "unknown";
  const s = v.toLowerCase();
  if (s.startsWith("q") || s.includes("math")) return "quant";
  if (s.startsWith("v")) return "verbal";
  if (s.includes("awa") || s.includes("writ") || s.includes("essay")) return "awa";
  return classifySection(s);
}

// ---------------------------------------------------------------------------
// Profile (/authentication/me/ → {user:{email, first_name, is_plus, ...}})
// ---------------------------------------------------------------------------
export interface Profile {
  id: string | null;
  name: string | null;
  email: string | null;
  is_plus: boolean | null;
  subscription_status: string | null;
  current_period_end: string | null;
  subscriptions: unknown;
  per_site_access: unknown;
}

export function normalizeProfile(raw: unknown): Profile {
  const u = isObj(raw) && isObj(raw.user) ? raw.user : raw;
  const first = pickStr(u, ["first_name", "firstName"]);
  const last = pickStr(u, ["last_name", "lastName"]);
  return {
    id: pickStr(u, ["id", "pk", "uuid", "user_id"]),
    name: pickStr(u, ["name", "full_name"]) ?? ([first, last].filter(Boolean).join(" ") || null),
    email: pickStr(u, ["email"]),
    is_plus: pickBool(u, ["is_plus", "is_subscribed", "isSubscribed"]),
    subscription_status: pickStr(u, ["stripe_subscription_status", "subscription_status"]),
    current_period_end: pickDate(u, ["current_period_end"]),
    subscriptions: pick(u, ["subscriptions", "subscription"]) ?? null,
    per_site_access: pick(u, ["per_site_access"]) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Problem-solving questions (/ps/questions/)
// ---------------------------------------------------------------------------
export type QuestionStatus = "solved" | "attempted" | "todo" | "unknown";

export interface Attempt {
  answered_at: string | null;
  correct: boolean | null;
  first: boolean;
  score: number | null;
  score_denom: number | null;
}

export interface QuestionTag {
  id: string | null;
  slug: string | null;
  title: string;
  type: string | null;
}

export interface Question {
  id: string | null;
  slug: string | null;
  title: string | null;
  type: string | null;
  difficulty: string | null;
  super_category: string | null;
  section: Section;
  status: QuestionStatus;
  /** Top-level category (first_tlc), e.g. Arithmetic, Algebra, Text Completion. */
  category: string | null;
  tags: QuestionTag[];
  attempts: Attempt[];
  /** Correctness of the first attempt (site's accuracy convention); null when not attempted. */
  first_attempt_correct: boolean | null;
  last_attempt_at: string | null;
  bookmarked: boolean;
}

export function normalizeAttempt(raw: unknown): Attempt {
  return {
    answered_at: pickDate(raw, ["answered_at", "created_at"]),
    correct: pickBool(raw, ["correct"]),
    first: pickBool(raw, ["first"]) === true,
    score: pickNum(raw, ["score"]),
    score_denom: pickNum(raw, ["score_denom"]),
  };
}

export function normalizeQuestion(raw: unknown): Question {
  const st = (pickStr(raw, ["status"]) ?? "").toLowerCase();
  const attemptsRaw = pick(raw, ["user_answer_attempts"]);
  const attempts = (Array.isArray(attemptsRaw) ? attemptsRaw : []).filter(isObj).map(normalizeAttempt);
  attempts.sort((a, b) => (a.answered_at ?? "").localeCompare(b.answered_at ?? ""));
  const firstAttempt = attempts.find((a) => a.first) ?? null;

  let status: QuestionStatus = "unknown";
  if (st === "solved") status = "solved";
  else if (st === "attempted") status = "attempted";
  else if (st === "todo" || st === "") status = st === "todo" ? "todo" : attempts.length ? "attempted" : "unknown";
  if (status === "todo" && attempts.length) status = "attempted";

  const tagsRaw = pick(raw, ["tags"]);
  const tags: QuestionTag[] = (Array.isArray(tagsRaw) ? tagsRaw : []).filter(isObj).map((t) => ({
    id: pickStr(t, ["id"]),
    slug: pickStr(t, ["slug"]),
    title: pickStr(t, ["title", "name", "slug"]) ?? "(untitled)",
    type: pickStr(t, ["type"]),
  }));

  const superCat = pickStr(raw, ["super_category"]);
  return {
    id: pickStr(raw, ["id"]),
    slug: pickStr(raw, ["slug"]),
    title: pickStr(raw, ["title"]),
    type: pickStr(raw, ["type"]),
    difficulty: pickStr(raw, ["difficulty"]),
    super_category: superCat,
    section: normalizeSection(superCat),
    status,
    category: pickStr(raw, ["first_tlc"]),
    tags,
    attempts,
    first_attempt_correct: firstAttempt ? firstAttempt.correct : null,
    last_attempt_at: attempts.length ? attempts[attempts.length - 1].answered_at : null,
    bookmarked: pickBool(raw, ["bookmarked"]) === true,
  };
}

/** Topic tags (type "topic") of a question. */
export function topicTags(q: Question): QuestionTag[] {
  return q.tags.filter((t) => (t.type ?? "topic") === "topic");
}

// ---------------------------------------------------------------------------
// Quizzes (/ps/quizgroup/{slug}/, /ps/quizsupergroup/{slug}/)
// ---------------------------------------------------------------------------
export interface QuizAttempt {
  score: number | null;
  max_score: number | null;
  percent: number | null;
  date: string | null;
  /** The element as returned (shape was unknown when written), for transparency. */
  raw: unknown;
}

export interface Quiz {
  id: string | null;
  slug: string | null;
  title: string | null;
  group: string | null;
  source: string;
  section: Section;
  minutes: number | null;
  max_score: number | null;
  mean_score: number | null;
  acceptance: number | null;
  plus_only: boolean;
  attempts: QuizAttempt[];
}

const ATTEMPT_SCORE_KEYS = ["score", "raw_score", "total_score", "correct", "num_correct", "correct_count"];
const ATTEMPT_MAX_KEYS = ["score_denom", "max_score", "total", "num_questions", "total_questions", "out_of"];
const ATTEMPT_DATE_KEYS = ["finished_at", "completed_at", "answered_at", "submitted_at", "ended_at", "created_at", "started_at", "date"];

/** Element shape of quiz `attempts` was unknown (empty in the probe): map defensively. */
export function normalizeQuizAttempt(raw: unknown, quizMax: number | null): QuizAttempt {
  const score = pickNum(raw, ATTEMPT_SCORE_KEYS);
  const max = pickNum(raw, ATTEMPT_MAX_KEYS) ?? quizMax;
  let percent = pickNum(raw, ["percent", "percentage", "accuracy"]);
  if (percent === null && score !== null && max) percent = Math.round((score / max) * 1000) / 10;
  return { score, max_score: max, percent, date: pickDate(raw, ATTEMPT_DATE_KEYS), raw };
}

export function normalizeQuiz(raw: unknown, ctx: { source: string; group?: string | null; section?: Section }): Quiz {
  const max = pickNum(raw, ["max_score"]);
  const attemptsRaw = pick(raw, ["attempts"]);
  const title = pickStr(raw, ["title"]);
  const sc = pickStr(raw, ["super_category"]);
  let section = sc ? normalizeSection(sc) : "unknown";
  if (section === "unknown") section = ctx.section ?? classifySection(title);
  return {
    id: pickStr(raw, ["id"]),
    slug: pickStr(raw, ["slug"]),
    title,
    group: ctx.group ?? null,
    source: ctx.source,
    section,
    minutes: pickNum(raw, ["minutes"]),
    max_score: max,
    mean_score: pickNum(raw, ["mean_score"]),
    acceptance: pickNum(raw, ["acceptance"]),
    plus_only: pickBool(raw, ["plus_only"]) === true,
    attempts: (Array.isArray(attemptsRaw) ? attemptsRaw : []).map((a) => normalizeQuizAttempt(a, max)),
  };
}

// ---------------------------------------------------------------------------
// Study plans (/studyplans/, /studyplans/{slug}/)
// ---------------------------------------------------------------------------
export interface PlanSummary {
  slug: string;
  title: string | null;
  role: "plan" | "module" | "unknown";
  parentSlug: string | null;
  moduleIndex: number | null;
  plusOnly: boolean;
}

export function normalizePlanSummary(raw: unknown): PlanSummary | null {
  const slug = pickStr(raw, ["slug"]);
  if (!slug) return null;
  const flags = isObj(raw) && isObj(raw.flags) ? raw.flags : {};
  const role = flags.planRole === "plan" || flags.planRole === "module" ? flags.planRole : "unknown";
  return {
    slug,
    title: pickStr(raw, ["title"]),
    role,
    parentSlug: pickStr(flags, ["parentSlug"]),
    moduleIndex: pickNum(flags, ["moduleIndex"]),
    plusOnly: pickBool(raw, ["plus_only"]) === true,
  };
}

export interface StudyUnit {
  id: string | null;
  title: string | null;
  done: boolean;
  plus_only: boolean;
  module_slug: string;
  module_title: string | null;
  module_index: number | null;
  /** First lines of the left-hand side (links/text), HTML stripped. */
  preview: string;
  date: string | null;
}

export interface StudyModule {
  slug: string;
  title: string | null;
  index: number | null;
  units: StudyUnit[];
}

/** Strip tags/entities from an HTML snippet; keep link text and line breaks. */
export function stripHtml(html: unknown, maxLines = 4, maxChars = 400): string {
  if (typeof html !== "string") return "";
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return lines.slice(0, maxLines).join("\n").slice(0, maxChars);
}

export function normalizeStudyModule(raw: unknown, fallback: { slug: string; index?: number | null }): StudyModule {
  const slug = pickStr(raw, ["slug"]) ?? fallback.slug;
  const title = pickStr(raw, ["title"]);
  const flags = isObj(raw) && isObj(raw.flags) ? raw.flags : {};
  const index = pickNum(flags, ["moduleIndex"]) ?? fallback.index ?? null;
  const unitsRaw = isObj(raw) && Array.isArray(raw.units) ? raw.units : [];
  const units = unitsRaw.filter(isObj).map((u) => ({
    id: pickStr(u, ["id"]),
    title: pickStr(u, ["title"]),
    done: u.done === true,
    plus_only: pickBool(u, ["plus_only"]) === true,
    module_slug: slug,
    module_title: title,
    module_index: index,
    preview: stripHtml(u.left_side) || stripHtml(u.description),
    date: pickDate(u, ["done_at", "completed_at"]),
  }));
  return { slug, title, index, units };
}

// ---------------------------------------------------------------------------
// Skill-building stats (/sb/stats/me/)
// ---------------------------------------------------------------------------
export interface SkillStat {
  kind: string;
  total_questions: number | null;
  total_attempts: number | null;
  total_first_attempts: number | null;
  total_correct_first_attempts: number | null;
  first_attempt_accuracy: number | null;
}

export function normalizeSbStats(raw: unknown): SkillStat[] {
  if (!isObj(raw)) return [];
  return Object.entries(raw)
    .filter(([, v]) => isObj(v))
    .map(([kind, v]) => {
      const fa = pickNum(v, ["total_first_attempts"]);
      const ca = pickNum(v, ["total_correct_first_attempts"]);
      return {
        kind,
        total_questions: pickNum(v, ["total_questions"]),
        total_attempts: pickNum(v, ["total_attempts"]),
        total_first_attempts: fa,
        total_correct_first_attempts: ca,
        first_attempt_accuracy: fa ? Math.round(((ca ?? 0) / fa) * 1000) / 10 : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Stats (ps/stats, sb/stats/me): flatten numeric leaves.
// ---------------------------------------------------------------------------
export function flattenNumbers(raw: unknown, prefix = "", out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (depth > 4) return out;
  if (typeof raw === "number") {
    out[prefix || "value"] = raw;
  } else if (Array.isArray(raw)) {
    raw.slice(0, 50).forEach((v, i) => {
      const label = isObj(v) ? pickStr(v, ["name", "type", "slug", "title", "tag"]) ?? String(i) : String(i);
      flattenNumbers(v, prefix ? `${prefix}.${label}` : label, out, depth + 1);
    });
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (k === "id" || k === "pk") continue;
      flattenNumbers(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates / streak
// ---------------------------------------------------------------------------
/** YYYY-MM-DD in local time. */
export function localDay(d: Date | string): string {
  const dt = typeof d === "string" ? (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date(d)) : d;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.UTC(+fromDay.slice(0, 4), +fromDay.slice(5, 7) - 1, +fromDay.slice(8, 10));
  const b = Date.UTC(+toDay.slice(0, 4), +toDay.slice(5, 7) - 1, +toDay.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

export function daysUntil(targetDay: string, now: Date = new Date()): number {
  return daysBetween(localDay(now), targetDay);
}

/**
 * Current streak: consecutive days with activity ending today (or yesterday,
 * if nothing logged yet today). Also returns the longest streak.
 */
export function computeStreak(dates: (string | null | undefined)[], now: Date = new Date()): {
  current: number;
  longest: number;
  active_days: number;
  last_activity: string | null;
} {
  const days = [...new Set(dates.filter((d): d is string => !!d).map((d) => localDay(d)))].sort();
  if (days.length === 0) return { current: 0, longest: 0, active_days: 0, last_activity: null };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = daysBetween(days[i - 1], days[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const today = localDay(now);
  const last = days[days.length - 1];
  let current = 0;
  const gap = daysBetween(last, today);
  if (gap === 0 || gap === 1) {
    current = 1;
    for (let i = days.length - 1; i > 0 && daysBetween(days[i - 1], days[i]) === 1; i--) current++;
  }
  return { current, longest, active_days: days.length, last_activity: last };
}
