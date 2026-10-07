// Protocol 3 collectors. No cursor, credentials, limits API, or state writes.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { METRIC_FIELDS, recordKey, recordDigest } from "./records.mjs";

const int = (x) => Number.isSafeInteger(x) && x >= 0 ? x : null;
const str = (x) => typeof x === "string" && x.length > 0 ? x : null;
const hash = (x) => createHash("sha256").update(x).digest("hex");
const iso = (x) => { const ms = Date.parse(x); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const evidence = (metrics, unsupported = []) => Object.fromEntries(METRIC_FIELDS.map((f) => [f, unsupported.includes(f) ? "unsupported" : metrics[f] === null ? "unknown" : "known"]));

function record(base, metrics, unsupported = []) {
  return { ...base, ...metrics, fieldEvidence: evidence(metrics, unsupported) };
}

async function* filesUnder(root, match) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (err) { if (err?.code !== "ENOENT") throw err; return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* filesUnder(full, match);
    else if (entry.isFile() && match(entry.name)) yield full;
  }
}

async function jsonLines(file, health) {
  const text = await readFile(file, "utf8");
  health.filesScanned++;
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { lines.push(JSON.parse(line)); }
    catch { health.linesUnrecognized++; }
  }
  return lines;
}

function base(tool, accountId, recordId, sessionId, kind, occurredAt, model, revision, identityQuality, completeness = "partial", provider = null) {
  return { tool, accountId, recordId, sessionId, kind, occurredAt, model: model || "unknown", provider,
    parserVersion: 1, revision, completeness, identityQuality };
}

// A source row can appear in several resumed/forked transcript files. The
// message+request union is the logical event. Its original session assignment
// is not provable across copies, so the v3 chain is event-scoped. Native
// message+request IDs still verify event identity independently of that
// original session attribution.
async function claude(root, accountId, health) {
  const found = new Map();
  for await (const file of filesUnder(path.join(root, ".claude", "projects"), (n) => n.endsWith(".jsonl"))) {
    let lines;
    try { lines = await jsonLines(file, health); } catch { health.readErrors++; continue; }
    for (const row of lines) {
      if (row?.type !== "assistant" || !row.message?.usage || row.message?.model === "<synthetic>") continue;
      const at = iso(row.timestamp);
      if (!at) { health.linesUnrecognized++; continue; }
      const msg = str(row.message.id), req = str(row.requestId);
      const native = Boolean(msg && req);
      const fallback = str(row.uuid) || JSON.stringify([at, row.message?.model, row.message?.usage]);
      const id = native ? `native:${hash(JSON.stringify([msg, req]))}` : `unverified:${hash(fallback)}`;
      const sessionId = `event:${id}`;
      const usage = row.message.usage;
      const metrics = {
        inputTokens: int(usage.input_tokens), outputTokens: int(usage.output_tokens),
        cacheReadTokens: int(usage.cache_read_input_tokens), cacheCreationTokens: int(usage.cache_creation_input_tokens),
        requests: native ? 1 : null,
      };
      const complete = row.message.stop_reason != null || row.message.stopReason != null;
      const next = record(base("claude_code", accountId, id, sessionId, "event", at,
        str(row.message.model), Date.parse(at), native ? "native" : "unverified", complete ? "final" : "partial"), metrics);
      const group = found.get(id) || [];
      group.push(next);
      found.set(id, group);
    }
  }
  const out = [];
  for (const group of found.values()) {
    const distinct = new Set();
    for (const r of group) {
      const digest = recordDigest(r);
      if (distinct.has(digest)) continue;
      distinct.add(digest);
      out.push(r);
    }
  }
  // Streaming partials reach the server before a final when source timestamps
  // tie; it performs the authoritative fieldwise/final merge.
  out.sort((a, b) => a.revision - b.revision ||
    (a.completeness === "partial" ? 0 : 1) - (b.completeness === "partial" ? 0 : 1) ||
    recordDigest(a).localeCompare(recordDigest(b)));
  return out;
}

