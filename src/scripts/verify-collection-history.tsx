import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb, connectDb, Member, MemberIdentity, UsageDaily, SyncRun } from "@/lib/db";
import { getMemberCollectionHistory, getUsageFreshness } from "@/lib/collection-history";
import { buildToolCollectionRows, collectionOverviewSchema } from "@/lib/collection-overview";
import { CollectionRows, CollectionStatusContent } from "@/app/collection/ToolCollectionOverview";

async function main() {
  if (process.env.MONGODB_URI !== "mongodb://127.0.0.1:27398/tf-v2-test-status-fix") throw Error("Disposable status-fix DB required");
  await connectDb();
  const id = new Types.ObjectId(), other = new Types.ObjectId(), email = `${randomUUID()}@example.test`;
  const ids: Types.ObjectId[] = [];
  let passes = 0;
  const check = (label: string, run: () => void) => { run(); passes++; console.log(`PASS ${label}`); };
  try {
    await Member.collection.insertOne({ _id: id, name: "Own fixture", email });
    const documents = [
      { memberId: id, externalId: email, tool: "claude_code", date: "2026-10-08", source: "uploader", updatedAt: new Date("2026-10-07T16:00:00Z") },
      { memberId: null, externalId: email, tool: "codex", date: "2026-10-05", source: "uploader", updatedAt: new Date("2026-10-07T15:00:00Z") },
      { memberId: other, externalId: email, tool: "opencode", date: "2026-10-08", source: "uploader", updatedAt: new Date("2026-10-07T17:00:00Z") },
      { memberId: null, externalId: "unknown-fixture", tool: "opencode", date: "2026-10-08", source: "uploader" },
    ].map(row => ({ ...row, _id: new Types.ObjectId() }));
    ids.push(...documents.map(row => row._id));
    await UsageDaily.collection.insertMany(documents);
    const own = await getMemberCollectionHistory({ id: String(id), email });
    check("history contains own and own unlinked uploader rows, never another member", () => assert.deepEqual(own.history.map(row => row.tool), ["claude_code", "codex"]));
    check("credentials are reported only as booleans", () => assert.deepEqual(own.copilot, { identityConfigured: false, credentialConfigured: false }));
    const empty = collectionOverviewSchema.parse({ protocolVersion: 3, scope: "authenticated_member", recordCount: 0, conflictCount: 0, staleChains: 0, sourceStatus: [], deviceStatus: [] });
    check("legacy receipt is visible even when protocol 3 is empty", () => {
      const row = buildToolCollectionRows(empty, own.history).find(r => r.id === "claude_code")!;
      assert.equal(row.label, "기존 기록 수신 이력");
      assert.equal(row.history?.latestUsageDate, "2026-10-08");
      const html = renderToStaticMarkup(<CollectionRows data={empty} history={own.history} />);
      assert.match(html, /기존 기록 수신 이력/); assert.match(html, /2026-10-08/);
      assert.doesNotMatch(html, /기기 연결 확인 필요/);
    });
    check("missing history cannot be interpreted as disconnected or zero usage", () => {
      const html = renderToStaticMarkup(<CollectionRows data={empty} history={[]} />);
      assert.match(html, /사용량 0을 뜻하지 않습니다/); assert.doesNotMatch(html, /연결 안 됨|미설치|기기 연결 확인 필요/);
    });
    check("failed or unavailable new status preserves verified legacy history", () => {
      for (const kind of ["error", "unavailable"] as const) {
        const html = renderToStaticMarkup(<CollectionStatusContent state={{ kind }} history={own.history} reload={() => {}} />);
        assert.match(html, /role="alert"/); assert.match(html, /data-legacy-fallback/);
        assert.match(html, /2026-10-08/); assert.match(html, /Codex/);
        assert.doesNotMatch(html, /새 기록 수신 기기/);
      }
    });
    check("health-only heartbeat never claims device record receipt", () => {
      const health = structuredClone(empty);
      health.deviceStatus.push({ machineId: "health-only", label: null, lastReceiptAt: "2026-10-07T17:00:00.000Z", pending: null, reportedRejected: null, readErrors: null, healthStatus: "ok", parserHealth: [{ parser: "codex", records: 0 }], sources: [] });
      const row = buildToolCollectionRows(health).find(r => r.id === "codex")!;
      assert.equal(row.devices.length, 1); assert.equal(row.receivedDevices.length, 0); assert.equal(row.lastReceiptAt, null);
      const html = renderToStaticMarkup(<CollectionRows data={health} />);
      assert.match(html, /새 기록 수신 기기<\/p><p[^>]*>0대/); assert.match(html, /상태 보고 1대/); assert.doesNotMatch(html, /새 기록 수신 1대/);
    });
    check("source receipt remains visible when device metadata is unavailable", () => {
      const sourceOnly = structuredClone(empty);
      sourceOnly.sourceStatus.push({ tool: "codex", accountId: "fixture", recordCount: 1, conflictCount: 0, lastSourceAt: "2026-10-07T16:00:00.000Z", lastReceiptAt: "2026-10-07T17:00:00.000Z", unverifiedCount: 0, healthStatus: "ok" });
      assert.equal(buildToolCollectionRows(sourceOnly).find(r => r.id === "codex")!.lastReceiptAt, "2026-10-07T17:00:00.000Z");
    });
    check("new source errors take priority over historical receipt", () => {
      const broken = structuredClone(empty);
      broken.sourceStatus.push({ tool: "claude_code", accountId: "fixture", recordCount: 0, conflictCount: 0, lastSourceAt: null, lastReceiptAt: null, unverifiedCount: 0, healthStatus: "error" });
      assert.equal(buildToolCollectionRows(broken, own.history).find(r => r.id === "claude_code")!.label, "읽기 오류 확인");
      broken.sourceStatus[0].conflictCount = 1;
      assert.equal(buildToolCollectionRows(broken, own.history).find(r => r.id === "claude_code")!.label, "기록 충돌 확인");
    });
    await MemberIdentity.collection.insertOne({ memberId: id, tool: "copilot", externalId: "history-fixture" });
    await Member.collection.updateOne({ _id: id }, { $set: { githubTokenEnc: "synthetic-never-serialize" } });
    const configured = await getMemberCollectionHistory({ id: String(id), email });
    check("configured credentials never serialize stored values", () => {
      assert.deepEqual(configured.copilot, { identityConfigured: true, credentialConfigured: true });
      assert(!JSON.stringify(configured).includes("synthetic-never-serialize"));
    });
    await SyncRun.collection.insertOne({ tool: "claude_code", status: "ok", lastSyncedDate: "2026-07-26", ranAt: new Date("2026-10-07T16:00:30Z"), message: "status-fix-fixture" });
    const freshness = (await getUsageFreshness()).find(row => row.tool === "claude_code")!;
    check("API cursor date never replaces actual usage date or receipt time", () => {
      assert.equal(freshness.latestUsageDate, "2026-10-08");
      assert.equal(freshness.lastReceivedAt, "2026-10-07T16:00:00.000Z");
      assert.equal(freshness.apiCheckedAt, "2026-10-07T16:00:30.000Z");
    });
    console.log(`${passes} collection history checks passed`);
  } finally {
    await UsageDaily.collection.deleteMany({ _id: { $in: ids } });
    await MemberIdentity.collection.deleteMany({ memberId: id });
    await Member.collection.deleteOne({ _id: id });
    await SyncRun.collection.deleteMany({ message: "status-fix-fixture" });
    await closeDb();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
