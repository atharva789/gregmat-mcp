/** MCP tool registrations. All GregMAT access is GET-only; local-log tools write only to the local JSON file. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GroupStat, bestPercent, byCategory, bySection, byTopic, byType, isAttempted, pct, questionActivityDates, quizActivityDates, quizTaken,
  summarizeQuizzes, untouchedTopics, weakestFirst,
} from "./analytics.js";
import { GregmatClient } from "./api.js";
import { QUIZ_SOURCES, RAW_GET_ALLOWED_PREFIXES, RAW_GET_DENY_FRAGMENTS, logFile, testDate } from "./config.js";
import { CONFIG_HINT, ToolError, toToolError } from "./errors.js";
import {
  Fetched, capRaw, defaultPlan, fetchPlan, fetchPlanList, fetchProfile, fetchQuestions, fetchQuizzes, fetchSiteTotals, fetchSkillStats,
  fetchTagCounts,
} from "./gregmat.js";
import { LogEntry, addEntry, aggregate, filterEntries, normalizeDateInput, readLog } from "./localLog.js";
import { Section, StudyUnit, computeStreak, daysUntil, describeShape, localDay, topicTags } from "./normalize.js";

type Json = Record<string, unknown>;
const MAX_OUTPUT_CHARS = 120_000;

export function jsonResult(obj: unknown, isError = false) {
  let text = JSON.stringify(obj, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars; narrow your query]`;
  }
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Wrap a handler so nothing ever throws out to the transport. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof jsonResult>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return jsonResult(toToolError(e), true);
    }
  };
}

function safeReadLog(): { entries: LogEntry[]; error?: string } {
  try {
    return { entries: readLog() };
  } catch (e) {
    return { entries: [], error: `could not read local log ${logFile()}: ${(e as Error).message}` };
  }
}

function testInfo() {
  const td = testDate();
  return { test_date: td, days_until_test: daysUntil(td) };
}

const sectionEnum = z.enum(["quant", "verbal", "awa"]);
const dateStr = z.string().describe("Date YYYY-MM-DD (local)");

const authError = (client: GregmatClient): Promise<ToolError | null> => client.auth.getToken().then(() => null, (e) => toToolError(e));
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Completed-item helpers
// ---------------------------------------------------------------------------
interface CompletedItem {
  type: "problem" | "quiz" | "video" | "skill";
  source: "gregmat" | "local_log";
  title: string | null;
  slug?: string | null;
  section: Section | string;
  topic?: string | null;
  tags?: string[];
  question_type?: string | null;
  difficulty?: string | null;
  status?: string;
  /** For problems: correctness of the FIRST attempt. */
  correct?: boolean | null;
  attempts?: number;
  group?: string | null;
  score?: number | null;
  percent?: number | null;
  date: string | null;
}

function localEntryType(e: LogEntry): CompletedItem["type"] {
  const t = `${e.item} ${e.topic} ${e.notes ?? ""}`.toLowerCase();
  if (/\bquiz\b|sectional|test\b/.test(t)) return "quiz";
  if (/video|lesson|class/.test(t)) return "video";
  if (/vocab|skill/.test(t)) return "skill";
  return "problem";
}

function localToItem(e: LogEntry): CompletedItem {
  return {
    type: localEntryType(e),
    source: "local_log",
    title: e.item,
    section: e.section,
    topic: e.topic,
    correct: e.correct ?? null,
    score: e.score ?? null,
    date: e.date,
  };
}

// ---------------------------------------------------------------------------
// Study-plan progress (shared by get_study_plan_progress and get_progress_summary)
// ---------------------------------------------------------------------------
interface PlanProgress {
  slug: string;
  title: string | null;
  modules: { slug: string; title: string | null; index: number | null; done: number; total: number }[];
  done: number;
  total: number;
  percent: number | null;
  doneUnits: StudyUnit[];
  /** Done units of other plans when the default plan has none (so "video" items reflect the plan in use). */
  otherDoneUnits: StudyUnit[];
  remainingUnits: StudyUnit[];
  planInUse: boolean;
  otherPlansWithProgress: { slug: string; title: string | null; done: number; total: number; percent: number | null }[];
  note?: string;
  warnings: string[];
}