async function codex(root, accountId, health, extraDirs = []) {
  const out = [];
  const roots = [path.join(root, ".codex", "sessions"), path.join(root, ".codex", "archived_sessions"), ...extraDirs];
  health.locationsChecked = roots.length;
  health.locationsPresent = 0;
  const files = new Set();
  for (const dir of roots) {
    try { if ((await stat(dir)).isDirectory()) health.locationsPresent++; }
    catch { /* absent source directory is visible through the count */ }
    for await (const file of filesUnder(dir, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) files.add(file);
  }
  for (const file of [...files].sort()) {
    let lines;
    try { lines = await jsonLines(file, health); } catch { health.readErrors++; continue; }
    const stem = path.basename(file, ".jsonl");
    const sessionId = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(stem)?.[1] || stem;
    let model = "unknown";
    for (const row of lines) {
      if (row?.type === "turn_context" && str(row.payload?.model)) model = row.payload.model;
      if (row?.type !== "event_msg" || row.payload?.type !== "token_count" || !row.payload.info?.total_token_usage) continue;
      const at = iso(row.timestamp); if (!at) { health.linesUnrecognized++; continue; }
      const tk = row.payload.info.total_token_usage;
      const all = int(tk.input_tokens), cached = int(tk.cached_input_tokens);
      const metrics = { inputTokens: all, outputTokens: int(tk.output_tokens),
        cacheReadTokens: cached, cacheCreationTokens: null, requests: null };
      // Timestamp is the source observation identity, independent of how many
      // earlier lines a copied or archived file still contains. Same-time
      // collisions remain derived/unverified for server reconciliation.
      out.push(record(base("codex", accountId, `snapshot:${hash(JSON.stringify([sessionId, at]))}`, sessionId,
        "cumulative", at, model, Date.parse(at), "derived"), metrics, ["cacheCreationTokens", "requests"]));
    }
  }
  const unique = new Map();
  for (const r of out) unique.set(JSON.stringify([recordKey(r), recordDigest(r)]), r);
  return [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.recordId.localeCompare(b.recordId));
}

async function gemini(root, accountId, health) {
  const found = new Map();
  for await (const file of filesUnder(path.join(root, ".gemini", "tmp"), (n) => n.startsWith("session-") && n.endsWith(".jsonl"))) {
    let lines;
    try { lines = await jsonLines(file, health); } catch { health.readErrors++; continue; }
    const nativeSessionId = str(lines.find((x) => str(x?.sessionId))?.sessionId);
    const sessionId = `session:${hash(nativeSessionId || path.basename(file, ".jsonl"))}`;
    let ordinal = 0;
    for (const row of lines) {
      if (row?.type !== "gemini" || !row.tokens) continue;
      const at = iso(row.timestamp); if (!at) { health.linesUnrecognized++; continue; }
      ordinal++;
      const native = str(row.id);
      const id = native ? `native:${hash(native)}` : `${sessionId}:snapshot:${ordinal}`;
      const tk = row.tokens;
      const all = int(tk.input), cached = int(tk.cached);
      const output = int(tk.output), thoughts = int(tk.thoughts);
      const metrics = { inputTokens: all, outputTokens: output === null || thoughts === null ? null : output + thoughts,
        cacheReadTokens: cached, cacheCreationTokens: null, requests: null };
      const next = record(base("gemini", accountId, id, sessionId, "cumulative", at,
        str(row.model) || str(tk.model), Date.parse(at), native && nativeSessionId ? "native" : "unverified",
        row.finishReason || row.completed === true ? "final" : "partial"), metrics, ["cacheCreationTokens", "requests"]);
      const group = found.get(id) || [];
      group.push(next);
      found.set(id, group);
    }
  }
  const out = [];
  for (const group of found.values()) {
    const distinct = new Set();
    for (const r of group) {
      const digest = recordDigest(r);
      if (distinct.has(digest)) continue;
      distinct.add(digest);
      out.push(r);
    }
  }
  out.sort((a, b) => a.revision - b.revision ||
    (a.completeness === "partial" ? 0 : 1) - (b.completeness === "partial" ? 0 : 1) ||
    recordDigest(a).localeCompare(recordDigest(b)));
  return out;
}

async function opencode(root, accountId, health, dbPath) {
  const file = dbPath || path.join(root, ".local", "share", "opencode", "opencode.db");
  try { await stat(file); } catch (err) { if (err?.code === "ENOENT") return []; health.readErrors++; return []; }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { health.error = "sqlite_unavailable"; return []; }
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); }
  catch { health.error = "sqlite_unreadable"; return []; }
  try {
    // SQLite extracts only approved scalar fields. JS never receives the
    // message JSON, which may also contain user text or provider secrets.
    const fields = {
      role: "$.role", model: "$.modelID", provider: "$.providerID",
      created: "$.time.created", completed: "$.time.completed",
      input: "$.tokens.input", output: "$.tokens.output", reasoning: "$.tokens.reasoning",
      cacheRead: "$.tokens.cache.read", cacheWrite: "$.tokens.cache.write",
    };
    const projections = Object.entries(fields).map(([name, jsonPath]) =>
      `CASE WHEN json_valid(data) THEN json_extract(data, '${jsonPath}') END AS ${name}`);
    const rows = db.prepare(`SELECT id, session_id, time_created, time_updated,
      json_valid(data) AS valid, ${projections.join(", ")} FROM message`).all();
    health.filesScanned++;
    const out = [];
    for (const row of rows) {
      if (!row.valid) { health.linesUnrecognized++; continue; }
      if (row.role !== "assistant") continue;
      if ([row.input, row.output, row.reasoning, row.cacheRead, row.cacheWrite].every((v) => v === null)) continue;
      const created = Number(row.created || row.time_created);
      const at = Number.isSafeInteger(created) && created >= 0 && created <= 8.64e15
        ? new Date(created).toISOString() : null;
      const nativeId = str(row.id), id = nativeId ? `native:${hash(nativeId)}` : null;
      const rawSessionId = str(row.session_id);
      const sessionId = rawSessionId ? `session:${hash(rawSessionId)}` : null;
      if (!at || !id || !sessionId) { health.linesUnrecognized++; continue; }
      const output = int(row.output), reasoning = int(row.reasoning);
      const metrics = { inputTokens: int(row.input), outputTokens: output === null || reasoning === null ? null : output + reasoning,
        cacheReadTokens: int(row.cacheRead), cacheCreationTokens: int(row.cacheWrite), requests: 1 };
      const updated = int(row.time_updated) || int(row.completed) || int(row.time_created) || Date.parse(at);
      out.push(record(base("opencode", accountId, id, sessionId, "event", at,
        str(row.model), updated, "native", row.completed ? "final" : "partial", str(row.provider)), metrics));
    }
    return out;
  } catch { health.error = "sqlite_schema_mismatch"; return []; }
  finally { db.close(); }
}

