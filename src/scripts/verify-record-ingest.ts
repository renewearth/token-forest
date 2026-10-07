import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { connectDb, closeDb, Member } from "@/lib/db";
import { UsageRecord, UsageRecordChain, UsageRecordConflict, UsageRecordDerived, UsageRecordDevice, UsageRecordDeviceSource } from "@/lib/db/usage-record";
import { deriveRecordRows } from "@/lib/record-derivation";
import { GET as capability, POST as ingest } from "@/app/api/ingest/records/route";
import { POST as reconcile } from "@/app/api/ingest/records/reconcile/route";
import { GET as status } from "@/app/api/me/collection-status/route";
import { recordDigest, recordKey, type UsageRecord as WireRecord } from "../../packages/protocol/records.mjs";

async function main() {
const URI = "mongodb://127.0.0.1:27398/tf-reliability-test";
if (process.env.MONGODB_URI !== URI) throw new Error(`Refusing non-isolated Mongo URI`);
await connectDb();
if (mongoose.connection.name !== "tf-reliability-test" || mongoose.connection.port !== 27398 || !["127.0.0.1", "localhost"].includes(mongoose.connection.host))
  throw new Error("Refusing unexpected Mongo connection");
await Member.init();

const suffix = randomUUID();
const member = await Member.create({ name: "record-test", email: `record-${suffix}@example.invalid`, ingestToken: `test-${suffix}` });
const other = await Member.create({ name: "record-other", email: `record-other-${suffix}@example.invalid`, ingestToken: `test-other-${suffix}` });
const bearer = `Bearer test-${suffix}`;
const device = { machineId: "dev_123456abcdef", uploaderVersion: "test" };
const base = (recordId: string, overrides: Partial<WireRecord> = {}): WireRecord => ({
  tool: "codex", accountId: "unverified:default", recordId, sessionId: "session-1",
  kind: "event", occurredAt: "2026-10-01T12:00:00.000Z", model: "gpt", provider: null,
  parserVersion: 1, revision: 100, completeness: "partial", identityQuality: "unverified",
  inputTokens: 10, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, requests: null,
  fieldEvidence: { inputTokens: "known" }, ...overrides,
});
function request(path: string, method: string, body?: unknown, token = bearer) {
  return new NextRequest(`http://localhost:3100${path}`, { method,
    headers: { authorization: token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function send(rows: unknown[], token = bearer) {
  const response = await ingest(request("/api/ingest/records", "POST", { protocolVersion: 3, device, records: rows }, token));
  assert.equal(response.status, 200);
  return response.json() as Promise<{ acknowledgements: Array<{ status: string; key: string; digest: string; currentDigest?: string; reasonCode?: string }> }>;
}
try {
  assert.equal((await capability(request("/api/ingest/records", "GET"))).status, 200);
  for (const model of [UsageRecord, UsageRecordChain, UsageRecordConflict, UsageRecordDerived, UsageRecordDevice, UsageRecordDeviceSource]) {
    const indexes = await model.collection.indexes();
    assert(indexes.some((index) => index.unique && index.name !== "_id_"), `${model.modelName} unique index missing after capability`);
  }
  assert.equal((await capability(request("/api/ingest/records", "GET", undefined, "Bearer bad"))).status, 401);

  const a = base("record-a");
  const b = base("record-a", { inputTokens: null, outputTokens: 7, fieldEvidence: { outputTokens: "known" } });
  const concurrent = await Promise.all([send([a]), send([b])]);
  assert(concurrent.every((x) => ["stored", "unchanged", "superseded"].includes(x.acknowledgements[0].status)));
  const stored = await UsageRecord.findOne({ memberId: member._id, recordId: "record-a" }).lean();
  assert(stored);
  assert.equal((stored.semantics as WireRecord).inputTokens, 10);
  assert.equal((stored.semantics as WireRecord).outputTokens, 7);
  assert.equal(await UsageRecord.countDocuments({ memberId: member._id, recordId: "record-a" }), 1);
  assert.equal((await send([a])).acknowledgements[0].status, "superseded");

  const final = base("record-a", { completeness: "final", inputTokens: 11, outputTokens: 8,
    fieldEvidence: { inputTokens: "known", outputTokens: "known" } });
  assert.equal((await send([final])).acknowledgements[0].status, "stored");
  assert.equal((await send([b])).acknowledgements[0].status, "superseded");
  const conflictingFinal = { ...final, inputTokens: 12 };
  assert.equal((await send([conflictingFinal])).acknowledgements[0].status, "conflict");
  assert.equal(await UsageRecordConflict.countDocuments({ memberId: member._id }), 1);
  const correction = { ...conflictingFinal, revision: 101 };
  assert.equal((await send([correction])).acknowledgements[0].status, "stored");
  const parsedByTwo = base("parser-down", { sessionId: "parser-down-session", parserVersion: 2, revision: 100,
    completeness: "final", identityQuality: "native", outputTokens: 100,
    fieldEvidence: { inputTokens: "known", outputTokens: "known" } });
  assert.equal((await send([parsedByTwo])).acknowledgements[0].status, "stored");
  const downgraded = { ...parsedByTwo, parserVersion: 1, revision: 101, outputTokens: 80 };
  const downgradeAck = (await send([downgraded])).acknowledgements[0];
  assert.equal(downgradeAck.status, "conflict");
  assert.equal(downgradeAck.reasonCode, "parser_downgrade");
  assert.equal((await UsageRecord.findOne({ memberId: member._id, recordId: "parser-down" }).lean())?.digest, recordDigest(parsedByTwo));

  const native = base("native-time", { sessionId: "native-session", completeness: "final", identityQuality: "native", revision: 200 });
  assert.equal((await send([native])).acknowledgements[0].status, "stored");
  const moved = { ...native, occurredAt: "2026-10-03T12:00:00.000Z", revision: 201, inputTokens: 5 };
  assert.equal((await send([moved])).acknowledgements[0].status, "stored");
  const movedStored = await UsageRecord.findOne({ memberId: member._id, recordId: "native-time" }).lean();
  assert.equal(movedStored?.date, "2026-10-03");
  assert.equal((movedStored?.semantics as WireRecord).inputTokens, 5);
  const nativeDerived = await UsageRecordDerived.findOne({ memberId: member._id, sessionId: "native-session" }).lean();
  assert(nativeDerived);
  assert.deepEqual((nativeDerived.rows as Array<{ period: string }>).filter((r) => r.period.length === 10).map((r) => r.period), ["2026-10-03"]);
  await UsageRecordDerived.deleteOne({ memberId: member._id, sessionId: "native-session" });
  assert.equal((await send([moved])).acknowledgements[0].status, "unchanged");
  assert(await UsageRecordDerived.exists({ memberId: member._id, sessionId: "native-session" }));

  const mixed = await send([base("invalid", { inputTokens: -1 }), base("valid")]);
  assert.equal(mixed.acknowledgements[0].status, "rejected");
  assert.equal(mixed.acknowledgements[0].key, recordKey(base("invalid")));
  assert.equal(mixed.acknowledgements[0].digest, recordDigest(base("invalid", { inputTokens: -1 })));
  assert.equal(mixed.acknowledgements[1].status, "stored");
  assert.equal((await send([base("other")], "Bearer test-other-" + suffix)).acknowledgements[0].status, "stored");
  assert.equal(await UsageRecord.countDocuments({ memberId: member._id, recordId: "other" }), 0);

  const recResponse = await reconcile(request("/api/ingest/records/reconcile", "POST", { expected: [
    { key: recordKey(correction), digest: recordDigest(correction) },
    { key: recordKey(final), digest: recordDigest(final) },
    { key: recordKey(base("missing")), digest: recordDigest(base("missing")) },
  ] }));
  assert.equal(recResponse.status, 200);
  const comparison = await recResponse.json();
  assert.deepEqual(comparison.results.map((r: { status: string }) => r.status), ["matched", "different", "missing"]);
  const myStatus = await (await status(request("/api/me/collection-status", "GET"))).json();
  assert.equal(myStatus.recordCount, 4);
  assert.equal(myStatus.conflictCount, 2);
  assert.equal(myStatus.reconciliation.globallyComplete, false);
  const secondDevice = { ...device, machineId: "dev_abcdef123456" };
  const parserHealth = [
    { parser: "codex", accountId: "unverified:default", namespaceConfigured: false, namespaceVerified: false, filesScanned: 2, linesUnrecognized: 0, readErrors: 0, records: 1, locationsChecked: 2, locationsPresent: 1 },
    { parser: "gemini", accountId: "unverified:default", namespaceConfigured: false, namespaceVerified: false, filesScanned: 1, linesUnrecognized: 1, readErrors: 0, records: 0 },
    { parser: "grok", accountId: "unverified:default", namespaceConfigured: false, namespaceVerified: false, filesScanned: 0, linesUnrecognized: 0, readErrors: 0, records: 0 },
  ];
  const duplicateResponse = await ingest(request("/api/ingest/records", "POST", { protocolVersion: 3, device: secondDevice, records: [correction], health: { pending: 2, rejected: 1, readErrors: 0, lastRunAt: "2026-10-07T00:00:00.000Z", status: "partial", sources: parserHealth } }));
  assert.equal((await duplicateResponse.json()).acknowledgements[0].status, "unchanged");
  const emptyResponse = await ingest(request("/api/ingest/records", "POST", { protocolVersion: 3, device: secondDevice, records: [], health: { pending: 0, rejected: 0, readErrors: 0, status: "ok", sources: parserHealth } }));
  assert.equal(emptyResponse.status, 200);
  const refreshedStatus = await (await status(request("/api/me/collection-status", "GET"))).json();
  assert.equal(refreshedStatus.deviceStatus.length, 2);
  const copiedDevice = refreshedStatus.deviceStatus.find((d: { machineId: string }) => d.machineId === secondDevice.machineId);
  assert.equal(copiedDevice.receiptCount, 2);
  assert.equal(copiedDevice.pending, 0);
  assert.equal(copiedDevice.parserHealth[0].parser, "codex");
  assert.equal(refreshedStatus.sourceStatus.find((s: { tool: string }) => s.tool === "gemini").healthStatus, "partial");
  assert.equal(refreshedStatus.sourceStatus.find((s: { tool: string }) => s.tool === "grok").healthStatus, "empty");
  assert.equal(refreshedStatus.sourceStatus.find((s: { tool: string }) => s.tool === "codex").namespaceVerified, false);
  assert.equal(refreshedStatus.sourceStatus.find((s: { tool: string }) => s.tool === "codex").locationsChecked, 2);
  assert.equal(copiedDevice.sources[0].tool, "codex");

  const snap = (id: string, at: string, n: number): WireRecord => base(id, { kind: "cumulative", occurredAt: at, completeness: "final", inputTokens: n,
    cacheReadTokens: 0, fieldEvidence: { inputTokens: "known", cacheReadTokens: "known" } });
  const unknownModel = { ...snap("model-copy", "2026-10-04T13:00:00.000Z", 40), sessionId: "model-copy-session", model: "unknown" };
  const knownModel = { ...unknownModel, model: "gpt" };
  assert.equal((await send([unknownModel])).acknowledgements[0].status, "stored");
  assert.equal((await send([knownModel])).acknowledgements[0].status, "stored");
  assert.equal((await send([unknownModel])).acknowledgements[0].status, "superseded");
  assert.equal((await send([{ ...knownModel, model: "other-known" }])).acknowledgements[0].status, "conflict");
  assert.equal((await send([{ ...knownModel, inputTokens: 41 }])).acknowledgements[0].status, "conflict");
  const first = snap("s1", "2026-10-01T13:00:00.000Z", 10);
  const third = snap("s3", "2026-10-02T13:00:00.000Z", 30);
  const second = snap("s2", "2026-10-01T14:00:00.000Z", 20);
  await send([first, third]);
  const before = deriveRecordRows([first, third]);
  assert.deepEqual(before.rows.filter((r) => r.grain === "day").map((r) => r.metrics.inputTokens), [10, 20]);
  await send([second]);
  const after = deriveRecordRows([first, second, third]);
  assert.deepEqual(after.rows.filter((r) => r.grain === "day").map((r) => r.metrics.inputTokens), [20, 10]);
  const ambiguous = deriveRecordRows([first, second, { ...second, recordId: "ambiguous", inputTokens: 25 }, third]);
  assert.equal(ambiguous.conflictCount, 2);
  assert(ambiguous.rows.filter((r) => r.period === "2026-10-02").every((r) => r.verification === "unverified"));
  const resetCandidate = deriveRecordRows([
    { ...snap("reset-a", "2026-10-01T13:00:00.000Z", 100), identityQuality: "native" },
    { ...snap("reset-b", "2026-10-02T13:00:00.000Z", 80), identityQuality: "native" },
    { ...snap("reset-c", "2026-10-03T13:00:00.000Z", 90), identityQuality: "native" },
  ]);
  assert.equal(resetCandidate.conflictCount, 1);
  assert(resetCandidate.rows.filter((r) => r.period >= "2026-10-02" && r.grain === "day").every((r) => r.verification === "unverified"));
  const growingCacheRatio = deriveRecordRows([
    { ...snap("cache-a", "2026-10-01T13:00:00.000Z", 100), cacheReadTokens: 10, identityQuality: "native" },
    { ...snap("cache-b", "2026-10-02T13:00:00.000Z", 150), cacheReadTokens: 80, identityQuality: "native" },
    { ...snap("cache-c", "2026-10-03T13:00:00.000Z", 220), cacheReadTokens: 100, identityQuality: "native" },
  ]);
  assert.deepEqual(growingCacheRatio.rows.filter((r) => r.grain === "day").map((r) => r.metrics.inputTokens), [90, 0, 50]);
  assert.deepEqual(growingCacheRatio.rows.filter((r) => r.grain === "day").map((r) => r.metrics.cacheReadTokens), [10, 70, 20]);
  assert.equal(growingCacheRatio.conflictCount, 1); // cache gain exceeds total gain at second observation
  assert(growingCacheRatio.rows.filter((r) => r.period >= "2026-10-02" && r.grain === "day").every((r) => r.verification === "unverified"));
  const ordinaryCacheGrowth = deriveRecordRows([
    { ...snap("normal-a", "2026-10-01T13:00:00.000Z", 100), cacheReadTokens: 10, identityQuality: "native" },
    { ...snap("normal-b", "2026-10-02T13:00:00.000Z", 200), cacheReadTokens: 60, identityQuality: "native" },
  ]);
  assert.deepEqual(ordinaryCacheGrowth.rows.filter((r) => r.grain === "day").map((r) => r.metrics.inputTokens), [90, 50]);
  assert.equal(ordinaryCacheGrowth.conflictCount, 0);
  const chain = await UsageRecordChain.findOne({ memberId: member._id, sessionId: "session-1" }).lean();
  const derived = await UsageRecordDerived.findOne({ memberId: member._id, sessionId: "session-1" }).lean();
  assert(chain && derived);
  assert.equal(chain.generation, derived.generation);
  console.log("PASS record routes: auth/index readiness, atomic merge, final/correction, parser downgrade blocked, timestamp day move, crash retry, conflicts, per-item rejection, isolation, reconcile, device heartbeat/copy, partial source health, delayed snapshot derivation, unproven reset blocked, raw cumulative input/cache delta, missing model enrichment");
} finally {
  const ids = [member._id, other._id];
  await Promise.all([
    UsageRecord.deleteMany({ memberId: { $in: ids } }), UsageRecordConflict.deleteMany({ memberId: { $in: ids } }),
    UsageRecordChain.deleteMany({ memberId: { $in: ids } }), UsageRecordDerived.deleteMany({ memberId: { $in: ids } }),
    UsageRecordDevice.deleteMany({ memberId: { $in: ids } }), UsageRecordDeviceSource.deleteMany({ memberId: { $in: ids } }),
    Member.deleteMany({ _id: { $in: ids } }),
  ]);
  await closeDb();
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
