#!/usr/bin/env node
// Local usage audit for reconciliation (collection v2, Task 10).
//
// Counts this machine's local AI-tool logs per tool × KST date WITHOUT
// sessionization — an independent tally to hold the uploader's session rows
// (and, server side, usagesessions) against:
//   claude_code  every assistant usage line, deduped GLOBALLY by
//                message.id|requestId (first sighting wins), <synthetic> skipped
//   codex        per rollout file, the sum of cumulative token_count deltas
//                (per-field rebaseline on a drop; input excludes cached)
//   gemini       per session file, echoes deduped by id, cumulative deltas
//                (input excludes cached, thoughts folded into output)
//   grok         per API-call line sums (including explicit zero-token calls)
//   opencode     per assistant message sums (output = output + reasoning)
// requests = counted events (lines / deltas / messages).
//
// Read-only: opens files for reading and opencode.db read-only with ONE
// statement against the `message` table (never account/credential). Prints
// only counts and field-evidence labels per tool × date — no content, ids or paths.
// No network, no server, no state dir.
//
// Usage: node audit-local.mjs [--since YYYY-MM-DD]
//   (HOME decides which logs are read, like the uploader.)

import { createReadStream, existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { kstDate } from "../lib/kst.mjs";

export const TOOLS = ["claude_code", "codex", "gemini", "grok", "opencode"];
const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests"];

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
const tokenNum = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;

// Recursively yield files under `dir` whose name passes `match`. Missing or
// unreadable dirs yield nothing (counted in `errors.dirs`).
async function* walk(dir, match, errors, isRoot = true) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (!(isRoot && err?.code === "ENOENT")) errors.dirs++;
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, match, errors, false);
    else if (e.isFile() && match(e.name)) yield full;
  }
}

// Parsed JSON lines of one file; malformed lines counted, never kept.
async function readLines(file, errors) {
  const out = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      errors.malformedLines++;
    }
  }
  return out;
}

