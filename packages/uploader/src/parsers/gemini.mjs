// Parser for Gemini CLI chat sessions (~/.gemini/tmp/<project>/chats/session-*.jsonl).
//
// Each assistant turn is logged as an entry:
//   { id, timestamp, type:"gemini", model, tokens:{ input, output, cached,
//     thoughts, tool, total } }
// `tokens` is a CUMULATIVE session snapshot (total grows turn over turn), and
// every entry is written TWICE (identical id) — a streaming echo and the final.
// We dedupe by id (first wins), then diff the running totals so each counted
// turn contributes only its own delta and a reset (total drops) rebaselines.
// `input` INCLUDES cached, so non-cache input = input − cached. `thoughts` are
// generated reasoning tokens → folded into output. Gemini exposes no cache-write
// metric (cacheCreation = 0), same as Codex.
//
// Sibling of codex.mjs / claude-code.mjs — same { tool, aggregate } contract.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { kstDate, kstHour } from "../lib/kst.mjs";

export const tool = "gemini";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Fold ONE session file's parsed JSON lines into a flat list of delta events.
// Pure — no I/O. Dedupes echoed entries by id, then diffs cumulative totals.
export function foldSession(lines) {
  let model = "";
  let started = false;
  const seen = new Set();
  const prev = { input: 0, cached: 0, output: 0, thoughts: 0 };
  const events = [];

  for (const entry of lines) {
    if (entry?.type !== "gemini" || !entry.tokens) continue;
    // Model can shift mid-session; attribute each delta to the entry's model.
    if (typeof entry.model === "string" && entry.model) model = entry.model;
    else if (typeof entry.tokens.model === "string" && entry.tokens.model) model = entry.tokens.model;

    // Dedupe the streaming echo: an id is counted once, on first sight.
    if (entry.id != null) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
    }
    const ts = entry.timestamp;
    if (!ts) continue;
    if (Number.isNaN(new Date(ts).getTime())) continue;

    const tk = entry.tokens;
    const totInput = num(tk.input);
    const totCached = num(tk.cached);
    const totOutput = num(tk.output);
    const totThoughts = num(tk.thoughts);

    // Per-field reset detection, independent per field (mirrors codex.mjs): a
    // field dropping below its own baseline rebaselines only that field to 0.
    const baseInput = !started || totInput < prev.input ? 0 : prev.input;
    const baseCached = !started || totCached < prev.cached ? 0 : prev.cached;
    const baseOutput = !started || totOutput < prev.output ? 0 : prev.output;
    const baseThoughts = !started || totThoughts < prev.thoughts ? 0 : prev.thoughts;
    started = true;

    const dInput = totInput - baseInput;
    const dCached = totCached - baseCached;
    const dOutput = totOutput - baseOutput;
    const dThoughts = totThoughts - baseThoughts;
    prev.input = totInput;
    prev.cached = totCached;
    prev.output = totOutput;
    prev.thoughts = totThoughts;

    const outputTokens = dOutput + dThoughts; // reasoning tokens are generated
    if (dInput === 0 && dCached === 0 && outputTokens === 0) continue;

    events.push({
      date: kstDate(ts),
      hour: kstHour(ts),
      model,
      inputTokens: Math.max(0, dInput - dCached), // input includes cached
      cacheReadTokens: dCached,
      outputTokens,
      cacheCreationTokens: 0,
    });
  }
  return events;
}

// Merge per-file event lists into daily rows and an hourly mirror. sessions =
// number of files active on a given day, attached to that day's FIRST row only
// (consumers SUM sessions). Mirror of codex.mjs assembleRows with tool=gemini.
export function assembleRows(fileEvents, machineId = "") {
  const days = new Map();
  const hours = new Map();
  const sessionsByDay = new Map();

  fileEvents.forEach((events) => {
    const daysTouched = new Set();
    for (const e of events) {
      daysTouched.add(e.date);
      const dk = `${e.date}|${e.model}`;
      let d = days.get(dk);
      if (!d) {
        d = { date: e.date, model: e.model, inputTokens: 0, outputTokens: 0,
              cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 };
        days.set(dk, d);
      }
      d.inputTokens += e.inputTokens;
      d.outputTokens += e.outputTokens;
      d.cacheReadTokens += e.cacheReadTokens;
      d.cacheCreationTokens += e.cacheCreationTokens;
      d.requests += 1;

      const hk = `${e.hour}|${e.model}`;
      let h = hours.get(hk);
      if (!h) {
        h = { hour: e.hour, model: e.model, inputTokens: 0, outputTokens: 0,
              cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 };
        hours.set(hk, h);
      }
      h.inputTokens += e.inputTokens;
      h.outputTokens += e.outputTokens;
      h.cacheReadTokens += e.cacheReadTokens;
      h.cacheCreationTokens += e.cacheCreationTokens;
      h.requests += 1;
    }
    for (const date of daysTouched) {
      sessionsByDay.set(date, (sessionsByDay.get(date) ?? 0) + 1);
    }
  });

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
      sessions:
        i === 0 || sorted[i - 1].date !== acc.date
          ? sessionsByDay.get(acc.date) ?? 0
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
      source: "uploader",
    }));

  return { rows, hourlyRows };
}

function chatsRoot() {
  return path.join(homedir(), ".gemini", "tmp");
}

async function* sessionFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing ~/.gemini/tmp → nothing to scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sessionFiles(full);
    } else if (entry.isFile() && entry.name.startsWith("session-") && entry.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

// Same { rows, hourlyRows, stats } contract as codex.mjs / claude-code.mjs.
export async function aggregate({ sinceDate, machineId = "" } = {}) {
  const stats = { files: 0, linesRead: 0, malformed: 0, events: 0 };
  const sinceMs = sinceDate ? Date.parse(`${sinceDate}T00:00:00Z`) : 0;
  const fileEvents = [];

  for await (const file of sessionFiles(chatsRoot())) {
    if (sinceMs) {
      try {
        if ((await stat(file)).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
    }
    stats.files++;
    const lines = [];
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      stats.linesRead++;
      try {
        lines.push(JSON.parse(line));
      } catch {
        stats.malformed++;
      }
    }
    const events = foldSession(lines).filter((e) => !sinceDate || e.date >= sinceDate);
    stats.events += events.length;
    if (events.length) fileEvents.push(events);
  }

  const { rows, hourlyRows } = assembleRows(fileEvents, machineId);
  return { rows, hourlyRows, stats };
}
