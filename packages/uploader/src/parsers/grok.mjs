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
// expose no cache metric (cacheRead/cacheCreation = 0). cost_in_usd_ticks is
// recorded raw but not converted to cents (tick→USD unit unconfirmed).
//
// Same { tool, aggregate } contract as codex.mjs / gemini.mjs.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { kstDate, kstHour } from "../lib/kst.mjs";

export const tool = "grok";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// epoch seconds (10-digit) → ms; pass through if already ms (13-digit).
function toMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

function logPath() {
  return path.join(homedir(), ".local", "share", "grok-usage.jsonl");
}

// Turn parsed log lines into daily rows + hourly mirror. Each line is one call.
export function assembleRows(lines, machineId = "", sinceDate) {
  const days = new Map();  // `${date}|${model}` -> acc
  const hours = new Map(); // `${hour}|${model}` -> acc

  for (const entry of lines) {
    const ms = toMs(entry?.ts);
    if (Number.isNaN(ms)) continue;
    const model = typeof entry.model === "string" && entry.model ? entry.model : "grok";
    const date = kstDate(ms);
    if (sinceDate && date < sinceDate) continue;
    const hour = kstHour(ms);
    const input = num(entry.prompt_tokens);
    const output = num(entry.completion_tokens);
    if (input === 0 && output === 0) continue;

    const dk = `${date}|${model}`;
    let d = days.get(dk);
    if (!d) {
      d = { date, model, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 };
      days.set(dk, d);
    }
    d.inputTokens += input;
    d.outputTokens += output;
    d.requests += 1;

    const hk = `${hour}|${model}`;
    let h = hours.get(hk);
    if (!h) {
      h = { hour, model, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 };
      hours.set(hk, h);
    }
    h.inputTokens += input;
    h.outputTokens += output;
    h.requests += 1;
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
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requests: acc.requests,
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
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requests: acc.requests,
      source: "uploader",
    }));

  return { rows, hourlyRows };
}

// Same { rows, hourlyRows, stats } contract as codex.mjs / gemini.mjs.
export async function aggregate({ sinceDate, machineId = "" } = {}) {
  const stats = { files: 0, linesRead: 0, malformed: 0, events: 0 };
  const file = logPath();

  const sinceMs = sinceDate ? Date.parse(`${sinceDate}T00:00:00Z`) : 0;
  if (sinceMs) {
    try {
      if ((await stat(file)).mtimeMs < sinceMs) return { rows: [], hourlyRows: [], stats };
    } catch {
      return { rows: [], hourlyRows: [], stats }; // no log yet
    }
  }

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
    return { rows: [], hourlyRows: [], stats }; // missing/unreadable log
  }

  const { rows, hourlyRows } = assembleRows(lines, machineId, sinceDate);
  stats.events = rows.reduce((n, r) => n + r.requests, 0);
  return { rows, hourlyRows, stats };
}
