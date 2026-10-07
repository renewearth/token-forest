// Parser for Claude Code session transcripts (~/.claude/projects/**/*.jsonl).
//
// Each line is a JSON entry. Assistant turns carry token usage:
//   entry.type === "assistant"
//   entry.message.usage = {
//     input_tokens, output_tokens,
//     cache_read_input_tokens, cache_creation_input_tokens
//   }
//   entry.message.model, entry.message.id
//   entry.requestId, entry.timestamp (ISO), entry.sessionId
//
// Retries emit the same message.id under a fresh requestId, so a *fresh* line
// is a new billable request; true duplicates (identical message.id+requestId)
// are collapsed. Synthetic entries (model "<synthetic>", null usage) are noise.
//
// This module is deliberately self-contained: adding a codex parser later means
// dropping a sibling file that exports the same { tool, aggregate } shape.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { kstDate, kstHour } from "../lib/kst.mjs";
import { addMetric, bucketEvents, emptyMetrics, fileStem, makeHealth } from "../lib/sessions.mjs";
import { attrKey } from "../lib/claude-attr.mjs";

export const tool = "claude_code";

const SYNTHETIC_MODEL = "<synthetic>";

function projectsRoot() {
  return path.join(homedir(), ".claude", "projects");
}

// Recursively yield every *.jsonl path under ~/.claude/projects. A missing or
// unreadable dir yields nothing; `onError` counts it (except a missing root,
// which just means Claude Code was never used here) so a caller can tell an
// incomplete walk from a complete one.
async function* jsonlFiles(dir, onError, isRoot = true) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (!(isRoot && err?.code === "ENOENT")) onError?.();
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* jsonlFiles(full, onError, false);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

