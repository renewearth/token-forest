// Parser for Codex CLI session rollouts (~/.codex/sessions/**/rollout-*.jsonl).
//
// Token usage arrives as CUMULATIVE snapshots:
//   { type:"event_msg", timestamp, payload:{ type:"token_count",
//     info:{ total_token_usage:{ input_tokens, cached_input_tokens, output_tokens } } } }
// The active model is the most recent `turn_context.model` line. We diff the
// running total so repeated/streaming snapshots add nothing and a reset (total
// drops) rebaselines. `input_tokens` INCLUDES cached, so non-cache input =
// input_tokens − cached_input_tokens. Codex exposes no cache-write metric.
//
// Sibling of claude-code.mjs — same { tool, aggregate } contract.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { deviceTag } from "../lib/device-id.mjs";
import { kstDate, kstHour } from "../lib/kst.mjs";
import { addMetric, bucketEvents, emptyMetrics, fileStem, makeHealth } from "../lib/sessions.mjs";

export const tool = "codex";

// Fold ONE rollout file's parsed JSON lines into a flat list of delta events:
//   { date, hour, ts, model, inputTokens, cacheReadTokens, outputTokens, cacheCreationTokens }
// One event per counted (non-zero) cumulative delta. Pure — no I/O.
export function foldSession(lines) {
  let model = "";
  let started = false;
  const prev = { input: 0, cached: 0, output: 0 };
  const events = [];

  for (const entry of lines) {
    if (entry?.type === "turn_context" && typeof entry.payload?.model === "string") {
      model = entry.payload.model;
      continue;
    }
    if (entry?.type !== "event_msg" || entry?.payload?.type !== "token_count") continue;
    const info = entry.payload.info?.total_token_usage;
    const ts = entry.timestamp;
    if (!info || !ts) continue;
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) continue;

    const token = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
    const totInput = token(info.input_tokens);
    const totCached = token(info.cached_input_tokens);
    const totOutput = token(info.output_tokens);

    // Reset detection is per field. An omitted field stays unknown and leaves
    // its baseline untouched, so a later snapshot cannot recount old usage.
    const baseInput = !started || (totInput !== null && totInput < prev.input) ? 0 : prev.input;
    const baseCached = !started || (totCached !== null && totCached < prev.cached) ? 0 : prev.cached;
    const baseOutput = !started || (totOutput !== null && totOutput < prev.output) ? 0 : prev.output;
    started = true;

    const dInput = totInput === null ? null : totInput - baseInput;
    const dCached = totCached === null ? null : totCached - baseCached;
    const dOutput = totOutput === null ? null : totOutput - baseOutput;
    if (totInput !== null) prev.input = totInput;
    if (totCached !== null) prev.cached = totCached;
    if (totOutput !== null) prev.output = totOutput;

    if ([dInput, dCached, dOutput].every((v) => v === 0 || v === null)) continue;

    events.push({
      date: kstDate(ts),
      hour: kstHour(ts),
      ts: parsed.toISOString(),
      model,
      inputTokens: dInput === null || dCached === null ? null : Math.max(0, dInput - dCached), // input_tokens includes cached
      cacheReadTokens: dCached,
      outputTokens: dOutput,
      cacheCreationTokens: null,
      fieldEvidence: { cacheCreationTokens: "unsupported" },
    });
  }
  return events;
}