function makeTally() {
  const byDate = new Map();
  return {
    add(ts, v) {
      const date = kstDate(ts);
      let t = byDate.get(date);
      if (!t) byDate.set(date, (t = { ...Object.fromEntries(FIELDS.map((f) => [f, null])), fieldEvidence: {} }));
      for (const f of FIELDS) {
        const value = f === "requests" ? 1 : v[f];
        const evidence = f === "requests" ? "known" : v.fieldEvidence?.[f] ?? (value === null ? "unknown" : "known");
        const previous = t.fieldEvidence[f];
        t.fieldEvidence[f] = previous === undefined ? evidence :
          previous === "known" && evidence === "known" ? "known" :
          previous === "unsupported" && evidence === "unsupported" ? "unsupported" : "unknown";
        if (value !== null) t[f] = (t[f] ?? 0) + value;
      }
    },
    toJSON(sinceDate) {
      return Object.fromEntries(
        [...byDate.entries()]
          .filter(([d]) => !sinceDate || d >= sinceDate)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    },
  };
}

const validTs = (ts) => ts != null && !Number.isNaN(new Date(ts).getTime());

async function auditClaude(home, tally, info) {
  const seen = new Set();
  for await (const file of walk(path.join(home, ".claude", "projects"), (n) => n.endsWith(".jsonl"), info.errors)) {
    info.files++;
    for (const e of await readLines(file, info.errors)) {
      const usage = e?.message?.usage;
      if (e?.type !== "assistant" || !usage) continue;
      if ((e.message.model ?? "") === "<synthetic>") continue;
      const key = `${e.message.id ?? ""}|${e.requestId ?? ""}`;
      if (seen.has(key)) continue; // counted once across every file
      seen.add(key);
      if (!validTs(e.timestamp)) continue;
      tally.add(e.timestamp, {
        inputTokens: tokenNum(usage.input_tokens),
        outputTokens: tokenNum(usage.output_tokens),
        cacheReadTokens: tokenNum(usage.cache_read_input_tokens),
        cacheCreationTokens: tokenNum(usage.cache_creation_input_tokens),
      });
    }
  }
}

// Cumulative snapshots → deltas, each field rebaselined to 0 on its own drop.
function cumulativeDeltas(snapshots, fields) {
  const prev = Object.fromEntries(fields.map((f) => [f, 0]));
  let started = false;
  const out = [];
  for (const s of snapshots) {
    const d = {};
    for (const f of fields) {
      const base = !started || (s[f] !== null && s[f] < prev[f]) ? 0 : prev[f];
      d[f] = s[f] === null ? null : s[f] - base;
      if (s[f] !== null) prev[f] = s[f];
    }
    started = true;
    out.push({ ts: s.ts, d });
  }
  return out;
}

async function auditCodex(home, tally, info) {
  const match = (n) => n.startsWith("rollout-") && n.endsWith(".jsonl");
  for await (const file of walk(path.join(home, ".codex", "sessions"), match, info.errors)) {
    info.files++;
    const snaps = [];
    for (const e of await readLines(file, info.errors)) {
      if (e?.type !== "event_msg" || e?.payload?.type !== "token_count") continue;
      const u = e.payload.info?.total_token_usage;
      if (!u || !validTs(e.timestamp)) continue;
      snaps.push({ ts: e.timestamp, input: tokenNum(u.input_tokens), cached: tokenNum(u.cached_input_tokens), output: tokenNum(u.output_tokens) });
    }
    for (const { ts, d } of cumulativeDeltas(snaps, ["input", "cached", "output"])) {
      if ([d.input, d.cached, d.output].every((x) => x === 0 || x === null)) continue;
      tally.add(ts, {
        inputTokens: d.input === null || d.cached === null ? null : Math.max(0, d.input - d.cached),
        outputTokens: d.output,
        cacheReadTokens: d.cached,
        cacheCreationTokens: null,
        fieldEvidence: { cacheCreationTokens: "unsupported" },
      });
    }
  }
}

async function auditGemini(home, tally, info) {
  const match = (n) => n.startsWith("session-") && n.endsWith(".jsonl");
  for await (const file of walk(path.join(home, ".gemini", "tmp"), match, info.errors)) {
    info.files++;
    const ids = new Set();
    const snaps = [];
    for (const e of await readLines(file, info.errors)) {
      if (e?.type !== "gemini" || !e.tokens) continue;
      if (e.id != null) {
        if (ids.has(e.id)) continue; // streaming echo
        ids.add(e.id);
      }
      if (!validTs(e.timestamp)) continue;
      const t = e.tokens;
      snaps.push({ ts: e.timestamp, input: tokenNum(t.input), cached: tokenNum(t.cached), output: tokenNum(t.output), thoughts: tokenNum(t.thoughts) });
    }
    for (const { ts, d } of cumulativeDeltas(snaps, ["input", "cached", "output", "thoughts"])) {
      const out = d.output === null && d.thoughts === null ? null : (d.output ?? 0) + (d.thoughts ?? 0);
      if ([d.input, d.cached, out].every((x) => x === 0 || x === null)) continue;
      tally.add(ts, {
        inputTokens: d.input === null || d.cached === null ? null : Math.max(0, d.input - d.cached),
        outputTokens: out,
        cacheReadTokens: d.cached,
        cacheCreationTokens: null,
        fieldEvidence: { cacheCreationTokens: "unsupported", outputTokens: d.output === null || d.thoughts === null ? "unknown" : "known" },
      });
    }
  }
}

async function auditGrok(home, tally, info) {
  const file = path.join(home, ".local", "share", "grok-usage.jsonl");
  if (!existsSync(file)) return;
  info.files++;
  for (const e of await readLines(file, info.errors)) {
    const n = Number(e?.ts);
    if (!Number.isFinite(n)) continue;
    const ms = n < 1e12 ? n * 1000 : n;
    const input = tokenNum(e.prompt_tokens);
    const output = tokenNum(e.completion_tokens);
    tally.add(ms, { inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheCreationTokens: null,
      fieldEvidence: { cacheReadTokens: "unsupported", cacheCreationTokens: "unsupported" } });
  }
}

async function auditOpencode(home, tally, info) {
  // Same lookup as the parser: $XDG_DATA_HOME/opencode first, then ~/.local/share.
  const xdg = process.env.XDG_DATA_HOME;
  const xdgFile = xdg && path.isAbsolute(xdg) ? path.join(xdg, "opencode", "opencode.db") : "";
  const file = xdgFile && existsSync(xdgFile)
    ? xdgFile
    : path.join(home, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(file)) return;
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    info.error = "node:sqlite unavailable";
    return;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    info.error = "unreadable db";
    return;
  }
  try {
    info.files++;
    // The only statement run against this DB (message table only).
    for (const row of db.prepare("SELECT time_created, data FROM message").all()) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        info.errors.malformedLines++;
        continue;
      }
      if (data?.role !== "assistant" || !data.tokens || typeof data.tokens !== "object") continue;
      const ms = num(data.time?.created) || num(Number(row.time_created));
      if (!ms) continue;
      const t = data.tokens;
      const output = tokenNum(t.output);
      const reasoning = tokenNum(t.reasoning);
      tally.add(ms, {
        inputTokens: tokenNum(t.input),
        outputTokens: output === null && reasoning === null ? null : (output ?? 0) + (reasoning ?? 0),
        cacheReadTokens: tokenNum(t.cache?.read),
        cacheCreationTokens: tokenNum(t.cache?.write),
        fieldEvidence: { outputTokens: output === null || reasoning === null ? "unknown" : "known" },
      });
    }
  } catch (err) {
    info.error = /no such (table|column)/i.test(String(err?.message)) ? "schema mismatch" : "unreadable db";
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

const AUDITORS = {
  claude_code: auditClaude,
  codex: auditCodex,
  gemini: auditGemini,
  grok: auditGrok,
  opencode: auditOpencode,
};

// → { sinceDate, tools: { tool: { date: totals } }, scan: { tool: { files,
// dirErrors, malformedLines, error? } } }. sinceDate filters by KST date.
export async function audit({ sinceDate, home = homedir() } = {}) {
  const tools = {};
  const scan = {};
  for (const tool of TOOLS) {
    const tally = makeTally();
    const info = { files: 0, errors: { dirs: 0, malformedLines: 0 } };
    await AUDITORS[tool](home, tally, info);
    tools[tool] = tally.toJSON(sinceDate);
    scan[tool] = {
      files: info.files,
      dirErrors: info.errors.dirs,
      malformedLines: info.errors.malformedLines,
      ...(info.error ? { error: info.error } : {}),
    };
  }
  return { sinceDate: sinceDate ?? null, tools, scan };
}

async function main() {
  const args = process.argv.slice(2);
  let sinceDate;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") sinceDate = args[++i];
    else if (args[i] === "-h" || args[i] === "--help") {
      console.log("usage: node audit-local.mjs [--since YYYY-MM-DD]  — raw local usage per tool × KST date (JSON)");
      return;
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  if (sinceDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate ?? "")) {
    console.error("--since must be YYYY-MM-DD");
    process.exit(2);
  }
  const result = await audit({ sinceDate });
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
}

// Main guard. Node resolves a symlinked entry to its real path for
// import.meta.url (macOS /tmp → /private/tmp, a linked checkout), so compare
// real paths — a raw argv[1] mismatch would silently print nothing (F7).
function isMain() {
  const arg = process.argv[1];
  if (!arg) return false;
  let real = arg;
  try {
    real = realpathSync(arg);
  } catch {
    // unresolvable → compare the raw path
  }
  return import.meta.url === pathToFileURL(real).href;
}

if (isMain()) {
  main().catch(() => {
    console.error("audit failed");
    process.exit(1);
  });
}
