// Cases fixed by the coordinator before dispatching implementation workers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { connectDb, closeDb, Member } from "@/lib/db";
import { UsageRecord, UsageRecordChain, UsageRecordDerived, UsageRecordConflict, UsageRecordDevice, UsageRecordDeviceSource } from "@/lib/db/usage-record";
import { POST } from "@/app/api/ingest/records/route";
import { GET as status } from "@/app/api/me/collection-status/route";
import { type UsageRecord as Wire } from "../../packages/protocol/records.mjs";
import { readCutoverCandidate, applyReviewedCutovers } from "@/lib/collection-cutover-db";
import { ledgerDigest, type CutoverScope } from "@/lib/collection-cutover";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
let passes = 0;
async function main() {
  if (process.env.MONGODB_URI !== "mongodb://127.0.0.1:27398/tf-reliability-test") throw Error("Disposable database required");
  await connectDb();
  const models = [UsageRecord, UsageRecordChain, UsageRecordDerived, UsageRecordConflict, UsageRecordDevice, UsageRecordDeviceSource];
  for (const model of models) await model.init();
  const id = randomUUID(), token = `test-hidden-${id}`, tokenB = `test-other-${id}`;
  const a = await Member.create({ name: "Hidden A", email: `${id}@example.test`, ingestToken: token });
  const b = await Member.create({ name: "Hidden B", email: `b-${id}@example.test`, ingestToken: tokenB });
  const temp = await mkdtemp(path.join(tmpdir(), "tf-hidden-cutover-"));
  const base = (recordId: string, extras: Partial<Wire> = {}): Wire => ({ tool: "claude_code", accountId: "company", recordId, sessionId: "session", kind: "event", occurredAt: "2026-10-01T12:00:00.000Z", model: "model-v1", provider: "test", parserVersion: 1, revision: 1, completeness: "final", identityQuality: "native", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 1, fieldEvidence: { inputTokens: "known", outputTokens: "known", cacheReadTokens: "known", cacheCreationTokens: "known", requests: "known" }, ...extras });
  async function send(records: Wire[], auth = token, machineId = "machine-a") {
    const response = await POST(new NextRequest("http://localhost/api/ingest/records", { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: 3, device: { machineId, uploaderVersion: "hidden" }, records }) }));
    assert.equal(response.status, 200); return response.json();
  }
  async function check(name: string, test: () => Promise<void>) { await test(); passes++; console.log(`PASS ${name}`); }
  try {
    await check("independent equal-valued calls preserve both; copied records deduplicate", async () => {
      await Promise.all([send([base("call-1"), base("call-2")]), send([base("call-2")], token, "renamed-machine")]);
      assert.equal(await UsageRecord.countDocuments({ memberId: a._id }), 2);
      const rows = await UsageRecordDerived.find({ memberId: a._id }).lean();
      const total = rows.flatMap((r) => r.rows as Array<{ grain: string; metrics: { inputTokens: number } }>).filter((r) => r.grain === "day").reduce((n, r) => n + r.metrics.inputTokens, 0);
      assert.equal(total, 200);
    });
    await check("same native IDs under two members remain private", async () => {
      await send([base("call-1")], tokenB);
      const response = await status(new NextRequest("http://localhost/api/me/collection-status", { headers: { authorization: `Bearer ${tokenB}` } }));
      assert.equal((await response.json()).recordCount, 1);
      assert.equal(await UsageRecord.countDocuments({ memberId: a._id }), 2);
    });
    await check("larger parser and larger counter cannot downgrade final completeness", async () => {
      const result = await send([base("call-1", { parserVersion: 9, revision: 99, completeness: "partial", inputTokens: 800 })]);
      assert.equal(result.acknowledgements[0].status, "superseded");
      const r = await UsageRecord.findOne({ memberId: a._id, recordId: "call-1" }).lean();
      assert.equal((r!.semantics as Wire).inputTokens, 100);
    });
    await check("alias correction moves one identity and removes previous model totals", async () => {
      await send([base("call-1", { revision: 2, model: "model-canonical" })]);
      assert.equal(await UsageRecord.countDocuments({ memberId: a._id, recordId: "call-1" }), 1);
      const r = await UsageRecordDerived.findOne({ memberId: a._id, sessionId: "session" }).lean();
      const rows = (r!.rows as Array<{ grain: string; model: string; metrics: { inputTokens: number } }>).filter((x) => x.grain === "day");
      assert.equal(rows.find((x) => x.model === "model-v1")!.metrics.inputTokens, 100);
      assert.equal(rows.find((x) => x.model === "model-canonical")!.metrics.inputTokens, 100);
    });
    await check("partial overlap yields 220 instead of MAX 170", async () => {
      const r1 = base("overlap-1", { sessionId: "overlap" }), r2 = base("overlap-2", { sessionId: "overlap", inputTokens: 50 }), r3 = base("overlap-3", { sessionId: "overlap", inputTokens: 70 });
      await Promise.all([send([r1, r2]), send([r1, r3], token, "machine-b")]);
      const r = await UsageRecordDerived.findOne({ memberId: a._id, sessionId: "overlap" }).lean();
      assert.equal((r!.rows as Array<{ grain: string; metrics: { inputTokens: number } }>).find((x) => x.grain === "day")!.metrics.inputTokens, 220);
    });
    await check("late cumulative observation redistributes two dates and preserves final total", async () => {
      const first = base("snap-1", { sessionId: "chain", kind: "cumulative", occurredAt: "2026-09-29T14:00:00.000Z", inputTokens: 100 });
      const last = base("snap-3", { sessionId: "chain", kind: "cumulative", occurredAt: "2026-09-30T16:00:00.000Z", inputTokens: 350 });
      await send([first, last]);
      await send([base("snap-2", { sessionId: "chain", kind: "cumulative", occurredAt: "2026-09-30T14:00:00.000Z", inputTokens: 230 })]);
      const r = await UsageRecordDerived.findOne({ memberId: a._id, sessionId: "chain" }).lean();
      const rows = (r!.rows as Array<{ grain: string; period: string; metrics: { inputTokens: number } }>).filter((x) => x.grain === "day");
      assert.deepEqual(rows.map((x) => [x.period, x.metrics.inputTokens]), [["2026-09-29", 100], ["2026-09-30", 130], ["2026-10-01", 120]]);
    });
    await check("explicit scoped cutover replaces only local legacy and changed ledger blocks", async () => {
      const docs = await UsageRecord.find({ memberId: b._id }).lean();
      const scope: CutoverScope = { memberId: String(b._id), tool: "claude_code", date: "2026-10-01", accountIds: ["company"], deviceIds: ["machine-a"], expectedCount: 1, ledgerDigest: ledgerDigest(docs.map((r) => ({ semantics: r.semantics as Wire, digest: r.digest }))), inventoryDigest: "a".repeat(64), registeredScopeReviewed: true, reviewedAt: "2026-10-07T00:00:00.000Z" };
      assert.equal((await readCutoverCandidate(scope, "day")).blockers.length, 0);
      assert((await readCutoverCandidate({ ...scope, date: "2026-10-02" }, "day")).blockers.includes("target_day_unobserved"));
      const manifest = path.join(temp, "cutover.json"); await writeFile(manifest, JSON.stringify({ version: 1, scopes: [scope] }));
      process.env.TOKEN_FOREST_RECORD_CUTOVER_FILE = manifest;
      const legacy = { memberId: String(b._id), tool: "claude_code", date: scope.date, source: "uploader", inputTokens: 999, externalId: "", machineId: "", model: "test", hour: "" };
      const selected = await applyReviewedCutovers([legacy], { date: { $gte: "2026-10-01", $lte: "2026-10-01" }, memberId: b._id }, "day");
      assert.equal(selected.reduce((n, r) => n + (r.inputTokens ?? 0), 0), 100);
      await send([base("call-1", { revision: 2, inputTokens: 110 })], tokenB);
      await assert.rejects(() => applyReviewedCutovers([legacy], { memberId: b._id }, "day"), /reconciliation/);
      delete process.env.TOKEN_FOREST_RECORD_CUTOVER_FILE;
    });
  } finally {
    delete process.env.TOKEN_FOREST_RECORD_CUTOVER_FILE;
    for (const model of models) await model.collection.deleteMany({ memberId: { $in: [a._id, b._id] } });
    await Member.deleteMany({ _id: { $in: [a._id, b._id] } });
    await rm(temp, { recursive: true, force: true });
    await closeDb();
  }
  console.log(`${passes} coordinator adversarial scenarios passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