async function grok(root, accountId, health) {
  const file = path.join(root, ".local", "share", "grok-usage.jsonl");
  let lines;
  try { lines = await jsonLines(file, health); }
  catch (err) { if (err?.code !== "ENOENT") health.readErrors++; return []; }
  const out = [];
  for (const [index, row] of lines.entries()) {
    const raw = Number(row?.ts);
    const ms = raw < 1e12 ? raw * 1000 : raw;
    if (row?.ts == null || !Number.isSafeInteger(ms) || ms < 0 || ms > 8.64e15) { health.linesUnrecognized++; continue; }
    const at = new Date(ms).toISOString();
    const native = str(row.id) || str(row.request_id) || str(row.requestId);
    const id = native ? `native:${hash(native)}` : `unverified:line:${index + 1}`;
    const nativeSession = str(row.session_id) || str(row.sessionId) || str(row.conversation_id) || str(row.conversationId);
    const sessionId = nativeSession ? `session:${hash(nativeSession)}` : `unverified:day:${at.slice(0, 10)}`;
    const metrics = { inputTokens: int(row.prompt_tokens), outputTokens: int(row.completion_tokens),
      cacheReadTokens: null, cacheCreationTokens: null, requests: native ? 1 : null };
    out.push(record(base("grok", accountId, id, sessionId, "event", at,
      str(row.model), ms, native ? "native" : "unverified", "final"), metrics,
    ["cacheReadTokens", "cacheCreationTokens", ...(native ? [] : ["requests"])]));
  }
  return out;
}

export const SOURCE_TOOLS = Object.freeze(["claude_code", "codex", "gemini", "grok", "opencode"]);

export async function collectRecords({ sourceRoot = homedir(), accounts = {}, opencodeDbPath, codexDirs = [] } = {}) {
  const scans = { claude_code: claude, codex, gemini, grok, opencode };
  const records = [], health = [];
  for (const tool of SOURCE_TOOLS) {
    const configured = accounts[tool];
    if (configured != null && (typeof configured !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(configured)))
      throw new Error(`invalid protocol3 account namespace for ${tool}`);
    const accountId = configured || "unverified:default";
    const h = { parser: tool, accountId, namespaceConfigured: accountId !== "unverified:default",
      namespaceVerified: false,
      filesScanned: 0, linesUnrecognized: 0, readErrors: 0 };
    try {
      const found = tool === "codex"
        ? await codex(sourceRoot, accountId, h, codexDirs)
        : tool === "opencode"
          ? await opencode(sourceRoot, accountId, h, opencodeDbPath)
          : await scans[tool](sourceRoot, accountId, h);
      for (const r of found) {
        if (accountId === "unverified:default") r.identityQuality = "unverified";
        records.push(r);
      }
      h.records = found.length;
    } catch { h.error = "parser_failed"; h.records = 0; }
    health.push(h);
  }
  return { records, health };
}

export function manifest(records, health) {
  return { protocolVersion: 3, total: records.length,
    records: records.map((r) => ({ key: recordKey(r), digest: recordDigest(r), tool: r.tool,
      kind: r.kind, occurredAt: r.occurredAt, revision: r.revision,
      metrics: Object.fromEntries(METRIC_FIELDS.map((f) => [f, r[f]])),
      fieldEvidence: r.fieldEvidence, completeness: r.completeness, identityQuality: r.identityQuality })), health };
}
