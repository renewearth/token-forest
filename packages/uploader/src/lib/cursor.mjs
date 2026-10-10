// Change cursor (collection v2): which window the next upload scans.
//   $STATE_DIR/cursor.json = { lastSuccessAt, lastFullAt, parserVersion }
// (ISO strings + the PARSER_VERSION that produced the last upload).
// Written only after the server accepted the upload. The server merges
// session rows idempotently (per-field max), so re-sending an overlap is safe —
// the window errs wide: it starts one KST day before the last success, and a
// full resend of every local log runs at least weekly (and on the first run).
import { readFileSync } from "node:fs";
import { kstDate } from "./kst.mjs";
import { PARSER_VERSION } from "./sessions.mjs";
import { statePath, writeStateFile } from "./state-dir.mjs";

const FILE = "cursor.json";
export const FULL_RESYNC_MS = 7 * 24 * 3600 * 1000;

function isoOrNull(v) {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

export function readCursor() {
  try {
    const json = JSON.parse(readFileSync(statePath(FILE), "utf8"));
    return {
      lastSuccessAt: isoOrNull(json?.lastSuccessAt),
      lastFullAt: isoOrNull(json?.lastFullAt),
      parserVersion: Number.isInteger(json?.parserVersion) ? json.parserVersion : null,
    };
  } catch {
    return { lastSuccessAt: null, lastFullAt: null, parserVersion: null };
  }
}

// parserVersion defaults to this uploader's PARSER_VERSION.
export function writeCursor({ lastSuccessAt, lastFullAt, parserVersion = PARSER_VERSION }) {
  writeStateFile(FILE, JSON.stringify({ lastSuccessAt, lastFullAt, parserVersion }, null, 2) + "\n");
}

// YYYY-MM-DD minus n days (calendar arithmetic, no timezone involved).
function minusDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// No cursor, no full resend yet, the last full resend older than 7 days, or
// a cursor written by another PARSER_VERSION (missing = old uploader, R19: a
// parser fix must resend everything so the server can replace old buckets)
// → "full" (sinceDate null = every local log). Otherwise "incremental" from
// the KST date of the last success minus one day (bucket-boundary safety).
export function decideWindow(cursor, now = new Date(), parserVersion = PARSER_VERSION) {
  const success = isoOrNull(cursor?.lastSuccessAt);
  const full = isoOrNull(cursor?.lastFullAt);
  if (
    !success ||
    !full ||
    cursor?.parserVersion !== parserVersion ||
    now.getTime() - Date.parse(full) > FULL_RESYNC_MS
  ) {
    return { mode: "full", sinceDate: null };
  }
  return { mode: "incremental", sinceDate: minusDays(kstDate(success), 1) };
}

// TOKEN_FOREST_SINCE (team tracking epoch) is a lower bound on the window,
// not a mode: the window never starts before it; the cursor still advances.
export function applySinceFloor(window, floor) {
  if (!floor) return window;
  if (!window.sinceDate || window.sinceDate < floor) return { ...window, sinceDate: floor };
  return window;
}