async function planProgress(client: GregmatClient, slugArg: string | undefined): Promise<Fetched<PlanProgress>> {
  const slug = slugArg ?? defaultPlan();
  const list = await fetchPlanList(client);
  const plans = list.ok ? list.data : [];
  let main = await fetchPlan(client, slug, plans);
  const warnings = list.ok ? [] : [`plan list unavailable: ${list.error.error}`];
  if (!main.ok) {
    // Default plan missing/unreachable: still look for the plan in use among the others.
    if (slugArg || plans.length === 0) return main;
    warnings.push(`default plan "${slug}" unavailable: ${main.error.error}`);
    main = { ok: true, endpoint: `/studyplans/${slug}/`, data: { slug, title: null, modules: [], warnings: [] } };
  }
  warnings.push(...main.data.warnings);
  const summarize = (d: { slug: string; title: string | null; modules: { units: StudyUnit[] }[] }) => {
    const units = d.modules.flatMap((m) => m.units);
    const done = units.filter((u) => u.done).length;
    return { units, done, total: units.length };
  };
  const m = summarize(main.data);
  const others: PlanProgress["otherPlansWithProgress"] = [];
  const otherDoneUnits: StudyUnit[] = [];
  let note: string | undefined;
  if (m.done === 0 && !slugArg) {
    // Default plan untouched: look for the plan(s) actually in use.
    for (const p of plans.filter((x) => x.role === "plan" && x.slug !== slug)) {
      const r = await fetchPlan(client, p.slug, plans);
      if (!r.ok) continue;
      const s = summarize(r.data);
      if (s.done > 0) {
        others.push({ slug: p.slug, title: r.data.title, done: s.done, total: s.total, percent: pct(s.done, s.total) });
        otherDoneUnits.push(...s.units.filter((u) => u.done));
      }
    }
    note = others.length
      ? `No units done in the default plan "${slug}"; other plan(s) have progress: ${others.map((o) => o.slug).join(", ")}. Pass \`slug\` to inspect one.`
      : "No plan progress recorded (no study-plan unit is marked done in any plan).";
  } else if (m.done === 0) {
    note = `No units done in "${slug}".`;
  }
  return {
    ok: true,
    endpoint: main.endpoint,
    data: {
      slug,
      title: main.data.title,
      modules: main.data.modules.map((mod) => ({ slug: mod.slug, title: mod.title, index: mod.index, done: mod.units.filter((u) => u.done).length, total: mod.units.length })),
      done: m.done,
      total: m.total,
      percent: pct(m.done, m.total),
      doneUnits: m.units.filter((u) => u.done),
      remainingUnits: m.units.filter((u) => !u.done),
      planInUse: m.done > 0,
      otherPlansWithProgress: others,
      otherDoneUnits,
      note,
      warnings,
    },
  };
}

