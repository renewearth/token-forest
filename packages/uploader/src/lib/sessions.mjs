// Session-grained rows (collection v2). Every parser turns its usage events
// (one per billable message / cumulative delta / API call) into rows keyed by
// (tool, sessionId, hour, model). The server max-merges rows with the same key,
// so the same session seen on several devices (Syncthing replicas) counts once.
//
// sessionId is sent WITHOUT a `tool:` prefix — the server key includes `tool`.
// hour is the KST bucket ("YYYY-MM-DDTHH"), same as the v1 hourly mirror.

import { kstHour } from "./kst.mjs";
import { MIXED_ORG, cleanOrg, mergeAccount } from "./claude-account.mjs";

// Bump when a parser's counting changes: the server overwrites rows from an
// older parserVersion instead of max-merging, so a corrected parser can lower a
// previously over-counted value.
// 3 (final-review F3): the grok fallback sessionId changed from raw machineId
// chars to a sha1 device tag — a new key, so the bump makes the server's R8
// drop the old-key grok buckets on the forced full resend.
export const PARSER_VERSION = 4;

const METRICS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests"];
export const metricEvidence = (row, field) => row.fieldEvidence?.[field] ??
  (typeof row[field] === "number" && Number.isFinite(row[field]) ? "known" : "unknown");
export function addMetric(acc, row, field) {
  const value = row[field];
  const previous = acc.fieldEvidence?.[field];
  const next = metricEvidence(row, field);
  acc.fieldEvidence ??= {};
  acc.fieldEvidence[field] = previous === undefined ? next :
    previous === "known" && next === "known" ? "known" :
    previous === "unsupported" && next === "unsupported" ? "unsupported" : "unknown";
  if (typeof value === "number" && Number.isFinite(value)) acc[field] = (acc[field] ?? 0) + value;
}
export function emptyMetrics() {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheCreationTokens: null, requests: null, fieldEvidence: {} };
}

// Code-unit comparison (not localeCompare) so the order is identical on every
// machine regardless of locale/ICU.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// events: [{ tool, sessionId, ts (ISO), model, provider?, inputTokens,
//            outputTokens, cacheReadTokens, cacheCreationTokens, hour? }]
// → [{ tool, sessionId, hour, model, provider, inputTokens, outputTokens,
//      cacheReadTokens, cacheCreationTokens, requests, parserVersion }]
// Token fields are summed per key; requests = number of events. provider is ""
// when unknown (the first non-empty provider seen for a key wins). An event may
// carry accountOrg/accountEvidence (lib/claude-account.mjs); the row keeps the
// strongest evidence and becomes "mixed" on a same-rank disagreement. Sorted by
// (tool, sessionId, hour, model). A parser that already computed the KST
// `hour` may pass it (then ts is not re-parsed); otherwise hour = kstHour(ts),
// and events with an unparseable ts are dropped.
export function bucketEvents(events) {
  const acc = new Map();
  for (const e of events) {
    let hour = typeof e.hour === "string" && e.hour ? e.hour : "";
    if (!hour) {
      const ms = new Date(e.ts).getTime();
      if (Number.isNaN(ms)) continue;
      hour = kstHour(ms);
    }
    const model = e.model ?? "";
    const key = JSON.stringify([e.tool, e.sessionId, hour, model]);
    let row = acc.get(key);
    if (!row) {
      row = {
        tool: e.tool,
        sessionId: e.sessionId,
        hour,
        model,
        provider: "",
        ...emptyMetrics(),
        dateBasis: e.dateBasis ?? "KST",
        fieldEvidence: { sessions: e.fieldEvidence?.sessions ?? "known" },
        parserVersion: PARSER_VERSION,
      };
      acc.set(key, row);
    }
    if (!row.provider && typeof e.provider === "string" && e.provider) row.provider = e.provider;
    if (e.accountOrg) mergeAccount(row, e.accountOrg, e.accountEvidence);
    for (const field of METRICS) addMetric(row, field === "requests" ? { requests: e.requests ?? 1, fieldEvidence: e.fieldEvidence } : e, field);
    if (row.fieldEvidence.sessions !== (e.fieldEvidence?.sessions ?? "known")) row.fieldEvidence.sessions = "unknown";
    if (row.dateBasis !== (e.dateBasis ?? "KST")) row.dateBasis = "미확인";
  }
  return [...acc.values()].sort(
    (a, b) =>
      cmp(a.tool, b.tool) ||
      cmp(a.sessionId, b.sessionId) ||
      cmp(a.hour, b.hour) ||
      cmp(a.model, b.model),
  );
}

// Client-side mirror of the server's usageSessionRowSchema (src/lib/types.ts,
// final-review F4). The server validates `sessions` strictly, so ONE bad row
// (an over-long id from a log, a fractional token count) would 400 the whole
// request every cycle. Such rows are dropped here instead and counted as
// unrecognized in that parser's health. Keep the limits in sync with the
// server schema.
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const COUNT_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests"];
const str = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;
export function isValidSessionRow(r) {
  if (!r || typeof r !== "object") return false;
  if (!str(r.tool, 1, 40) || !str(r.sessionId, 1, 200)) return false;
  if (typeof r.hour !== "string" || !HOUR_RE.test(r.hour)) return false;
  if (r.model !== undefined && !str(r.model, 0, 200)) return false;
  if (r.provider !== undefined && !str(r.provider, 0, 60)) return false;
  if (r.accountOrg !== undefined || r.accountEvidence !== undefined) {
    if (r.accountOrg !== MIXED_ORG && !cleanOrg(r.accountOrg)) return false;
    if (!["transcript", "hook"].includes(r.accountEvidence)) return false;
  }
  for (const f of COUNT_FIELDS) {
    const v = r[f];
    if (v != null && !(Number.isInteger(v) && v >= 0)) return false;
  }
  if (r.dateBasis !== undefined && !["KST", "UTC", "미확인"].includes(r.dateBasis)) return false;
  if (r.fieldEvidence !== undefined) {
    if (!r.fieldEvidence || typeof r.fieldEvidence !== "object" || Array.isArray(r.fieldEvidence)) return false;
    for (const value of Object.values(r.fieldEvidence)) if (!["known", "unknown", "unsupported"].includes(value)) return false;
  }
  return Number.isInteger(r.parserVersion) && r.parserVersion >= 1;
}

// A parser result with invalid session rows removed; the dropped count is
// added to health.linesUnrecognized and sessionsEmitted is corrected.
export function dropInvalidSessions(result) {
  const sessions = result?.sessions ?? [];
  const valid = sessions.filter(isValidSessionRow);
  const dropped = sessions.length - valid.length;
  if (dropped === 0) return result;
  const health = result.health
    ? {
        ...result.health,
        linesUnrecognized: (result.health.linesUnrecognized ?? 0) + dropped,
        sessionsEmitted: valid.length,
      }
    : result.health;
  return { ...result, sessions: valid, health };
}

// Parser health, sent alongside sessions so the server can spot a CLI format
// change that silently drops recognition (files grow, sessions don't).
// linesUnrecognized = non-empty lines that were not valid JSON.
export function makeHealth(parser, { filesScanned = 0, linesUnrecognized = 0 }, sessions) {
  return { parser, filesScanned, linesUnrecognized, sessionsEmitted: sessions.length };
}

// File name without directory and extension (".jsonl").
export function fileStem(file) {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.[^.]*$/, "");
}
