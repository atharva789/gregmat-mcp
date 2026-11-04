/** Local study log: JSON file at $GREGMAT_MCP_HOME/log.json (default ~/.gregmat-mcp/log.json). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logFile } from "./config.js";
import { localDay } from "./normalize.js";

export type LogSection = "quant" | "verbal" | "awa";

export interface LogEntry {
  id: string;
  date: string; // YYYY-MM-DD (local)
  logged_at: string; // ISO timestamp
  source: string;
  section: LogSection;
  topic: string;
  item: string;
  correct?: boolean;
  score?: number;
  time_minutes?: number;
  notes?: string;
}

interface LogFileShape {
  version: 1;
  entries: LogEntry[];
}

export type NewLogEntry = Omit<LogEntry, "id" | "logged_at" | "date" | "source"> & { date?: string; source?: string };

export function readLog(): LogEntry[] {
  const file = logFile();
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as Partial<LogFileShape> | LogEntry[];
  const entries = Array.isArray(parsed) ? parsed : parsed.entries ?? [];
  return entries.filter((e) => e && typeof e === "object");
}

function writeLog(entries: LogEntry[]): void {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const data: LogFileShape = { version: 1, entries };
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function normalizeDateInput(d: string | undefined): string {
  if (!d) return localDay(new Date());
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date "${d}" (use YYYY-MM-DD)`);
  return localDay(parsed);
}

export function addEntry(input: NewLogEntry): LogEntry {
  const entries = readLog();
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    date: normalizeDateInput(input.date),
    logged_at: new Date().toISOString(),
    source: input.source?.trim() || "gregmat",
    section: input.section,
    topic: input.topic.trim(),
    item: input.item.trim(),
  };
  if (input.correct !== undefined) entry.correct = input.correct;
  if (input.score !== undefined) entry.score = input.score;
  if (input.time_minutes !== undefined) entry.time_minutes = input.time_minutes;
  if (input.notes) entry.notes = input.notes;
  entries.push(entry);
  writeLog(entries);
  return entry;
}

export interface LogFilter {
  since?: string;
  section?: string;
  topic?: string;
}

export function filterEntries(entries: LogEntry[], f: LogFilter = {}): LogEntry[] {
  const since = f.since ? normalizeDateInput(f.since) : null;
  const topic = f.topic?.toLowerCase();
  return entries
    .filter((e) => (since ? e.date >= since : true))
    .filter((e) => (f.section ? e.section === f.section : true))
    .filter((e) => (topic ? e.topic.toLowerCase().includes(topic) : true))
    .sort((a, b) => (a.date === b.date ? a.logged_at.localeCompare(b.logged_at) : a.date.localeCompare(b.date)));
}

export interface Bucket {
  count: number;
  graded: number;
  correct: number;
  accuracy: number | null;
  minutes: number;
}

function bucket(): Bucket {
  return { count: 0, graded: 0, correct: 0, accuracy: null, minutes: 0 };
}
function addTo(b: Bucket, e: LogEntry): void {
  b.count++;
  if (e.correct !== undefined) {
    b.graded++;
    if (e.correct) b.correct++;
  }
  b.minutes += e.time_minutes ?? 0;
  b.accuracy = b.graded ? Math.round((b.correct / b.graded) * 1000) / 10 : null;
}

export function aggregate(entries: LogEntry[]) {
  const total = bucket();
  const bySection: Record<string, Bucket> = {};
  const byTopic: Record<string, Bucket & { section: string }> = {};
  const byDay: Record<string, number> = {};
  for (const e of entries) {
    addTo(total, e);
    addTo((bySection[e.section] ??= bucket()), e);
    const key = `${e.section}:${e.topic}`;
    addTo((byTopic[key] ??= { ...bucket(), section: e.section }), e);
    byDay[e.date] = (byDay[e.date] ?? 0) + 1;
  }
  const scores = entries.filter((e) => typeof e.score === "number").map((e) => e.score as number);
  return {
    total,
    by_section: bySection,
    by_topic: Object.fromEntries(Object.entries(byTopic).map(([k, v]) => [k.slice(k.indexOf(":") + 1) + ` (${v.section})`, v])),
    by_day: byDay,
    average_score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    first_date: entries.length ? entries[0].date : null,
    last_date: entries.length ? entries[entries.length - 1].date : null,
  };
}