// Merge per-file event lists (each = foldSession output for one rollout) into
// daily rows and an hourly mirror. sessions = number of files with activity on
// a given day, attached to that day's FIRST row only (consumers SUM sessions).
export function assembleRows(fileEvents, machineId = "") {
  const days = new Map();   // `${date}|${model}` -> acc
  const hours = new Map();  // `${hour}|${model}` -> acc
  const sessionsByDay = new Map(); // date -> count of files active that day

  fileEvents.forEach((events) => {
    const daysTouched = new Set();
    for (const e of events) {
      daysTouched.add(e.date);
      const dk = `${e.date}|${e.model}`;
      let d = days.get(dk);
      if (!d) {
        d = { date: e.date, model: e.model, ...emptyMetrics() };
        days.set(dk, d);
      }
      for (const f of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]) addMetric(d, e, f);
      addMetric(d, { requests: 1 }, "requests");

      const hk = `${e.hour}|${e.model}`;
      let h = hours.get(hk);
      if (!h) {
        h = { hour: e.hour, model: e.model, ...emptyMetrics() };
        hours.set(hk, h);
      }
      for (const f of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]) addMetric(h, e, f);
      addMetric(h, { requests: 1 }, "requests");
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
      fieldEvidence: { ...acc.fieldEvidence, sessions: "known" },
      dateBasis: "KST",
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
      fieldEvidence: acc.fieldEvidence,
      dateBasis: "KST",
      source: "uploader",
    }));

  return { rows, hourlyRows };
}

// Codex session id = the UUID at the end of the rollout file name
// (rollout-<local datetime>-<uuid>.jsonl). Falls back to the file stem.
const ROLLOUT_UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function sessionIdFromFile(file) {
  const stem = fileStem(file);
  return ROLLOUT_UUID.exec(stem)?.[1] ?? stem;
}

function sessionsRoot() {
  return path.join(homedir(), ".codex", "sessions");
}

async function* rolloutFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing ~/.codex/sessions → nothing to scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* rolloutFiles(full);
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

// Same { rows, hourlyRows, sessions, health, stats } contract as claude-code.mjs.
export async function aggregate({ sinceDate, machineId = "" } = {}) {
  const stats = { files: 0, linesRead: 0, malformed: 0, events: 0 };
  // mtime window starts at KST midnight of sinceDate (events use KST dates).
  const sinceMs = sinceDate ? Date.parse(`${sinceDate}T00:00:00+09:00`) : 0;
  const fileEvents = [];
  const sessionEvents = [];

  for await (const file of rolloutFiles(sessionsRoot())) {
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
    const sessionId = sessionIdFromFile(file);
    for (const e of events) {
      sessionEvents.push({
        tool, sessionId, ts: e.ts, hour: e.hour, model: e.model,
        inputTokens: e.inputTokens, outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens, cacheCreationTokens: e.cacheCreationTokens,
        fieldEvidence: e.fieldEvidence,
      });
    }
  }

  const { rows, hourlyRows } = assembleRows(fileEvents, machineId);
  const sessions = bucketEvents(sessionEvents);
  const health = makeHealth(
    tool,
    { filesScanned: stats.files, linesUnrecognized: stats.malformed },
    sessions,
  );
  return { rows, hourlyRows, sessions, health, stats };
}

// ─── Rate-limit snapshot (plan windows) ─────────────────────────────────────
// token_count event lines also carry the account's rate-limit windows
// (measured 2026-09-30):
//   payload.rate_limits = { limit_id:"codex", limit_name:null,
//     primary:{ used_percent, window_minutes, resets_at (epoch s) },
//     secondary:null | { ... }, credits:{ ... } }
// Some accounts have primary 300-minute + secondary 10080-minute windows,
// others a single 10080-minute primary. We take the most recent rate_limits
// event (by timestamp) across the most recently modified rollout files and
// turn each non-null window into a /api/limits snapshot. Only numbers and the
// limit id leave the machine — never credits, paths or content.

// How many of the most recently modified rollout files latestLimits reads.
// The live session's file is normally the newest; a few more cover a session
// whose latest lines carry no rate_limits yet.
export const LIMIT_FILES = 5;

// The most recent rate_limits event in one file's parsed lines:
// { ts (ms), rateLimits } or null. Lines without a parseable timestamp are
// ordered by position (a later line wins a tie).
export function latestRateLimits(lines) {
  let best = null;
  for (const entry of lines) {
    const rateLimits = entry?.payload?.rate_limits ?? entry?.rate_limits;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const ms = new Date(entry.timestamp).getTime();
    const ts = Number.isNaN(ms) ? -Infinity : ms;
    if (!best || ts >= best.ts) best = { ts, rateLimits };
  }
  return best;
}

