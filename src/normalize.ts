/**
 * Defensive mappers from unknown GregMAT JSON to normalized types.
 * Response shapes are GUESSES — anything we can't map is passed through as `raw`
 * (or summarized) so the assistant can still read it.
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
// Profile
// ---------------------------------------------------------------------------
export interface Profile {
  id: string | null;
  name: string | null;
  email: string | null;
  username: string | null;
  subscription: unknown;
  is_subscribed: boolean | null;
  date_joined: string | null;
  other_fields: string[];
}

export function normalizeProfile(raw: unknown): Profile {
  const u = isObj(raw) && isObj(raw.user) ? { ...raw, ...raw.user } : raw;
  const first = pickStr(u, ["first_name", "firstName"]);
  const last = pickStr(u, ["last_name", "lastName"]);
  const name = pickStr(u, ["name", "full_name", "fullName", "display_name"]) ?? ([first, last].filter(Boolean).join(" ") || null);
  const subscription =
    pick(u, ["subscription", "subscriptions", "active_subscription", "tier", "plan", "membership", "subscription_tier"]) ?? null;
  const known = new Set([
    "id", "pk", "uuid", "name", "full_name", "first_name", "last_name", "email", "username", "subscription",
    "subscriptions", "active_subscription", "tier", "plan", "is_subscribed", "isSubscribed", "date_joined", "user",
  ]);
  return {
    id: pickStr(u, ["id", "pk", "uuid", "user_id"]),
    name,
    email: pickStr(u, ["email"]),
    username: pickStr(u, ["username"]),
    subscription: summarizeSubscription(subscription),
    is_subscribed: pickBool(u, ["is_subscribed", "isSubscribed", "is_premium", "premium", "has_subscription", "is_member"]),
    date_joined: pickDate(u, ["date_joined", "dateJoined", "created_at", "joined"]),
    other_fields: isObj(u) ? Object.keys(u).filter((k) => !known.has(k)) : [],
  };
}

function summarizeSubscription(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(summarizeSubscription);
  if (isObj(s)) {
    const out: Obj = {};
    for (const k of ["name", "tier", "slug", "status", "active", "is_active", "expires", "expires_at", "end_date", "current_period_end"]) {
      if (s[k] !== undefined) out[k] = isObj(s[k]) ? pickStr(s[k], ["name", "slug"]) : s[k];
    }
    return Object.keys(out).length ? out : s;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Problem-solving questions
// ---------------------------------------------------------------------------
export type QuestionStatus = "solved" | "attempted" | "unattempted" | "unknown";

export interface Question {
  id: string | null;
  slug: string | null;
  title: string | null;
  section: Section;
  tags: string[];
  difficulty: string | null;
  status: QuestionStatus;
  correct: boolean | null;
  date: string | null;
}

export function extractTags(o: unknown): string[] {
  const v = pick(o, ["tags", "question_tags", "topics", "topic", "tag", "categories", "category"]);
  const arr = Array.isArray(v) ? v : v !== undefined ? [v] : [];
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t === "string") out.push(t);
    else if (isObj(t)) {
      const s = pickStr(t, ["name", "title", "label", "slug", "tag"]);
      if (s) out.push(s);
    }
  }
  return [...new Set(out)];
}

export function normalizeQuestion(raw: unknown): Question {
  const status = pick(raw, ["user_status", "status", "progress", "user_progress", "solve_status", "state"]);
  const statusObj = isObj(status) ? status : null;
  const statusStr = typeof status === "string" ? status.toLowerCase() : null;

  let correct = pickBool(raw, ["correct", "is_correct", "isCorrect", "solved_correctly", "user_correct", "was_correct"]);
  if (correct === null && statusObj) correct = pickBool(statusObj, ["correct", "is_correct", "isCorrect"]);
  if (correct === null && statusStr) {
    if (/^(correct|right)$/.test(statusStr)) correct = true;
    else if (/^(incorrect|wrong)$/.test(statusStr)) correct = false;
  }

  const solvedFlag =
    pickBool(raw, ["solved", "is_solved", "isSolved", "done", "is_done", "completed", "user_solved"]) ??
    (statusObj ? pickBool(statusObj, ["solved", "done", "completed"]) : null);
  const attemptedFlag =
    pickBool(raw, ["attempted", "is_attempted", "isAttempted", "user_attempted", "seen"]) ??
    (statusObj ? pickBool(statusObj, ["attempted"]) : null);
  const attempts = pickNum(raw, ["attempts", "attempt_count", "num_attempts", "user_attempts"]);

  let qs: QuestionStatus = "unknown";
  if (solvedFlag === true || (statusStr && /solved|done|complete|correct/.test(statusStr) && !/un|not|incorrect/.test(statusStr))) qs = "solved";
  else if (attemptedFlag === true || correct !== null || (attempts !== null && attempts > 0) || (statusStr && /attempt|incorrect|wrong/.test(statusStr))) qs = "attempted";
  else if (solvedFlag === false || attemptedFlag === false || (statusStr && /unsolved|not|new|todo|unattempted/.test(statusStr)) || attempts === 0) qs = "unattempted";

  const tags = extractTags(raw);
  const title = pickStr(raw, ["title", "name", "question_title", "short_text"]);
  const slug = pickStr(raw, ["slug"]);
  const explicitSection = normalizeSection(pick(raw, ["section", "subject", "type", "question_type", "category"]));
  const section = explicitSection !== "unknown" ? explicitSection : classifySection(tags.join(" "), title, slug);

  return {
    id: pickStr(raw, ["id", "pk", "uuid"]),
    slug,
    title,
    section,
    tags,
    difficulty: pickStr(raw, ["difficulty", "level", "difficulty_level"]),
    status: qs,
    correct,
    date: pickDate(raw) ?? (statusObj ? pickDate(statusObj) : null),
  };
}

// ---------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------
export interface QuizResult {
  slug: string | null;
  title: string | null;
  section: Section;
  attempts: number | null;
  score: number | null;
  max_score: number | null;
  percent: number | null;
  completed: boolean | null;
  date: string | null;
}

export function normalizeQuiz(raw: unknown): QuizResult {
  const userBlock = pick(raw, ["user_result", "result", "user_attempt", "last_attempt", "best_attempt", "user_progress", "progress"]);
  const src = isObj(userBlock) ? { ...(raw as Obj), ...userBlock } : raw;
  const score = pickNum(src, ["score", "correct", "num_correct", "correct_count", "user_score", "best_score"]);
  const max = pickNum(src, ["max_score", "total", "num_questions", "question_count", "questions_count", "out_of", "total_questions"]);
  let percent = pickNum(src, ["percent", "percentage", "accuracy", "score_percent"]);
  if (percent === null && score !== null && max) percent = Math.round((score / max) * 1000) / 10;
  const attemptsArr = pick(raw, ["attempts", "user_attempts"]);
  const attempts = Array.isArray(attemptsArr) ? attemptsArr.length : pickNum(raw, ["attempts", "attempt_count", "num_attempts", "times_taken"]);
  const title = pickStr(raw, ["title", "name"]);
  const slug = pickStr(raw, ["slug"]);
  return {
    slug,
    title,
    section: normalizeSection(pick(raw, ["section", "subject"])) !== "unknown"
      ? normalizeSection(pick(raw, ["section", "subject"]))
      : classifySection(title, slug, extractTags(raw).join(" ")),
    attempts,
    score,
    max_score: max,
    percent,
    completed: pickBool(src, ["completed", "done", "is_completed", "finished", "solved"]) ?? (score !== null ? true : null),
    date: pickDate(src),
  };
}

/** Pull quiz-like objects out of a group / supergroup / collection response. */
export function findQuizzes(raw: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(raw)) {
    const quizLike = raw.filter((x) => isObj(x) && (x.slug !== undefined || x.title !== undefined || x.name !== undefined));
    const nested = raw.flatMap((x) => (isObj(x) ? findQuizzesIn(x, depth + 1) : []));
    return nested.length ? nested : quizLike;
  }
  if (isObj(raw)) {
    const nested = findQuizzesIn(raw, depth + 1);
    return nested.length ? nested : [];
  }
  return [];
}
function findQuizzesIn(o: Obj, depth: number): unknown[] {
  for (const k of ["quizzes", "quiz_set", "quizes", "results", "items"]) {
    if (Array.isArray(o[k])) {
      const inner = findQuizzes(o[k], depth);
      return inner.length ? inner : (o[k] as unknown[]);
    }
  }
  for (const k of ["groups", "quiz_groups", "quizgroups", "children", "sections"]) {
    if (Array.isArray(o[k])) return (o[k] as unknown[]).flatMap((g) => (isObj(g) ? findQuizzesIn(g, depth + 1) : []));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Study plan
// ---------------------------------------------------------------------------
export interface StudyPlanUnit {
  id: string | null;
  title: string | null;
  done: boolean | null;
  day: string | null;
  section: Section;
  url: string | null;
  date: string | null;
}
export interface StudyPlan {
  slug: string | null;
  title: string | null;
  units: StudyPlanUnit[];
  shape_note?: string;
}

const DONE_KEYS = ["done", "is_done", "isDone", "completed", "is_completed", "user_done", "checked", "finished"];

/** Recursively collect objects that carry a done-like flag; tracks the nearest "day"/"week" label. */
function collectUnits(raw: unknown, ctx: string | null, out: StudyPlanUnit[], depth: number): void {
  if (depth > 6) return;
  if (Array.isArray(raw)) {
    raw.forEach((x) => collectUnits(x, ctx, out, depth + 1));
    return;
  }
  if (!isObj(raw)) return;
  const hasDone = DONE_KEYS.some((k) => k in raw) || isObj(raw.user_status);
  const label = pickStr(raw, ["day", "day_number", "week", "label"]) ?? null;
  const childCtx = label ? (ctx ? `${ctx} / ${label}` : label) : ctx;
  const childArrays = Object.entries(raw).filter(([, v]) => Array.isArray(v) && (v as unknown[]).some(isObj));
  if (hasDone) {
    const title = pickStr(raw, ["title", "name", "text", "description", "content.title"]);
    out.push({
      id: pickStr(raw, ["id", "pk", "uuid"]),
      title,
      done: pickBool(raw, DONE_KEYS) ?? (isObj(raw.user_status) ? pickBool(raw.user_status, DONE_KEYS) : null),
      day: pickStr(raw, ["day", "day_number", "week"]) ?? ctx,
      section: classifySection(pickStr(raw, ["section", "subject", "type"]), title),
      url: pickStr(raw, ["url", "link", "href", "content.url"]),
      date: pickDate(raw, ["done_at", "doneAt", "completed_at", "updated_at", "date"]),
    });
    if (childArrays.length === 0) return;
  }
  for (const [, v] of childArrays) collectUnits(v, childCtx, out, depth + 1);
}

export function normalizeStudyPlan(raw: unknown, slug?: string): StudyPlan {
  const units: StudyPlanUnit[] = [];
  collectUnits(raw, null, units, 0);
  return {
    slug: pickStr(raw, ["slug"]) ?? slug ?? null,
    title: pickStr(raw, ["title", "name"]),
    units,
    shape_note: units.length === 0 ? "No objects with a done-like flag found; see `raw_shape` and update normalize.ts/config.ts" : undefined,
  };
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
