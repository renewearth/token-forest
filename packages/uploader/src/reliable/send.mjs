import { bindOutboxOwner, readOutbox, readReceiptStatuses, acknowledgeExact } from "./outbox.mjs";

export const MAX_RECORDS_PER_REQUEST = 1000;

async function jsonResponse(response) {
  let value;
  try { value = await response.json(); } catch { throw new Error(`protocol3 invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(`protocol3 HTTP ${response.status}`);
  return value;
}

export async function sendReliable({ serverUrl, token, device, health, fetchImpl = fetch }) {
  bindOutboxOwner({ serverUrl, token });
  const endpoint = `${serverUrl.replace(/\/+$/, "")}/api/ingest/records`;
  const headers = { authorization: `Bearer ${token}` };
  const cap = await jsonResponse(await fetchImpl(endpoint, { method: "GET", headers }));
  if (cap.protocolVersion !== 3) throw new Error("server does not support protocol3");
  const all = readOutbox().entries;
  const readErrors = health.reduce((n, h) => n + (h.readErrors || 0), 0);
  const wireHealth = () => {
    const pending = readOutbox().entries;
    const statuses = readReceiptStatuses();
    const rejected = pending.filter((e) => ["rejected", "conflict"].includes(statuses.get(JSON.stringify([e.key, e.digest])))).length;
    return { sources: health, pending: pending.length, rejected, readErrors,
      lastRunAt: new Date().toISOString(),
      status: health.some((h) => h.error) ? "error" :
        readErrors || rejected || health.some((h) => h.linesUnrecognized > 0 || (h.records > 0 && !h.namespaceVerified))
          ? "partial" : "ok" };
  };
  // Older source revisions go first. An ack never clears a newer digest.
  all.sort((a, b) => a.record.revision - b.record.revision || a.key.localeCompare(b.key));
  const batches = all.length ? [] : [[]];
  for (let i = 0; i < all.length; i += MAX_RECORDS_PER_REQUEST) batches.push(all.slice(i, i + MAX_RECORDS_PER_REQUEST));
  let removed = 0, failed = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const body = { protocolVersion: 3, device, records: batch.map((e) => e.record),
      ...(i === 0 ? { health: wireHealth() } : {}) };
    const response = await jsonResponse(await fetchImpl(endpoint, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    if (response.protocolVersion !== 3 || !Array.isArray(response.acknowledgements)) throw new Error("invalid protocol3 acknowledgement");
    const expected = new Set(batch.map((e) => JSON.stringify([e.key, e.digest])));
    const exact = response.acknowledgements.filter((a) => expected.has(JSON.stringify([a?.key, a?.digest])));
    const status = acknowledgeExact(exact);
    removed += status.removed;
    failed += batch.length - status.removed;
  }
  // The first batch reports queued work before acknowledgements. Refresh the
  // device heartbeat after delivery so status reflects remaining conflicts.
  if (all.length) {
    const final = await jsonResponse(await fetchImpl(endpoint, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 3, device, records: [], health: wireHealth() }),
    }));
    if (final.protocolVersion !== 3 || !Array.isArray(final.acknowledgements))
      throw new Error("invalid protocol3 heartbeat acknowledgement");
  }
  return { batches: batches.length + (all.length ? 1 : 0), removed, pending: readOutbox().entries.length, failed };
}
