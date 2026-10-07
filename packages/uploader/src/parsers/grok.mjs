// Parser for Grok usage logged by the direct x.ai API wrappers (grok-q /
// grok-web), which write ONE line per API call to ~/.local/share/grok-usage.jsonl:
//   { ts, tool:"chat"|"web", model, prompt_tokens, completion_tokens,
//     total_tokens, cost_in_usd_ticks }
// grok-cli (@vibe-kit/grok-cli) is abandoned here (broken against x.ai), so we
// do NOT parse its sessions — this wrapper log is the source of truth.
//
// Unlike codex/gemini, each line is a PER-CALL usage delta (not a cumulative
// snapshot), so there is nothing to diff — sum straight into daily rows.
// `ts` is UNIX epoch SECONDS. prompt→input, completion→output; the wrappers
// expose no cache metric (cacheRead/cacheCreation = null). cost_in_usd_ticks is
// recorded raw but not converted to cents (tick→USD unit unconfirmed).
//
// Same { tool, aggregate } contract as codex.mjs / gemini.mjs.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { kstDate, kstHour } from "../lib/kst.mjs";
import { deviceTag } from "../lib/device-id.mjs";
import { addMetric, bucketEvents, emptyMetrics, makeHealth } from "../lib/sessions.mjs";

export const tool = "grok";

function num(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// epoch seconds (10-digit) → ms; pass through if already ms (13-digit).
function toMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

// Session id for collection v2 (Ruling R7). The wrapper log (as of 2026-09)
// carries no session/conversation id, so we use one pseudo-session per device
// per KST day: `grok-<deviceTag(machineId)>-<KST date>` (sha1-derived tag, never
// raw machineId chars — F3). This log is a
// single per-machine file written by the local wrappers — NOT a session
// transcript and never Syncthing-replicated — so the same lines never exist on
// two devices and no cross-device dedup is needed. The machine prefix keeps two
// devices of one member from sharing a server key (which has no machine), so
// their rows are summed rather than max-merged. With no machineId the id is
// `grok-<KST date>`. If a future wrapper version logs an id, it is used as-is.
const SESSION_ID_FIELDS = ["session_id", "sessionId", "conversation_id", "conversationId"];
function sessionIdFor(entry, date, machineId) {
  for (const f of SESSION_ID_FIELDS) {
    const v = entry?.[f];
    if (typeof v === "string" && v) return v;
  }
  const device = deviceTag(machineId);
  return device ? `grok-${device}-${date}` : `grok-${date}`;
}

function logPath() {
  return path.join(homedir(), ".local", "share", "grok-usage.jsonl");
}

// Turn parsed log lines into daily rows + hourly mirror + session rows. Each
// line is one call.
export function assembleRows(lines, machineId = "", sinceDate) {
  const days = new Map();  // `${date}|${model}` -> acc
  const hours = new Map(); // `${hour}|${model}` -> acc
  const sessionEvents = [];

  for (const entry of lines) {
    const ms = toMs(entry?.ts);
    if (Number.isNaN(ms)) continue;
    const model = typeof entry.model === "string" && entry.model ? entry.model : "grok";
    const date = kstDate(ms);
    if (sinceDate && date < sinceDate) continue;
    const hour = kstHour(ms);
    const input = num(entry.prompt_tokens);
    const output = num(entry.completion_tokens);

    sessionEvents.push({
      tool, sessionId: sessionIdFor(entry, date, machineId), ts: new Date(ms).toISOString(), hour, model,
      inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheCreationTokens: null,
      fieldEvidence: { cacheReadTokens: "unsupported", cacheCreationTokens: "unsupported", sessions: "unsupported" },
    });

    const dk = `${date}|${model}`;
    let d = days.get(dk);
    if (!d) {
      d = { date, model, ...emptyMetrics() };
      days.set(dk, d);
    }
    for (const f of ["inputTokens", "outputTokens", "requests"]) addMetric(d, { inputTokens: input, outputTokens: output, requests: 1 }, f);

    const hk = `${hour}|${model}`;
    let h = hours.get(hk);
    if (!h) {
      h = { hour, model, ...emptyMetrics() };
      hours.set(hk, h);
    }
    for (const f of ["inputTokens", "outputTokens", "requests"]) addMetric(h, { inputTokens: input, outputTokens: output, requests: 1 }, f);
  }

  const rows = [...days.values()]
    .sort((a, b) =>
      a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date))
    .map((acc) => ({
      date: acc.date,
      tool,
      model: acc.model,
      machineId,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      requests: acc.requests,
      fieldEvidence: { ...acc.fieldEvidence, cacheReadTokens: "unsupported", cacheCreationTokens: "unsupported", sessions: "unsupported" },
      dateBasis: "KST",
      // No session concept in the wrapper log — leave unknown (consumers SUM,
      // null contributes 0) rather than fabricate a count from calls.
      sessions: null,
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
      cacheReadTokens: null,
      cacheCreationTokens: null,
      requests: acc.requests,
      fieldEvidence: { ...acc.fieldEvidence, cacheReadTokens: "unsupported", cacheCreationTokens: "unsupported" },
      dateBasis: "KST",
      source: "uploader",
    }));

  return { rows, hourlyRows, sessions: bucketEvents(sessionEvents) };
}

// Same { rows, hourlyRows, sessions, health, stats } contract as codex.mjs / gemini.mjs.
export async function aggregate({ sinceDate, machineId = "" } = {}) {
  const stats = { files: 0, linesRead: 0, malformed: 0, events: 0 };
  const file = logPath();
  const empty = () => ({
    rows: [], hourlyRows: [], sessions: [],
    health: makeHealth(tool, { filesScanned: stats.files, linesUnrecognized: stats.malformed }, []),
    stats,
  });

  // mtime window starts at KST midnight of sinceDate (events use KST dates).
  const sinceMs = sinceDate ? Date.parse(`${sinceDate}T00:00:00+09:00`) : 0;
  let mtimeMs;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return empty(); // no log yet
  }
  if (sinceMs && mtimeMs < sinceMs) return empty();

  const lines = [];
  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    stats.files = 1;
    for await (const line of rl) {
      if (!line) continue;
      stats.linesRead++;
      try {
        lines.push(JSON.parse(line));
      } catch {
        stats.malformed++;
      }
    }
  } catch {
    return empty(); // unreadable log
  }

  const { rows, hourlyRows, sessions } = assembleRows(lines, machineId, sinceDate);
  stats.events = rows.reduce((n, r) => n + (r.requests ?? 0), 0);
  const health = makeHealth(
    tool,
    { filesScanned: stats.files, linesUnrecognized: stats.malformed },
    sessions,
  );
  return { rows, hourlyRows, sessions, health, stats };
}
