/** MCP tool registrations. All GregMAT access is GET-only; local-log tools write only to the local JSON file. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GregmatClient } from "./api.js";
import {
  HIGH_YIELD_TOPICS, RAW_GET_ALLOWED_PREFIXES, RAW_GET_DENY_FRAGMENTS, defaultStudyPlan, logFile, testDate,
} from "./config.js";
import { CONFIG_HINT, ToolError, toToolError } from "./errors.js";
import { Fetched, capRaw, fetchProfile, fetchQuestions, fetchQuizzes, fetchStats, fetchStudyPlan } from "./gregmat.js";
import { LogEntry, addEntry, aggregate, filterEntries, normalizeDateInput, readLog } from "./localLog.js";
import { Question, Section, computeStreak, daysUntil, describeShape, localDay } from "./normalize.js";
import { ScraperUnavailableError, scrapeSectionalTests } from "./scraper.js";

type Json = Record<string, unknown>;
const MAX_OUTPUT_CHARS = 120_000;

export function jsonResult(obj: unknown, isError = false) {
  let text = JSON.stringify(obj, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars; narrow your query]`;
  }
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function errorsOf(...fs: Fetched<unknown>[]): ToolError[] {
  return fs.filter((f): f is { ok: false; error: ToolError } => !f.ok).map((f) => f.error);
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
  status?: string;
  correct?: boolean | null;
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
// Diagnostics helpers
// ---------------------------------------------------------------------------
interface TopicStat {
  topic: string;
  section: Section | string;
  attempted: number;
  graded: number;
  correct: number;
  accuracy: number | null;
  available: number;
  sources: string[];
}

function pct(n: number, d: number): number | null {
  return d ? Math.round((n / d) * 1000) / 10 : null;
}

/** For a question: did the user get it right? Uses explicit `correct`, else solved=right / attempted-not-solved=wrong (proxy). */
function questionOutcome(q: Question): { attempted: boolean; graded: boolean; correct: boolean; proxy: boolean } {
  if (q.correct !== null) return { attempted: true, graded: true, correct: q.correct, proxy: false };
  if (q.status === "solved") return { attempted: true, graded: true, correct: true, proxy: true };
  if (q.status === "attempted") return { attempted: true, graded: true, correct: false, proxy: true };
  return { attempted: false, graded: false, correct: false, proxy: false };
}

