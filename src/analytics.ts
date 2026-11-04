/** Pure aggregations over normalized GregMAT data (no I/O, unit-testable). */
import { Question, Quiz, Section, topicTags } from "./normalize.js";

export function pct(n: number, d: number): number | null {
  return d ? Math.round((n / d) * 1000) / 10 : null;
}

export interface GroupStat {
  name: string;
  section: Section | string;
  /** Questions available on the site in this group (from /ps/questions/). */
  total: number;
  attempted: number;
  solved: number;
  /** Questions whose first attempt is known (accuracy denominator). */
  first_attempts: number;
  first_attempt_correct: number;
  /** First-attempt accuracy, % (the site's convention). */
  accuracy: number | null;
}

export const isAttempted = (q: Question): boolean => q.attempts.length > 0 || q.status === "attempted" || q.status === "solved";

export function groupStats(questions: Question[], keysOf: (q: Question) => string[]): GroupStat[] {
  const map = new Map<string, GroupStat>();
  const sectionVotes = new Map<string, Map<string, number>>();
  for (const q of questions) {
    for (const name of new Set(keysOf(q))) {
      let g = map.get(name);
      if (!g) {
        g = { name, section: "unknown", total: 0, attempted: 0, solved: 0, first_attempts: 0, first_attempt_correct: 0, accuracy: null };
        map.set(name, g);
      }
      g.total++;
      if (isAttempted(q)) g.attempted++;
      if (q.status === "solved") g.solved++;
      if (q.first_attempt_correct !== null) {
        g.first_attempts++;
        if (q.first_attempt_correct) g.first_attempt_correct++;
      }
      const votes = sectionVotes.get(name) ?? new Map<string, number>();
      votes.set(q.section, (votes.get(q.section) ?? 0) + 1);
      sectionVotes.set(name, votes);
    }
  }
  for (const [name, g] of map) {
    g.section = [...(sectionVotes.get(name) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    g.accuracy = pct(g.first_attempt_correct, g.first_attempts);
  }
  return [...map.values()];
}

/** Weakest first: lowest accuracy, then most evidence. Groups with no graded attempts go last. */
export function weakestFirst(stats: GroupStat[]): GroupStat[] {
  return [...stats].sort(
    (a, b) =>
      (a.accuracy === null ? 1 : 0) - (b.accuracy === null ? 1 : 0) ||
      (a.accuracy ?? 0) - (b.accuracy ?? 0) ||
      b.first_attempts - a.first_attempts ||
      a.name.localeCompare(b.name),
  );
}

export const bySection = (qs: Question[]) => groupStats(qs, (q) => [q.super_category ?? "unknown"]);
export const byCategory = (qs: Question[]) => groupStats(qs, (q) => (q.category ? [q.category] : []));
export const byType = (qs: Question[]) => groupStats(qs, (q) => (q.type ? [q.type] : []));
export const byTopic = (qs: Question[]) => groupStats(qs, (q) => topicTags(q).map((t) => t.title));

export interface UntouchedTopic {
  topic: string;
  section: string;
  questions_available: number;
}

/**
 * Topics with no attempted question. Counts come from the question list; `siteTagCounts`
 * (/ps/question-counts/ tag slug → count) fills in tags whose questions we didn't see and can
 * raise the available count. Tag slugs are matched via the slug→title map of the question list.
 */
export function untouchedTopics(qs: Question[], siteTagCounts: Record<string, number> = {}, minAvailable = 1): UntouchedTopic[] {
  const stats = byTopic(qs);
  const touchedTitles = new Set(stats.filter((s) => s.attempted > 0).map((s) => s.name.toLowerCase()));
  const slugToTitle = new Map<string, string>();
  for (const q of qs) for (const t of q.tags) if (t.slug) slugToTitle.set(t.slug, t.title);
  const out = new Map<string, UntouchedTopic>();
  for (const s of stats) {
    if (s.attempted === 0 && s.total >= minAvailable) out.set(s.name.toLowerCase(), { topic: s.name, section: String(s.section), questions_available: s.total });
  }
  for (const [slug, count] of Object.entries(siteTagCounts)) {
    if (!slug.startsWith("topic_") || count < minAvailable) continue;
    const title = slugToTitle.get(slug) ?? slug.replace(/^topic_/, "").replace(/_/g, " ");
    const key = title.toLowerCase();
    if (touchedTitles.has(key)) continue;
    const prev = out.get(key);
    out.set(key, { topic: prev?.topic ?? title, section: prev?.section ?? "quant", questions_available: Math.max(prev?.questions_available ?? 0, count) });
  }
  return [...out.values()].sort((a, b) => b.questions_available - a.questions_available || a.topic.localeCompare(b.topic));
}

export function questionActivityDates(qs: Question[]): string[] {
  const out: string[] = [];
  for (const q of qs) for (const a of q.attempts) if (a.answered_at) out.push(a.answered_at);
  return out;
}

export function quizActivityDates(quizzes: Quiz[]): string[] {
  return quizzes.flatMap((q) => q.attempts.map((a) => a.date).filter((d): d is string => !!d));
}

export interface QuizSummary {
  quizzes: number;
  taken: number;
  attempts: number;
  average_best_percent: number | null;
}

export const quizTaken = (q: Quiz): boolean => q.attempts.length > 0;

export function bestPercent(q: Quiz): number | null {
  const ps = q.attempts.map((a) => a.percent).filter((p): p is number => p !== null);
  return ps.length ? Math.max(...ps) : null;
}

export function summarizeQuizzes(quizzes: Quiz[]): Record<string, QuizSummary> {
  const out: Record<string, QuizSummary> = {};
  for (const sec of new Set(quizzes.map((q) => q.section as string))) {
    const qs = quizzes.filter((q) => q.section === sec);
    const bests = qs.map(bestPercent).filter((p): p is number => p !== null);
    out[sec] = {
      quizzes: qs.length,
      taken: qs.filter(quizTaken).length,
      attempts: qs.reduce((n, q) => n + q.attempts.length, 0),
      average_best_percent: bests.length ? Math.round((bests.reduce((a, b) => a + b, 0) / bests.length) * 10) / 10 : null,
    };
  }
  return out;
}