export function registerTools(server: McpServer, client: GregmatClient): void {
  // 1. get_profile -----------------------------------------------------------
  server.registerTool(
    "get_profile",
    {
      title: "GregMAT profile",
      description: "Read the logged-in GregMAT user's profile (name, email, Plus status, subscription) from /authentication/me/. Read-only.",
      inputSchema: { include_raw_shape: z.boolean().optional().describe("Include the raw response's key structure") },
    },
    safe(async ({ include_raw_shape }: { include_raw_shape?: boolean }) => {
      const r = await fetchProfile(client);
      if (!r.ok) return jsonResult(r.error, true);
      return jsonResult({
        profile: r.data.profile,
        auth: { source: client.auth.info.source, token_expires_at: client.auth.info.tokenExpiresAt ?? null },
        ...(include_raw_shape ? { raw_shape: r.data.raw_shape } : {}),
      });
    }),
  );

  // 2. get_progress_summary -------------------------------------------------
  server.registerTool(
    "get_progress_summary",
    {
      title: "Progress summary",
      description:
        "Combined GRE prep progress: solved/attempted counts per section, category and topic (from /ps/questions/ attempts), quiz and skill-building stats, study-plan completion, local log, last activity and streak (from answered_at dates), days until the test date.",
      inputSchema: {
        study_plan: z.string().optional().describe("Parent study plan slug (default GREGMAT_STUDY_PLAN or the-im-overwhelmed-study-plan)"),
        refresh: z.boolean().optional().describe("Bypass the 5-minute /ps/questions cache"),
      },
    },
    safe(async ({ study_plan, refresh }: { study_plan?: string; refresh?: boolean }) => {
      const log = safeReadLog();
      const authErr = await authError(client);
      const out: Json = { ...testInfo() };
      const errors: ToolError[] = [];
      const activityDates: (string | null)[] = log.entries.map((e) => e.date);

      if (authErr) errors.push(authErr);
      else {
        const [totals, sb, plan, qs, quizzes] = await Promise.all([
          fetchSiteTotals(client),
          fetchSkillStats(client),
          planProgress(client, study_plan),
          fetchQuestions(client, { refresh }),
          fetchQuizzes(client),
        ]);
        for (const f of [totals, sb, plan, qs, quizzes]) if (!f.ok) errors.push(f.error);
        const gm: Json = {};
        if (totals.ok) gm.site_totals = totals.data;
        if (qs.ok) {
          const questions = qs.data.questions;
          const attempted = questions.filter(isAttempted);
          const view = (g: GroupStat) => ({ name: g.name, section: g.section, solved: g.solved, attempted: g.attempted, total: g.total, first_attempt_accuracy: g.accuracy });
          gm.questions = {
            total_questions: questions.length,
            solved: questions.filter((q) => q.status === "solved").length,
            attempted: attempted.length,
            by_section: bySection(questions).map(view),
            by_category: byCategory(questions).sort((a, b) => b.attempted - a.attempted).map(view),
            by_topic: byTopic(questions).filter((g) => g.attempted > 0).sort((a, b) => b.attempted - a.attempted).map(view),
            cached: qs.data.from_cache,
            fetched_at: qs.data.fetched_at,
            ...(qs.data.warnings.length ? { warnings: qs.data.warnings } : {}),
          };
          activityDates.push(...questionActivityDates(questions));
        }
        if (quizzes.ok) {
          gm.quizzes = { by_section: summarizeQuizzes(quizzes.data.quizzes), sources: quizzes.data.sources };
          activityDates.push(...quizActivityDates(quizzes.data.quizzes));
        }
        if (sb.ok) gm.skill_building = sb.data;
        if (plan.ok) {
          const p = plan.data;
          gm.study_plan = { slug: p.slug, title: p.title, done: p.done, total: p.total, percent: p.percent, plan_in_use: p.planInUse, ...(p.note ? { note: p.note } : {}), ...(p.otherPlansWithProgress.length ? { other_plans_with_progress: p.otherPlansWithProgress } : {}) };
          activityDates.push(...p.doneUnits.map((u) => u.date));
        }
        out.gregmat = gm;
      }

      out.local_log = { entries: log.entries.length, ...aggregate(filterEntries(log.entries)), ...(log.error ? { error: log.error } : {}) };
      const streak = computeStreak(activityDates);
      out.activity = {
        last_activity: streak.last_activity,
        current_streak_days: streak.current,
        longest_streak_days: streak.longest,
        active_days: streak.active_days,
        note: "From answered_at dates of problem/quiz attempts plus local-log dates (day boundaries in the server's local time zone).",
      };
      if (errors.length) out.errors = errors;
      return jsonResult(out);
    }),
  );

  // 3. list_completed_items -------------------------------------------------
  server.registerTool(
    "list_completed_items",
    {
      title: "Completed items",
      description:
        "List completed/attempted GregMAT items, newest first: problems with attempts (/ps/questions/; one row per question, correct = first attempt), quiz attempts, study-plan units marked done (type 'video'), skill-building drill totals (type 'skill'), merged with local-log entries.",
      inputSchema: {
        type: z.enum(["problem", "quiz", "video", "skill", "all"]).optional().describe("Item type filter (default all)"),
        since: dateStr.optional().describe("Only items dated on/after this date (YYYY-MM-DD). Undated items (plan units, skill totals) are excluded when set."),
        section: z.enum(["quant", "verbal"]).optional().describe("Only problems/quizzes of this section"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max items returned (default 100)"),
        refresh: z.boolean().optional().describe("Bypass the 5-minute /ps/questions cache"),
      },
    },
    safe(async ({ type, since, section, limit, refresh }: { type?: string; since?: string; section?: string; limit?: number; refresh?: boolean }) => {
      const want = type ?? "all";
      const lim = limit ?? 100;
      const sinceDay = since ? normalizeDateInput(since) : null;
      const has = (t: string) => want === "all" || want === t;
      const items: CompletedItem[] = [];
      const errors: ToolError[] = [];
      const log = safeReadLog();

      const authErr = await authError(client);
      if (authErr) errors.push(authErr);
      else {
        const [qs, quizzes, plan, sb] = await Promise.all([
          has("problem") ? fetchQuestions(client, { refresh }) : null,
          has("quiz") ? fetchQuizzes(client) : null,
          has("video") ? planProgress(client, undefined) : null,
          has("skill") ? fetchSkillStats(client) : null,
        ]);
        for (const f of [qs, quizzes, plan, sb]) if (f && !f.ok) errors.push(f.error);
        if (qs?.ok) {
          for (const q of qs.data.questions) {
            if (!isAttempted(q)) continue;
            items.push({
              type: "problem", source: "gregmat", title: q.title, slug: q.slug, section: q.section, topic: q.category,
              tags: topicTags(q).map((t) => t.title), question_type: q.type, difficulty: q.difficulty, status: q.status,
              correct: q.first_attempt_correct, attempts: q.attempts.length, date: q.last_attempt_at,
            });
          }
        }
        if (quizzes?.ok) {
          for (const z of quizzes.data.quizzes) {
            for (const a of z.attempts) {
              items.push({ type: "quiz", source: "gregmat", title: z.title, slug: z.slug, section: z.section, group: z.group, score: a.score, percent: a.percent, date: a.date });
            }
          }
        }
        if (plan?.ok) {
          for (const u of [...plan.data.doneUnits, ...plan.data.otherDoneUnits]) {
            items.push({ type: "video", source: "gregmat", title: u.title, slug: u.id, section: "unknown", topic: u.module_title, date: u.date });
          }
        }
        if (sb?.ok) {
          for (const s of sb.data) {
            if ((s.total_attempts ?? 0) > 0) items.push({ type: "skill", source: "gregmat", title: s.kind, section: "verbal", attempts: s.total_attempts ?? 0, percent: s.first_attempt_accuracy, date: null });
          }
        }
      }
      for (const e of log.entries) {
        const it = localToItem(e);
        if (has(it.type)) items.push(it);
      }

      let filtered = section ? items.filter((i) => i.type === "video" || i.type === "skill" || i.section === section) : items;
      let undatedExcluded = 0;
      if (sinceDay) {
        filtered = filtered.filter((i) => {
          if (!i.date) {
            undatedExcluded++;
            return false;
          }
          return localDay(i.date) >= sinceDay;
        });
      }
      filtered.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      const counts: Record<string, number> = {};
      for (const i of filtered) counts[`${i.source}:${i.type}`] = (counts[`${i.source}:${i.type}`] ?? 0) + 1;
      return jsonResult({
        filter: { type: want, since: sinceDay, section: section ?? null, limit: lim },
        total_matching: filtered.length,
        counts,
        ...(undatedExcluded ? { undated_excluded: undatedExcluded } : {}),
        items: filtered.slice(0, lim),
        ...(errors.length ? { errors } : {}),
        ...(log.error ? { local_log_error: log.error } : {}),
      });
    }),
  );

  // 4. get_quiz_results -----------------------------------------------------
  server.registerTool(
    "get_quiz_results",
    {
      title: "Quiz results",
      description: `Scores/attempts per quiz, aggregated from: ${QUIZ_SOURCES.map((s) => `${s.label} (/ps/${s.kind}/${s.slug}/)`).join("; ")}. Filter by quiz \`slug\`, source/group (\`group\`: source slug or group-title substring), or \`taken_only\`. Local-log quiz entries are included.`,
      inputSchema: {
        slug: z.string().optional().describe("Quiz slug"),
        group: z.string().optional().describe(`Source slug (${QUIZ_SOURCES.map((s) => s.slug).join(", ")}) or part of a quiz group title`),
        taken_only: z.boolean().optional().describe("Only quizzes with at least one attempt (default false)"),
      },
    },
    safe(async ({ slug, group, taken_only }: { slug?: string; group?: string; taken_only?: boolean }) => {
      const log = safeReadLog();
      const localQuizzes = log.entries.filter((e) => localEntryType(e) === "quiz").map(localToItem);
      const r = await fetchQuizzes(client);
      if (!r.ok) return jsonResult({ ...r.error, local_log_quizzes: localQuizzes }, true);
      const g = group?.toLowerCase();
      let qz = r.data.quizzes;
      if (slug) qz = qz.filter((q) => q.slug === slug);
      if (g) qz = qz.filter((q) => q.source.toLowerCase() === g || (q.group ?? "").toLowerCase().includes(g) || q.source.toLowerCase().includes(g));
      const all = qz;
      if (taken_only) qz = qz.filter(quizTaken);
      const taken = all.filter(quizTaken);
      const bests = taken.map(bestPercent).filter((p): p is number => p !== null);
      return jsonResult({
        sources: r.data.sources,
        quizzes_found: all.length,
        quizzes_taken: taken.length,
        average_best_percent: bests.length ? round1(bests.reduce((a, b) => a + b, 0) / bests.length) : null,
        by_section: summarizeQuizzes(all),
        quizzes: qz.map((q) => ({
          title: q.title, slug: q.slug, group: q.group, source: q.source, section: q.section, minutes: q.minutes, max_score: q.max_score,
          site_mean_score: q.mean_score, acceptance: q.acceptance, plus_only: q.plus_only,
          attempts_count: q.attempts.length, best_percent: bestPercent(q), attempts: q.attempts,
        })),
        local_log_quizzes: localQuizzes,
      });
    }),
  );

  // 5. get_diagnostics ------------------------------------------------------
  server.registerTool(
    "get_diagnostics",
    {
      title: "Diagnostics (derived)",
      description:
        "DERIVED diagnostics (GregMAT has no diagnostic endpoint): first-attempt accuracy by category (first_tlc), question type and topic tag from /ps/questions/ attempts, weakest first, plus topics not yet touched; quiz averages and skill-building accuracy.",
      inputSchema: {
        weakest_n: z.number().int().min(1).max(30).optional().describe("How many weakest topics to return (default 5)"),
        min_attempts: z.number().int().min(1).max(100).optional().describe("Minimum first attempts for a group to be ranked (default 3)"),
        refresh: z.boolean().optional().describe("Bypass the 5-minute /ps/questions cache"),
      },
    },
    safe(async ({ weakest_n, min_attempts, refresh }: { weakest_n?: number; min_attempts?: number; refresh?: boolean }) => {
      const n = weakest_n ?? 5;
      const minA = min_attempts ?? 3;
      const errors: ToolError[] = [];
      const log = safeReadLog();
      const out: Json = {
        derived: true,
        method:
          "Derived, not an official GregMAT diagnostic. Accuracy = first-attempt correctness (user_answer_attempts[first=true]) per question, grouped by first_tlc category, question type and topic tag, as on the site. Groups with fewer than min_attempts first attempts are listed separately.",
        ...testInfo(),
        min_attempts: minA,
      };

      const authErr = await authError(client);
      if (authErr) errors.push(authErr);
      else {
        const [qs, quizzes, sb, counts] = await Promise.all([fetchQuestions(client, { refresh }), fetchQuizzes(client), fetchSkillStats(client), fetchTagCounts(client)]);
        for (const f of [qs, quizzes, sb]) if (!f.ok) errors.push(f.error);
        const warnings: string[] = [];
        if (qs.ok) {
          const questions = qs.data.questions;
          const ranked = (stats: GroupStat[]) => weakestFirst(stats.filter((g) => g.first_attempts >= minA));
          const thin = (stats: GroupStat[]) => stats.filter((g) => g.first_attempts > 0 && g.first_attempts < minA).map((g) => ({ name: g.name, first_attempts: g.first_attempts, accuracy: g.accuracy }));
          const topics = byTopic(questions);
          const rankedTopics = ranked(topics);
          out.sections = bySection(questions).map((g) => ({ name: g.name, attempted: g.attempted, solved: g.solved, first_attempts: g.first_attempts, accuracy: g.accuracy }));
          out.by_category = ranked(byCategory(questions));
          out.by_type = ranked(byType(questions));
          out.by_topic = rankedTopics;
          out.weakest_topics = rankedTopics.slice(0, n);
          out.strongest_topics = rankedTopics.length > n ? rankedTopics.slice(-n).reverse() : [];
          out.below_min_attempts = { categories: thin(byCategory(questions)), types: thin(byType(questions)), topics: thin(topics) };
          if (!counts.ok) warnings.push(`question-counts unavailable: ${counts.error.error}`);
          out.untouched_topics = untouchedTopics(questions, counts.ok ? counts.data : {}).slice(0, 25);
          if (qs.data.warnings.length) warnings.push(...qs.data.warnings);
          out.cached = qs.data.from_cache;
        }
        if (quizzes.ok) out.quiz_average_by_section = summarizeQuizzes(quizzes.data.quizzes);
        if (sb.ok) out.skill_building_first_attempt_accuracy = sb.data.map((s) => ({ kind: s.kind, first_attempts: s.total_first_attempts, accuracy: s.first_attempt_accuracy }));
        if (warnings.length) out.warnings = warnings;
      }
      // Local-log accuracy stays separate (never double-counted with GregMAT).
      out.local_log = aggregate(filterEntries(log.entries));
      if (errors.length) out.errors = errors;
      if (log.error) out.local_log_error = log.error;
      return jsonResult(out);
    }),
  );

  // 6. get_study_plan_progress ----------------------------------------------
  server.registerTool(
    "get_study_plan_progress",
    {
      title: "Study plan progress",
      description:
        "GregMAT study plan progress: gathers all modules of the parent plan (/studyplans/), counts units done, lists next undone units (title + first lines of their content) and the per-day pace needed by the test date. If the default plan has no progress, reports which plan is in use (or that none is).",
      inputSchema: {
        slug: z.string().optional().describe("Parent plan slug (default GREGMAT_STUDY_PLAN or the-im-overwhelmed-study-plan)"),
        next_n: z.number().int().min(1).max(100).optional().describe("How many upcoming undone units to list (default 10)"),
      },
    },
    safe(async ({ slug, next_n }: { slug?: string; next_n?: number }) => {
      const ti = testInfo();
      const authErr = await authError(client);
      if (authErr) return jsonResult({ ...authErr, ...ti }, true);
      const r = await planProgress(client, slug);
      if (!r.ok) return jsonResult({ ...r.error, ...ti }, true);
      const p = r.data;
      const days = Math.max(ti.days_until_test, 0);
      const doneDates = p.doneUnits.filter((u) => u.date).map((u) => localDay(u.date!));
      return jsonResult({
        slug: p.slug,
        title: p.title,
        plan_in_use: p.planInUse,
        done: p.done,
        total: p.total,
        percent: p.percent,
        remaining: p.remainingUnits.length,
        modules: p.modules,
        ...ti,
        pacing: {
          units_per_day_needed: days > 0 ? round1(p.remainingUnits.length / days) : p.remainingUnits.length,
          note: days > 0 ? `${p.remainingUnits.length} units over ${days} days` : "Test date reached or passed",
          last_unit_done_on: doneDates.sort().pop() ?? null,
        },
        next_units: p.remainingUnits.slice(0, next_n ?? 10).map((u) => ({ module: u.module_title, module_index: u.module_index, id: u.id, title: u.title, plus_only: u.plus_only, preview: u.preview })),
        ...(p.note ? { note: p.note } : {}),
        ...(p.otherPlansWithProgress.length ? { other_plans_with_progress: p.otherPlansWithProgress } : {}),
        ...(p.warnings.length ? { warnings: p.warnings } : {}),
      });
    }),
  );

  // 7. raw_get --------------------------------------------------------------
  server.registerTool(
    "raw_get",
    {
      title: "Raw GET (debug)",
      description: `Debugging: GET an allowlisted GregMAT API path and return raw JSON (to learn response shapes). Allowed prefixes: ${RAW_GET_ALLOWED_PREFIXES.join(", ")}. GET only; write-like paths are refused.`,
      inputSchema: {
        path: z.string().describe("API path starting with an allowlisted prefix, e.g. /ps/stats/"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query params"),
        max_chars: z.number().int().min(500).max(100000).optional().describe("Truncate raw output (default 20000)"),
      },
    },
    safe(async ({ path, query, max_chars }: { path: string; query?: Record<string, string | number | boolean>; max_chars?: number }) => {
      const check = validateRawPath(path);
      if (!check.ok) return jsonResult({ error: check.reason, endpoint: path, status: null, hint: `Allowed prefixes: ${RAW_GET_ALLOWED_PREFIXES.join(", ")} (${CONFIG_HINT})` }, true);
      try {
        const r = await client.get(check.path, query);
        return jsonResult({ endpoint: r.path, status: r.status, shape: describeShape(r.data, 2), data: capRaw(r.data, max_chars ?? 20000) });
      } catch (e) {
        return jsonResult(toToolError(e, check.path), true);
      }
    }),
  );

  // 8. log_solved_problem ---------------------------------------------------
  server.registerTool(
    "log_solved_problem",
    {
      title: "Log solved problem (local)",
      description: "Append an entry to the LOCAL study log (~/.gregmat-mcp/log.json). Does not write to GregMAT.",
      inputSchema: {
        source: z.string().optional().describe('Where the problem came from (default "gregmat")'),
        section: sectionEnum,
        topic: z.string().min(1).describe("Topic, e.g. 'Ratios' or 'Text Completion'"),
        item: z.string().min(1).describe("Problem/quiz name or slug"),
        correct: z.boolean().optional(),
        score: z.number().optional().describe("Score (e.g. quiz percent or raw score)"),
        time_minutes: z.number().min(0).optional(),
        notes: z.string().optional(),
        date: dateStr.optional().describe("Date solved (YYYY-MM-DD, default today)"),
      },
    },
    safe(async (args: { source?: string; section: "quant" | "verbal" | "awa"; topic: string; item: string; correct?: boolean; score?: number; time_minutes?: number; notes?: string; date?: string }) => {
      try {
        const entry = addEntry(args);
        const total = readLog().length;
        return jsonResult({ logged: entry, total_entries: total, file: logFile() });
      } catch (e) {
        return jsonResult({ error: (e as Error).message, endpoint: "local_log", status: null, hint: `Check permissions on ${logFile()} or set GREGMAT_MCP_HOME` }, true);
      }
    }),
  );

  // 9. list_local_log -------------------------------------------------------
  server.registerTool(
    "list_local_log",
    {
      title: "List local log",
      description: "List entries from the local study log with aggregate stats (counts, accuracy by section/topic, per-day counts, streak).",
      inputSchema: {
        since: dateStr.optional(),
        section: sectionEnum.optional(),
        topic: z.string().optional().describe("Case-insensitive substring match on topic"),
        limit: z.number().int().min(1).max(5000).optional().describe("Max entries returned, newest kept (default 200)"),
      },
    },
    safe(async ({ since, section, topic, limit }: { since?: string; section?: string; topic?: string; limit?: number }) => {
      const log = safeReadLog();
      if (log.error) return jsonResult({ error: log.error, endpoint: "local_log", status: null, hint: "Fix or move the corrupt log file" }, true);
      const entries = filterEntries(log.entries, { since, section, topic });
      const lim = limit ?? 200;
      return jsonResult({
        file: logFile(),
        filter: { since: since ?? null, section: section ?? null, topic: topic ?? null },
        count: entries.length,
        stats: aggregate(entries),
        streak: computeStreak(log.entries.map((e) => e.date)),
        ...testInfo(),
        entries: entries.slice(-lim),
      });
    }),
  );
}

export function validateRawPath(input: string): { ok: true; path: string } | { ok: false; reason: string } {
  const p = input.trim();
  if (/^[a-z]+:\/\//i.test(p) || p.startsWith("//")) return { ok: false, reason: "Absolute URLs are not allowed; pass a path like /ps/stats/" };
  if (p.includes("..") || p.includes("\\") || /%2e|%2f/i.test(p)) return { ok: false, reason: "Path traversal / encoded separators are not allowed" };
  const [pathOnly] = p.split("?");
  const norm = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  if (p.includes("?")) return { ok: false, reason: "Pass query parameters via the `query` argument, not in `path`" };
  if (!RAW_GET_ALLOWED_PREFIXES.some((pre) => norm.startsWith(pre))) return { ok: false, reason: `Path ${norm} is not under an allowlisted prefix` };
  if (RAW_GET_DENY_FRAGMENTS.some((f) => norm.includes(f))) return { ok: false, reason: `Path ${norm} looks like a write/action endpoint and is refused` };
  return { ok: true, path: norm };
}

export const TOOL_NAMES = [
  "get_profile", "get_progress_summary", "list_completed_items", "get_quiz_results", "get_diagnostics",
  "get_study_plan_progress", "raw_get", "log_solved_problem", "list_local_log",
] as const;
