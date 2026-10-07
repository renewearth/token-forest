// POST aggregated rows to {serverUrl}/api/ingest with a per-member bearer token.
// The endpoint caps a request at 10000 rows, so batch larger payloads.

const MAX_ROWS_PER_REQUEST = 10_000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Send all rows, batching as needed. Optional `hourly` rows (usage_hourly
// mirror) ride along with the FIRST batch only — every payload must carry >=1
// daily row (the ingest schema requires it), and hourly is derived from the
// same entries as `rows`, so `rows` is empty exactly when `hourly` is. Sending
// hourly once avoids duplicating it across batches (upserts would dedup it, but
// re-sending is wasted payload). Returns { batches, upserted, skipped,
// hourlyUpserted }. Throws on any non-2xx response.
export async function sendRows({ serverUrl, token, rows, hourly }) {
  const batches = chunk(rows, MAX_ROWS_PER_REQUEST);
  let upserted = 0;
  let skipped = 0;
  let hourlyUpserted = 0;
  for (let i = 0; i < batches.length; i++) {
    const body = { rows: batches[i] };
    if (i === 0 && hourly && hourly.length) body.hourly = hourly;
    const res = await fetch(`${serverUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ingest failed (${res.status}): ${text}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    upserted += typeof json.upserted === "number" ? json.upserted : 0;
    skipped += typeof json.skipped === "number" ? json.skipped : 0;
    hourlyUpserted += typeof json.hourlyUpserted === "number" ? json.hourlyUpserted : 0;
  }
  return { batches: batches.length, upserted, skipped, hourlyUpserted };
}

// ─── v2 (collection v2): session rows + parser health + device ─────────────

// Session rows per request (Ruling R14). The server caps a request at 50000,
// but smaller requests keep each upsert short. A single session larger than
// this still goes whole, alone (Ruling R8 — see packSessionBatches).
export const MAX_SESSIONS_PER_REQUEST = 5_000;

// Group session rows by (tool, sessionId) — in first-seen order — and pack
// whole groups into batches of ≤ max rows. A session is NEVER split across
// requests: the server's superseded-bucket cleanup (R8) deletes a session's
// lower-version buckets that are missing from the request, so a split upload
// would delete the buckets carried by the other request. A group larger than
// `max` becomes its own batch.
export function packSessionBatches(sessions, max = MAX_SESSIONS_PER_REQUEST) {
  const groups = new Map();
  for (const s of sessions) {
    const k = JSON.stringify([s.tool, s.sessionId]);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(s);
  }
  const batches = [];
  let cur = [];
  for (const g of groups.values()) {
    if (cur.length > 0 && cur.length + g.length > max) {
      batches.push(cur);
      cur = [];
    }
    cur = cur.concat(g);
    if (cur.length >= max) {
      batches.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

class IngestError extends Error {
  constructor(status, text) {
    super(`ingest failed (${status}): ${String(text).slice(0, 500)}`);
    this.status = status;
    this.text = text;
  }
}

async function postIngest(serverUrl, token, body) {
  const res = await fetch(`${serverUrl}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, text, json: json && typeof json === "object" ? json : {} };
}

// Ruling R2: an old server (pre-v2) answers a v2 payload with 400 because
// `rows` is missing/empty (it strips unknown keys, then rows.min(1) fails) or,
// if strict, because `sessions`/`device`/`health` are unrecognized keys.
function isOldServerRejection(res) {
  if (res.status !== 400 || !Array.isArray(res.json.issues)) return false;
  return res.json.issues.some(
    (i) =>
      i &&
      ((Array.isArray(i.path) && i.path[0] === "rows") || i.code === "unrecognized_keys"),
  );
}

const n = (v) => (typeof v === "number" ? v : 0);

// Send one run's v2 payload. `health` + `device` ride on the FIRST request
// only. With no session rows the single request is a heartbeat
// `{ device, health }` (Ruling R12) that keeps the device's lastSeenAt fresh.
// If the first request is rejected as an old server (R2), everything is
// re-sent the v1 way (`sendRows` with fallbackRows/fallbackHourly). With no
// fallback rows nothing is re-sent: "heartbeat-ignored" for a heartbeat,
// "v1-empty" when there were session rows (all outside the v1 window).
// Returns { mode: "v2" | "heartbeat" | "v1-fallback" | "heartbeat-ignored" | "v1-empty",
// requests, sessionsUpserted, upserted, skipped, hourlyUpserted }. Throws on
// any other non-2xx (nothing is retried; the caller keeps its cursor).
export async function sendV2({ serverUrl, token, sessions, health, device, fallbackRows, fallbackHourly }) {
  const batches = sessions.length > 0 ? packSessionBatches(sessions) : [[]];
  const out = { mode: sessions.length > 0 ? "v2" : "heartbeat", requests: 0, sessionsUpserted: 0, upserted: 0, skipped: 0, hourlyUpserted: 0 };
  for (let i = 0; i < batches.length; i++) {
    const body = {};
    if (batches[i].length > 0) body.sessions = batches[i];
    if (i === 0) {
      body.health = health ?? [];
      body.device = device;
    }
    const res = await postIngest(serverUrl, token, body);
    out.requests++;
    if (!res.ok) {
      if (i === 0 && isOldServerRejection(res)) {
        if (!fallbackRows || fallbackRows.length === 0) {
          return { ...out, mode: sessions.length > 0 ? "v1-empty" : "heartbeat-ignored" };
        }
        const v1 = await sendRows({ serverUrl, token, rows: fallbackRows, hourly: fallbackHourly });
        return {
          mode: "v1-fallback",
          requests: out.requests + v1.batches,
          sessionsUpserted: 0,
          upserted: v1.upserted,
          skipped: v1.skipped,
          hourlyUpserted: v1.hourlyUpserted,
        };
      }
      throw new IngestError(res.status, res.text);
    }
    out.sessionsUpserted += n(res.json.sessionsUpserted);
    out.upserted += n(res.json.upserted);
    out.skipped += n(res.json.skipped);
    out.hourlyUpserted += n(res.json.hourlyUpserted);
  }
  return out;
}

// POST plan-limit snapshots to {serverUrl}/api/limits with the same per-member
// bearer token. Snapshot batches are tiny (a handful of windows per account),
// so no chunking. Returns { upserted }. Throws on any non-2xx response.
export async function sendLimits({ serverUrl, token, snapshots }) {
  const res = await fetch(`${serverUrl}/api/limits`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ snapshots }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`limits upload failed (${res.status}): ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { upserted: typeof json.upserted === "number" ? json.upserted : 0 };
}
