// Parser for opencode usage (~/.local/share/opencode/opencode.db, SQLite).
//
// opencode stores one row per chat message in the `message` table:
//   message(id text PK, session_id text, time_created integer ms,
//           time_updated integer, data text JSON)
// Assistant `data` carries per-message usage (a delta, not cumulative):
//   { role:"assistant", modelID, providerID, cost,
//     tokens:{ total, input, output, reasoning, cache:{ read, write } },
//     time:{ created, completed }, ... }
// User messages have no tokens and are skipped. Mapping: input=tokens.input,
// output=tokens.output+tokens.reasoning, cacheRead=cache.read,
// cacheCreation=cache.write.
//
// PRIVACY: the same DB holds other tables with plaintext auth secrets. We run
// exactly ONE statement (QUERY below) against `message`, read-only, and copy
// only numeric/model fields out of `data` — never paths, content or ids other
// than session_id. health.error uses a fixed vocabulary, never exception text
// (which can contain filesystem paths / usernames).
//
// node:sqlite needs Node ≥22.5 (emits an ExperimentalWarning on stderr — left
// as-is on purpose). If it can't load, the parser reports empty + health.error.
//
// Same { tool, aggregate } contract as codex.mjs / grok.mjs.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { kstDate, kstHour } from "../lib/kst.mjs";
import { addMetric, bucketEvents, emptyMetrics, makeHealth } from "../lib/sessions.mjs";

export const tool = "opencode";

const QUERY = "SELECT id, session_id, time_created, data FROM message WHERE time_created >= ?";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function str(v) {
  return typeof v === "string" ? v : "";
}

// opencode keeps its DB under the XDG data dir: $XDG_DATA_HOME/opencode when
// that is set (absolute, per the XDG spec) and the DB exists there, else the
// XDG default ~/.local/share/opencode (final-review F5).
function defaultDbPath() {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && path.isAbsolute(xdg)) {
    const p = path.join(xdg, "opencode", "opencode.db");
    if (existsSync(p)) return p;
  }
  return path.join(homedir(), ".local", "share", "opencode", "opencode.db");
}

let sqlitePromise;
function loadSqlite() {
  sqlitePromise ??= import("node:sqlite").catch(() => null);
  return sqlitePromise;
}

// Map a SQLite / open failure to the fixed health.error vocabulary.
export function classifyError(err) {
  const code = typeof err?.errcode === "number" ? err.errcode & 0xff : -1;
  const msg = String(err?.message ?? "");
  if (code === 5 || code === 6 || /\b(locked|busy)\b/i.test(msg)) return "db locked";
  if (/no such (table|column)/i.test(msg)) return "schema mismatch";
  return "unreadable db";
}

// One message row → usage event, or null when it is not a billable assistant
// message. Throws SyntaxError on malformed JSON (caller counts it).
function eventFromRow(row) {
  const data = JSON.parse(row.data);
  if (!data || typeof data !== "object") return null;
  if (data.role !== "assistant") return null;
  const t = data.tokens;
  if (!t || typeof t !== "object") return null;
  const ms = num(data.time?.created) || num(Number(row.time_created));
  if (!ms) return null;
  const token = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
  const output = token(t.output);
  const reasoning = token(t.reasoning);
  return {
    tool,
    sessionId: str(row.session_id),
    ts: new Date(ms).toISOString(),
    hour: kstHour(ms),
    model: str(data.modelID),
    provider: str(data.providerID),
    inputTokens: token(t.input),
    outputTokens: output === null && reasoning === null ? null : (output ?? 0) + (reasoning ?? 0),
    cacheReadTokens: token(t.cache?.read),
    cacheCreationTokens: token(t.cache?.write),
    fieldEvidence: { outputTokens: output === null || reasoning === null ? "unknown" : "known" },
  };
}

