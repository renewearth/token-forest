// Sticky Claude Code session attribution (controller Rulings R6, R18, R20, R21).
//
// The same message (message.id|requestId) can sit in several transcript files
// (resume/fork copies earlier lines). Within one run the parser attributes it
// to the smallest sessionId it saw — but an incremental run sees only recently
// touched files, so a later fork with a smaller id would move the message to
// another session key, and the server (max-merge per key) would count it
// twice. This index pins the FIRST assignment forever:
//   $STATE_DIR/claude-attr.json = { version: 2, entries: { <key16>: sessionId } }
// key16 = sha1(`${message.id}|${requestId}`) first 16 hex chars (no message
// ids stored in clear).
//
// Pruning (R20): only after a FULL run (every local file scanned), pins whose
// key was not seen anywhere in that run are dropped — the message is gone
// from this machine, so no later run can re-attribute it. Incremental runs
// never prune (they see only part of the files).
// Saving merges with the file on disk, on-disk keys winning (R21), so a run
// that overlapped another can never flip a pin the other one wrote.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { statePath, writeStateFile } from "./state-dir.mjs";

const FILE = "claude-attr.json";

export function attrKey(dedupKey) {
  return createHash("sha1").update(dedupKey).digest("hex").slice(0, 16);
}

// → Map<key16, sessionId>. Missing/corrupt file → empty map.
export function loadAttribution() {
  const map = new Map();
  let json;
  try {
    json = JSON.parse(readFileSync(statePath(FILE), "utf8"));
  } catch {
    return map;
  }
  const entries = json && typeof json.entries === "object" && json.entries ? json.entries : {};
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v === "string" && v) map.set(k, v);
  }
  return map;
}

// Write `map` merged with the current on-disk index (on-disk values win).
// `seen` (a Set of key16, only for a full run) drops every pin not in it.
export function saveAttribution(map, { seen } = {}) {
  const merged = new Map(map);
  for (const [k, v] of loadAttribution()) merged.set(k, v);
  const entries = {};
  for (const [k, v] of merged) {
    if (!seen || seen.has(k)) entries[k] = v;
  }
  writeStateFile(FILE, JSON.stringify({ version: 2, entries }) + "\n");
}