// Snapshot organization: "device:" + deviceTag(machineId) = sha1 of this
// machine's pseudonymous device id, first 8 hex (never the hostname, and never
// raw chars of a --machine-id override — F3), so one member's devices on
// different Codex plans don't overwrite each other's rows on the server
// (key = date, member, accountEmail, organization, window). "" without an id.
export function deviceOrganization(machineId) {
  const tag = deviceTag(machineId);
  return tag ? `device:${tag}` : "";
}

// One rate_limits object → LimitSnapshotInput[] (server schema unchanged):
// primary then secondary, each { date: KST today, accountEmail:
// "codex:" + limit_id, organization: deviceOrganization(machineId),
// window: "codex_<minutes>m", utilizationPct: used_percent,
// resetsAt: ISO(resets_at * 1000) | null }.
// Skipped: a null window, one without window_minutes / used_percent, and a
// STALE one (Ruling R23) — its reset already passed (resets_at*1000 <= now) or
// the reading is older than the window itself (eventTs < now − minutes). An
// unknown eventTs counts as stale: the snapshot is stamped with today's date,
// so an old percentage must never pass for a fresh one.
export function limitsToSnapshots(rateLimits, { now = new Date(), eventTs, machineId } = {}) {
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const nowMs = now.getTime();
  const evMs = typeof eventTs === "number" && Number.isFinite(eventTs) ? eventTs : -Infinity;
  const limitId = typeof rateLimits.limit_id === "string" && rateLimits.limit_id ? rateLimits.limit_id : "codex";
  const organization = deviceOrganization(machineId);
  const date = kstDate(now);
  const out = [];
  for (const w of [rateLimits.primary, rateLimits.secondary]) {
    if (!w || typeof w !== "object") continue;
    const minutes = w.window_minutes;
    const used = w.used_percent;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) continue;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
    const hasReset = typeof w.resets_at === "number" && Number.isFinite(w.resets_at);
    if (hasReset && w.resets_at * 1000 <= nowMs) continue; // window already rolled over
    if (evMs < nowMs - minutes * 60_000) continue; // reading older than the window
    out.push({
      date,
      accountEmail: `codex:${limitId}`,
      organization,
      window: `codex_${minutes}m`,
      utilizationPct: used,
      resetsAt: hasReset ? new Date(w.resets_at * 1000).toISOString() : null,
    });
  }
  return out;
}

async function readJsonLines(file) {
  const lines = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // malformed line — not a rate_limits event
    }
  }
  return lines;
}

// files: rollout paths. Reads the LIMIT_FILES most recently modified ones and
// snapshots the newest rate_limits event among them (stale windows dropped,
// see limitsToSnapshots); [] when none has any.
// Unreadable / vanished files are skipped.
export async function latestLimits(files, { now = new Date(), machineId } = {}) {
  const withMtime = [];
  for (const file of files) {
    try {
      withMtime.push({ file, mtimeMs: (await stat(file)).mtimeMs });
    } catch {
      // gone since listing
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let best = null;
  for (const { file } of withMtime.slice(0, LIMIT_FILES)) {
    let lines;
    try {
      lines = await readJsonLines(file);
    } catch {
      continue;
    }
    const found = latestRateLimits(lines);
    if (found && (!best || found.ts > best.ts)) best = found;
  }
  return best ? limitsToSnapshots(best.rateLimits, { now, eventTs: best.ts, machineId }) : [];
}

// Snapshot this machine's Codex plan windows from ~/.codex/sessions.
// machineId = the pseudonymous device id (config.machineId).
export async function snapshotLimits({ now = new Date(), machineId } = {}) {
  const files = [];
  for await (const file of rolloutFiles(sessionsRoot())) files.push(file);
  return latestLimits(files, { now, machineId });
}