// Fold session rows (bucketEvents output) into v1 fallback rows: daily
// (date|model) with sessions = distinct sessions active that day on the day's
// FIRST row only (consumers SUM sessions), plus the hourly (hour|model) mirror.
export function foldRows(sessions, machineId = "") {
  const days = new Map();
  const hours = new Map();
  const sessionsByDay = new Map(); // date -> Set(sessionId)
  const add = (map, key, init, s) => {
    let acc = map.get(key);
    if (!acc) { acc = { ...init, ...emptyMetrics() }; map.set(key, acc); }
    for (const f of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests"]) addMetric(acc, s, f);
  };
  for (const s of sessions) {
    const date = s.hour.slice(0, 10);
    add(days, `${date}|${s.model}`, { date, model: s.model }, s);
    add(hours, `${s.hour}|${s.model}`, { hour: s.hour, model: s.model }, s);
    let set = sessionsByDay.get(date);
    if (!set) { set = new Set(); sessionsByDay.set(date, set); }
    set.add(s.sessionId);
  }

  const rows = [...days.values()]
    .sort((a, b) =>
      a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date))
    .map((acc, i, sorted) => ({
      date: acc.date,
      tool,
      model: acc.model,
      machineId,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      requests: acc.requests,
      fieldEvidence: { ...acc.fieldEvidence, sessions: "known" },
      dateBasis: "KST",
      sessions:
        i === 0 || sorted[i - 1].date !== acc.date
          ? sessionsByDay.get(acc.date)?.size ?? 0
          : null,
      source: "uploader",
    }));

  const hourlyRows = [...hours.values()]
    .sort((a, b) =>
      a.hour === b.hour ? a.model.localeCompare(b.model) : a.hour.localeCompare(b.hour))
    .map((acc) => ({
      hour: acc.hour,
      tool,
      model: acc.model,
      machineId,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      requests: acc.requests,
      fieldEvidence: acc.fieldEvidence,
      dateBasis: "KST",
      source: "uploader",
    }));

  return { rows, hourlyRows };
}

// Same { rows, hourlyRows, sessions, health, stats } contract as codex.mjs.
// Never throws: a missing DB is an empty result; a locked / foreign / broken DB
// is an empty result with health.error.
export async function aggregate({ sinceDate, machineId = "", dbPath } = {}) {
  const file = dbPath ?? defaultDbPath();
  const stats = { files: 0, linesRead: 0, malformed: 0, events: 0 };
  const empty = (error) => {
    const health = makeHealth(
      tool, { filesScanned: stats.files, linesUnrecognized: stats.malformed }, []);
    if (error) health.error = error;
    return { rows: [], hourlyRows: [], sessions: [], health, stats };
  };

  if (!existsSync(file)) return empty();

  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return empty("node:sqlite unavailable (Node <22.5)");

  // Window starts at KST midnight of sinceDate (events use KST dates).
  const sinceMs = sinceDate ? Date.parse(`${sinceDate}T00:00:00+09:00`) : 0;
  const events = [];
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch (err) {
    return empty(classifyError(err));
  }
  try {
    stats.files = 1;
    const stmt = db.prepare(QUERY);
    const it = typeof stmt.iterate === "function" ? stmt.iterate(sinceMs) : stmt.all(sinceMs);
    for (const row of it) {
      stats.linesRead++;
      let e;
      try {
        e = eventFromRow(row);
      } catch {
        stats.malformed++;
        continue;
      }
      if (!e) continue;
      if (sinceDate && kstDate(e.ts) < sinceDate) continue;
      events.push(e);
    }
  } catch (err) {
    stats.linesRead = 0;
    stats.malformed = 0;
    return empty(classifyError(err));
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }

  stats.events = events.length;
  const sessions = bucketEvents(events);
  const { rows, hourlyRows } = foldRows(sessions, machineId);
  const health = makeHealth(
    tool, { filesScanned: stats.files, linesUnrecognized: stats.malformed }, sessions);
  return { rows, hourlyRows, sessions, health, stats };
}