export function registerTools(server: McpServer, client: GregmatClient): void {
  // 1. get_profile -----------------------------------------------------------
  server.registerTool(
    "get_profile",
    {
      title: "GregMAT profile",
      description: "Read the logged-in GregMAT user's profile (name, email, subscription, ids) from /authentication/me/. Read-only.",
      inputSchema: { include_raw_shape: z.boolean().optional().describe("Include the raw response's key structure") },
    },
    safe(async ({ include_raw_shape }: { include_raw_shape?: boolean }) => {
      const r = await fetchProfile(client);
      if (!r.ok) return jsonResult(r.error, true);
      return jsonResult({
        profile: r.data.profile,
        auth: { source: client.auth.info.source, login_variant: client.auth.info.loginVariant ?? null, token_expires_at: client.auth.info.tokenExpiresAt ?? null },
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
        "Combined GRE prep progress: GregMAT problem-solving stats (/ps/stats/), per-question solved counts by section/topic (/ps/questions/), skill-building stats (/sb/stats/me/), study plan completion, and the local log. Includes last activity, streak and days until the test date.",
      inputSchema: {
        study_plan: z.string().optional().describe("Study plan slug (default GREGMAT_STUDY_PLAN or the-im-overwhelmed-study-plan)"),
        max_questions: z.number().int().min(0).max(5000).optional().describe("Max questions to scan from /ps/questions/ (default 1500, 0 = skip)"),
      },
    },
    safe(async ({ study_plan, max_questions }: { study_plan?: string; max_questions?: number }) => {
      const slug = study_plan ?? defaultStudyPlan();
      const maxQ = max_questions ?? 1500;
      const log = safeReadLog();
      const authOk = await client.auth.getToken().then(() => null, (e) => toToolError(e));

      const out: Json = { ...testInfo() };
      const errors: ToolError[] = [];
      const activityDates: (string | null)[] = log.entries.map((e) => e.date);

      if (authOk) {
        errors.push(authOk);
      } else {
        const [ps, sb, plan, qs] = await Promise.all([
          fetchStats(client, "psStats"),
          fetchStats(client, "sbStats"),
          fetchStudyPlan(client, slug),
          maxQ > 0 ? fetchQuestions(client, maxQ) : Promise.resolve(null),
        ]);
        errors.push(...errorsOf(ps, sb, plan, ...(qs ? [qs] : [])));
        const gm: Json = {};
        if (ps.ok) gm.problem_solving_stats = { numbers: ps.data.numbers, raw: ps.data.raw };
        if (sb.ok) gm.skill_building_stats = { numbers: sb.data.numbers, raw: sb.data.raw };
        if (plan.ok) {
          const units = plan.data.plan.units;
          const done = units.filter((u) => u.done === true).length;
          gm.study_plan = {
            slug,
            title: plan.data.plan.title,
            done,
            total: units.length,
            percent: pct(done, units.length),
            ...(plan.data.plan.shape_note ? { note: plan.data.plan.shape_note, raw_shape: plan.data.raw_shape } : {}),
          };
          activityDates.push(...units.filter((u) => u.done).map((u) => u.date));
        }
        if (qs && qs.ok) {
          const bySection: Record<string, { solved: number; attempted: number; total_seen: number }> = {};
          const byTopic: Record<string, { solved: number; attempted: number }> = {};
          for (const q of qs.data.questions) {
            const s = (bySection[q.section] ??= { solved: 0, attempted: 0, total_seen: 0 });
            s.total_seen++;
            if (q.status === "solved") s.solved++;
            if (q.status === "solved" || q.status === "attempted") s.attempted++;
            if (q.status === "solved" || q.status === "attempted") {
              for (const t of q.tags.length ? q.tags : ["(untagged)"]) {
                const tt = (byTopic[t] ??= { solved: 0, attempted: 0 });
                tt.attempted++;
                if (q.status === "solved") tt.solved++;
              }
              activityDates.push(q.date);
            }
          }
          gm.questions = {
            scanned: qs.data.fetched,
            total_reported: qs.data.total_reported,
            truncated: qs.data.truncated,
            per_user_status_detected: qs.data.status_known,
            by_section: bySection,
            by_topic: byTopic,
            ...(qs.data.status_known ? {} : { note: `No per-user solved/attempted flags recognised; first page keys: ${qs.data.first_page_keys.join(", ")}. ${CONFIG_HINT} / normalize.ts` }),
          };
        }
        out.gregmat = gm;
      }

      const agg = aggregate(filterEntries(log.entries));
      out.local_log = { entries: log.entries.length, ...agg, ...(log.error ? { error: log.error } : {}) };
      const streak = computeStreak(activityDates);
      out.activity = {
        last_activity: streak.last_activity,
        current_streak_days: streak.current,
        longest_streak_days: streak.longest,
        active_days: streak.active_days,
        note: "Streak uses dated activity from GregMAT (where dates are exposed) plus the local log.",
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
        "List completed/attempted GregMAT items: solved problems (/ps/questions/), quiz attempts (/quizzes/quiz/), study-plan units marked done (type 'video'), skill-building stats (type 'skill'), merged with local-log entries. Sorted newest first.",
      inputSchema: {
        type: z.enum(["problem", "quiz", "video", "skill", "all"]).optional().describe("Item type filter (default all)"),
        since: dateStr.optional().describe("Only items dated on/after this date (YYYY-MM-DD). Undated GregMAT items are excluded when set."),
        limit: z.number().int().min(1).max(1000).optional().describe("Max items returned (default 100)"),
      },
    },
    safe(async ({ type, since, limit }: { type?: string; since?: string; limit?: number }) => {
      const want = type ?? "all";
      const lim = limit ?? 100;
      const sinceDay = since ? normalizeDateInput(since) : null;
      const has = (t: string) => want === "all" || want === t;
      const items: CompletedItem[] = [];
      const errors: ToolError[] = [];
      const log = safeReadLog();

      const authErr = await client.auth.getToken().then(() => null, (e) => toToolError(e));
      if (authErr) errors.push(authErr);
      else {
        const [qs, quizzes, plan, sb] = await Promise.all([
          has("problem") ? fetchQuestions(client) : null,
          has("quiz") ? fetchQuizzes(client, {}) : null,
          has("video") ? fetchStudyPlan(client, defaultStudyPlan()) : null,
          has("skill") ? fetchStats(client, "sbStats") : null,
        ]);
        for (const f of [qs, quizzes, plan, sb]) if (f && !f.ok) errors.push(f.error);
        if (qs?.ok) {
          for (const q of qs.data.questions) {
            if (q.status !== "solved" && q.status !== "attempted") continue;
            items.push({ type: "problem", source: "gregmat", title: q.title, slug: q.slug, section: q.section, tags: q.tags, status: q.status, correct: q.correct, date: q.date });
          }
        }
        if (quizzes?.ok) {
          for (const z of quizzes.data.quizzes) {
            if (!(z.completed || (z.attempts ?? 0) > 0 || z.score !== null)) continue;
            items.push({ type: "quiz", source: "gregmat", title: z.title, slug: z.slug, section: z.section, score: z.score, percent: z.percent, date: z.date });
          }
        }
        if (plan?.ok) {
          for (const u of plan.data.plan.units) {
            if (u.done !== true) continue;
            items.push({ type: "video", source: "gregmat", title: u.title, slug: u.id, section: u.section, topic: u.day, date: u.date });
          }
        }
        if (sb?.ok) {
          for (const [k, v] of Object.entries(sb.data.numbers)) {
            if (v > 0 && /complet|done|solved|correct|count|answered|total/i.test(k)) {
              items.push({ type: "skill", source: "gregmat", title: k, section: "verbal", score: v, date: null });
            }
          }
        }
      }
      for (const e of log.entries) {
        const it = localToItem(e);
        if (has(it.type)) items.push(it);
      }

      let filtered = items;
      let undatedExcluded = 0;
      if (sinceDay) {
        filtered = items.filter((i) => {
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
        filter: { type: want, since: sinceDay, limit: lim },
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
      description:
        "Scores/attempts per quiz. `slug` → /ps/quiz/{slug}/; `group` → /ps/quizgroup/{group}/ (falls back to /ps/quizsupergroup/); neither → /quizzes/quiz/ listing. Local-log quiz entries are included.",
      inputSchema: {
        slug: z.string().optional().describe("Quiz slug"),
        group: z.string().optional().describe("Quiz group or super-group slug"),
        include_raw_shape: z.boolean().optional(),
      },
    },
    safe(async ({ slug, group, include_raw_shape }: { slug?: string; group?: string; include_raw_shape?: boolean }) => {
      const log = safeReadLog();
      const localQuizzes = log.entries.filter((e) => localEntryType(e) === "quiz").map(localToItem);
      const r = await fetchQuizzes(client, { slug, group });
      if (!r.ok) return jsonResult({ ...r.error, local_log_quizzes: localQuizzes }, true);
      const qz = r.data.quizzes;
      const taken = qz.filter((q) => q.completed || (q.attempts ?? 0) > 0 || q.score !== null);
      const pcts = taken.map((q) => q.percent).filter((p): p is number => p !== null);
      return jsonResult({
        source: r.data.source,
        quizzes_found: qz.length,
        quizzes_taken: taken.length,
        average_percent: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null,
        quizzes: qz,
        local_log_quizzes: localQuizzes,
        ...(include_raw_shape || qz.length === 0 ? { raw_shape: r.data.raw_shape } : {}),
      });
    }),
  );

  // 5. get_diagnostics ------------------------------------------------------
  server.registerTool(
    "get_diagnostics",
    {
      title: "Diagnostics (derived)",
      description:
        "DERIVED diagnostics (GregMAT has no diagnostic endpoint): accuracy by tag/topic and Quant vs Verbal from per-question results (/ps/questions/), quiz scores, and the local log; weakest N topics; unattempted high-yield topics. Optionally scrapes the sectional-tests page via Playwright.",
      inputSchema: {
        weakest_n: z.number().int().min(1).max(30).optional().describe("How many weakest topics to return (default 5)"),
        min_attempts: z.number().int().min(1).max(100).optional().describe("Minimum graded attempts for a topic to be ranked (default 3)"),
        include_sectional_tests: z.boolean().optional().describe("Try the Playwright scraper on /practice/sectional-tests/ (default false)"),
      },
    },
    safe(async ({ weakest_n, min_attempts, include_sectional_tests }: { weakest_n?: number; min_attempts?: number; include_sectional_tests?: boolean }) => {
      const n = weakest_n ?? 5;
      const minA = min_attempts ?? 3;
      const errors: ToolError[] = [];
      const log = safeReadLog();
      const topics = new Map<string, TopicStat>();
      const sections: Record<string, { attempted: number; graded: number; correct: number; accuracy: number | null }> = {};
      let proxyUsed = false;

      const topicFor = (topic: string, section: string) => {
        const key = topic.toLowerCase();
        let t = topics.get(key);
        if (!t) {
          t = { topic, section, attempted: 0, graded: 0, correct: 0, accuracy: null, available: 0, sources: [] };
          topics.set(key, t);
        }
        if (t.section === "unknown" && section !== "unknown") t.section = section;
        return t;
      };
      const record = (t: TopicStat, src: string, graded: boolean, correct: boolean) => {
        t.attempted++;
        if (graded) {
          t.graded++;
          if (correct) t.correct++;
        }
        if (!t.sources.includes(src)) t.sources.push(src);
      };
      const recordSection = (s: string, graded: boolean, correct: boolean) => {
        const b = (sections[s] ??= { attempted: 0, graded: 0, correct: 0, accuracy: null });
        b.attempted++;
        if (graded) {
          b.graded++;
          if (correct) b.correct++;
        }
      };

      const authErr = await client.auth.getToken().then(() => null, (e) => toToolError(e));
      let quizSummary: unknown = null;
      let sectional: unknown = undefined;
      if (authErr) errors.push(authErr);
      else {
        const [qs, quizzes] = await Promise.all([fetchQuestions(client, 3000), fetchQuizzes(client, {})]);
        if (!qs.ok) errors.push(qs.error);
        else {
          for (const q of qs.data.questions) {
            const o = questionOutcome(q);
            const tagList = q.tags.length ? q.tags : ["(untagged)"];
            for (const tag of tagList) {
              const t = topicFor(tag, q.section);
              t.available++;
              if (o.attempted) record(t, "gregmat", o.graded, o.correct);
            }
            if (o.attempted) {
              recordSection(q.section, o.graded, o.correct);
              if (o.proxy) proxyUsed = true;
            }
          }
        }
        if (!quizzes.ok) errors.push(quizzes.error);
        else {
          const bySec: Record<string, number[]> = {};
          for (const z of quizzes.data.quizzes) if (z.percent !== null) (bySec[z.section] ??= []).push(z.percent);
          quizSummary = Object.fromEntries(
            Object.entries(bySec).map(([s, arr]) => [s, { quizzes: arr.length, average_percent: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 }]),
          );
        }
        if (include_sectional_tests) {
          try {
            const token = await client.auth.getToken();
            sectional = await scrapeSectionalTests(token);
          } catch (e) {
            sectional = { error: (e as Error).message, ...(e instanceof ScraperUnavailableError ? { hint: "optional dependency" } : { hint: `${CONFIG_HINT} (PAGES/SELECTORS)` }) };
          }
        }
      }
      for (const e of log.entries) {
        const graded = e.correct !== undefined;
        record(topicFor(e.topic, e.section), "local_log", graded, !!e.correct);
        recordSection(e.section, graded, !!e.correct);
      }

      const all = [...topics.values()].map((t) => ({ ...t, accuracy: pct(t.correct, t.graded) }));
      for (const s of Object.values(sections)) s.accuracy = pct(s.correct, s.graded);
      const ranked = all.filter((t) => t.graded >= minA).sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0) || b.graded - a.graded);
      const attemptedNames = all.filter((t) => t.attempted > 0).map((t) => t.topic.toLowerCase());
      const unattemptedHighYield = (["quant", "verbal"] as const).flatMap((sec) =>
        HIGH_YIELD_TOPICS[sec]
          .filter((h) => {
            const words = h.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
            return !attemptedNames.some((a) => a.includes(h.toLowerCase()) || words.some((w) => a.includes(w)));
          })
          .map((h) => ({ topic: h, section: sec })),
      );
      const unattemptedGregmatTags = all
        .filter((t) => t.attempted === 0 && t.available >= 5)
        .sort((a, b) => b.available - a.available)
        .slice(0, 15)
        .map((t) => ({ topic: t.topic, section: t.section, questions_available: t.available }));

      return jsonResult({
        derived: true,
        method:
          "Derived, not an official GregMAT diagnostic. Accuracy = correct / graded attempts per tag, from /ps/questions/ per-user status plus local-log entries with `correct`." +
          (proxyUsed ? " Where GregMAT exposes only solved/attempted (no correctness), 'solved' counts as correct and 'attempted but not solved' as incorrect (proxy)." : ""),
        ...testInfo(),
        sections,
        weakest_topics: ranked.slice(0, n),
        strongest_topics: ranked.slice(-n).reverse(),
        topics_ranked_count: ranked.length,
        topics_below_min_attempts: all.filter((t) => t.attempted > 0 && t.graded < minA).map((t) => ({ topic: t.topic, graded: t.graded })),
        unattempted_high_yield: unattemptedHighYield,
        unattempted_gregmat_tags: unattemptedGregmatTags,
        quiz_average_by_section: quizSummary,
        ...(sectional !== undefined ? { sectional_tests_scrape: sectional } : {}),
        ...(errors.length ? { errors } : {}),
        ...(log.error ? { local_log_error: log.error } : {}),
      });
    }),
  );

  // 6. get_study_plan_progress ----------------------------------------------
  server.registerTool(
    "get_study_plan_progress",
    {
      title: "Study plan progress",
      description:
        "GregMAT study plan progress (/studyplans/{slug}/): units done/total, next undone units, and the per-day pace needed to finish by the test date.",
      inputSchema: {
        slug: z.string().optional().describe("Study plan slug (default GREGMAT_STUDY_PLAN or the-im-overwhelmed-study-plan)"),
        next_n: z.number().int().min(1).max(100).optional().describe("How many upcoming undone units to list (default 10)"),
      },
    },
    safe(async ({ slug, next_n }: { slug?: string; next_n?: number }) => {
      const s = slug ?? defaultStudyPlan();
      const r = await fetchStudyPlan(client, s);
      const ti = testInfo();
      if (!r.ok) return jsonResult({ ...r.error, ...ti }, true);
      const units = r.data.plan.units;
      const done = units.filter((u) => u.done === true).length;
      const remaining = units.filter((u) => u.done !== true);
      const days = Math.max(ti.days_until_test, 0);
      const doneDates = units.filter((u) => u.done && u.date).map((u) => localDay(u.date!));
      return jsonResult({
        slug: s,
        title: r.data.plan.title,
        done,
        total: units.length,
        percent: pct(done, units.length),
        remaining: remaining.length,
        ...ti,
        pacing: {
          units_per_day_needed: days > 0 ? Math.round((remaining.length / days) * 10) / 10 : remaining.length,
          note: days > 0 ? `${remaining.length} units over ${days} days` : "Test date reached or passed",
          last_unit_done_on: doneDates.sort().pop() ?? null,
        },
        next_units: remaining.slice(0, next_n ?? 10),
        ...(r.data.plan.shape_note ? { note: r.data.plan.shape_note, raw_shape: r.data.raw_shape, hint: CONFIG_HINT } : {}),
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