function num(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// Aggregate every transcript into daily rows keyed by (KST date, model).
// `sinceDate` is an inclusive "YYYY-MM-DD" lower bound; days before it are
// skipped. Returns { rows, hourlyRows, sessions, health, stats }.
//
// sessions (collection v2): the same counted entries, bucketed per
// (sessionId, KST hour, model). sessionId = entry.sessionId, else the file
// stem. A message (dedupKey message.id|requestId) can appear in several files
// (a resumed/forked session copies earlier lines); it is counted ONCE and
// attributed to the lexicographically smallest sessionId among all of its
// occurrences — independent of scan order, so every device that holds the same
// set of files emits the same session rows (the server max-merges them).
//
// `attribution` (optional, Ruling R6): a Map<attrKey(dedupKey), sessionId> of
// earlier runs' assignments (lib/claude-attr.mjs). An indexed message keeps
// its recorded sessionId even when this run only sees a later fork with a
// smaller id; unindexed messages use the min rule above and are added to the
// map. The same (mutated) map is returned as `attribution`, plus
// `attributionSeen` = every key16 met in this run (in or out of the window —
// the full-run prune set, R20).
// R18: a message pinned to a session that no longer has a file on this
// machine (Claude pruned it) is left out of `sessions` — it was already sent
// under that session while the file existed; re-sending it alone would make
// that session look partial. Counted in stats.skippedPinnedAbsent. (The v1
// daily `rows` still count it: they are per-day totals, not session keyed.)
// Without `attribution` the output is exactly the plain min rule.
export async function aggregate({ sinceDate, machineId = "", attribution } = {}) {
  // key `${date}|${model}` -> accumulator
  const days = new Map();
  // key `${hour}|${model}` -> accumulator (hour = "YYYY-MM-DDTHH", KST). Same
  // counted entries as `days`, bucketed by hour for the additive usage_hourly
  // mirror. No sessions dimension — hourly rows carry token counts only.
  const hours = new Map();
  // dedup set of `${message.id}|${requestId}`
  const seen = new Set();
  // dedupKey -> the counted event (first occurrence's values, same as `rows`);
  // its sessionId is lowered to the smallest id seen on any later duplicate.
  const counted = new Map();
  // per-day distinct sessionIds
  const sessionsByDay = new Map();

  const stats = {
    files: 0,
    linesRead: 0,
    malformed: 0,
    assistantEntries: 0,
    synthetic: 0,
    duplicates: 0,
    counted: 0,
    skippedPinnedAbsent: 0,
    // Directories that could not be read (permissions, vanished mid-walk):
    // the scan is incomplete, so a caller must not prune on it (R20).
    dirErrors: 0,
  };
  // sessionIds that have a file on disk (R18): every file's stem — even files
  // skipped by mtime — plus entry.sessionId of every scanned line.
  const onDisk = new Set();

  // Session files are append-only, so a file untouched since before the window
  // cannot contain in-window lines — skip it without parsing. The window starts
  // at KST midnight of sinceDate (events are filtered by KST date).
  const sinceMs = sinceDate ? Date.parse(`${sinceDate}T00:00:00+09:00`) : 0;

  for await (const file of jsonlFiles(projectsRoot(), () => stats.dirErrors++)) {
    onDisk.add(fileStem(file));
    if (sinceMs) {
      try {
        if ((await stat(file)).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
    }
    stats.files++;
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      stats.linesRead++;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        stats.malformed++;
        continue; // skip malformed lines silently
      }

      const message = entry?.message;
      const usage = message?.usage;
      if (entry?.type !== "assistant" || !usage) continue;
      stats.assistantEntries++;

      const model = message.model ?? "";
      if (model === SYNTHETIC_MODEL) {
        stats.synthetic++;
        continue;
      }

      const dedupKey = `${message.id ?? ""}|${entry.requestId ?? ""}`;
      const sessionId = typeof entry.sessionId === "string" && entry.sessionId ? entry.sessionId : fileStem(file);
      onDisk.add(sessionId);
      if (seen.has(dedupKey)) {
        stats.duplicates++;
        const first = counted.get(dedupKey);
        if (first && sessionId < first.sessionId) first.sessionId = sessionId;
        continue;
      }
      seen.add(dedupKey);

      const ts = entry.timestamp;
      if (!ts) continue;
      const parsed = new Date(ts);
      if (Number.isNaN(parsed.getTime())) continue;
      const date = kstDate(ts); // KST YYYY-MM-DD
      if (sinceDate && date < sinceDate) continue;
      const hour = kstHour(ts); // KST YYYY-MM-DDTHH

      stats.counted++;

      const inputTokens = num(usage.input_tokens);
      const outputTokens = num(usage.output_tokens);
      const cacheReadTokens = num(usage.cache_read_input_tokens);
      const cacheCreationTokens = num(usage.cache_creation_input_tokens);

      counted.set(dedupKey, {
        tool,
        sessionId,
        ts: parsed.toISOString(),
        hour,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      });

      const key = `${date}|${model}`;
      let acc = days.get(key);
      if (!acc) {
        acc = {
          date,
          model,
          ...emptyMetrics(),
        };
        days.set(key, acc);
      }
      for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"])
        addMetric(acc, { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }, field);
      addMetric(acc, { requests: 1 }, "requests");

      const hourKey = `${hour}|${model}`;
      let hacc = hours.get(hourKey);
      if (!hacc) {
        hacc = {
          hour,
          model,
          ...emptyMetrics(),
        };
        hours.set(hourKey, hacc);
      }
      for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"])
        addMetric(hacc, { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }, field);
      addMetric(hacc, { requests: 1 }, "requests");

      if (entry.sessionId) {
        let set = sessionsByDay.get(date);
        if (!set) {
          set = new Set();
          sessionsByDay.set(date, set);
        }
        set.add(entry.sessionId);
      }
    }
  }

  // sessions is a per-day figure (distinct sessions active that day). Attach it
  // to only the FIRST model row of each day — consumers SUM sessions across
  // rows, and copying the day total onto every model row would multiply it by
  // the model count. (Same convention as the Anthropic org connector.)
  const rows = [...days.values()]
    .sort((a, b) =>
      a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date),
    )
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

  // Hour-grained mirror for usage_hourly (heatmap only). Same token counts as
  // `rows`, keyed by hour; no sessions (a per-day figure with no hourly analog).
  const hourlyRows = [...hours.values()]
    .sort((a, b) =>
      a.hour === b.hour ? a.model.localeCompare(b.model) : a.hour.localeCompare(b.hour),
    )
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

  // Sticky attribution: earlier assignments win; new ones are recorded; a pin
  // to a session with no file left on disk drops the message (R18).
  let sessionEvents = counted.values();
  let attributionSeen;
  if (attribution) {
    attributionSeen = new Set();
    for (const dedupKey of seen) attributionSeen.add(attrKey(dedupKey));
    const kept = [];
    for (const [dedupKey, ev] of counted) {
      const prior = attribution.get(attrKey(dedupKey));
      if (prior) {
        if (!onDisk.has(prior)) {
          stats.skippedPinnedAbsent++;
          continue;
        }
        ev.sessionId = prior;
      } else {
        attribution.set(attrKey(dedupKey), ev.sessionId);
      }
      kept.push(ev);
    }
    sessionEvents = kept;
  }

  // Second pass: bucket each counted message under its smallest sessionId
  // (final only now that every file has been scanned).
  const sessions = bucketEvents(sessionEvents);
  const health = makeHealth(
    tool,
    { filesScanned: stats.files, linesUnrecognized: stats.malformed },
    sessions,
  );

  return attribution
    ? { rows, hourlyRows, sessions, health, stats, attribution, attributionSeen }
    : { rows, hourlyRows, sessions, health, stats };
}
