import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import ToolCollectionOverview, { CollectionRows } from "@/app/collection/ToolCollectionOverview";
import { buildToolCollectionRows, collectionOverviewSchema, formatCollectionTime } from "@/lib/collection-overview";

async function main() {
const uri = "mongodb://127.0.0.1:27398/tf-v2-test-collection-preview";
if (process.env.MONGODB_URI !== uri) throw Error("Disposable preview database required");
const origin = "http://127.0.0.1:4812";
const db = (await mongoose.connect(uri)).connection.db!;
const memberId = new mongoose.Types.ObjectId(), token = `synthetic-${randomUUID()}`;
await db.collection("members").insertOne({ _id: memberId, email: `${randomUUID()}@example.test`, name: "Overview fixture", ingestToken: token, identities: [] });
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let passed = 0;
function check(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }
const get = async () => collectionOverviewSchema.parse(await (await fetch(`${origin}/api/me/collection-status`, { headers })).json());
try {
  const empty = await get();
  check("actual empty status preserves five tools and never implies zero usage", () => {
    assert.equal(buildToolCollectionRows(empty).length, 5);
    assert(buildToolCollectionRows(empty).every(r => r.label === "수신 이력 미확인"));
    assert.match(renderToStaticMarkup(<CollectionRows data={empty} />), /사용량 0을 뜻하지 않습니다/);
  });
  check("initial signed-in state has no stale counters", () => {
    const html = renderToStaticMarkup(<ToolCollectionOverview signedIn />);
    assert.match(html, /aria-busy="true"/); assert.doesNotMatch(html, /data-tool=/);
  });
  check("anonymous view offers account connection", () => {
    const html = renderToStaticMarkup(<ToolCollectionOverview signedIn={false} />);
    assert.match(html, /내 계정 연결하기/); assert.doesNotMatch(html, /data-tool=/);
  });
  const parser = (parser: string) => ({ parser, accountId: "fixture-account", namespaceConfigured: true, namespaceVerified: false, filesScanned: 1, linesUnrecognized: 0, readErrors: 0, records: 1 });
  const record = { tool: "codex", accountId: "fixture-account", recordId: "native-fixture", sessionId: "fixture-session", kind: "event", occurredAt: "2026-10-01T00:00:00.000Z", model: "synthetic", provider: null, revision: 1, parserVersion: 1, completeness: "final", identityQuality: "native", inputTokens: 10, outputTokens: 2, requests: 1, fieldEvidence: { inputTokens: "known", outputTokens: "known", requests: "known" } };
  const send = async (machineId: string, health: object, records: object[]) => {
    const response = await fetch(`${origin}/api/ingest/records`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: 3, device: { machineId, label: "테스트 기기", uploaderVersion: "test" }, records, health }) });
    assert.equal(response.status, 200); const body = await response.json(); assert(!body.acknowledgements?.some((a: { status: string }) => a.status === "rejected"));
  };
  await send("one", { pending: 7, rejected: 2, readErrors: 1, status: "partial", sources: [{ ...parser("codex"), readErrors: 1 }, parser("claude_code")] }, [record]);
  await send("two", { status: "ok", sources: [parser("codex")] }, [record]);
  const data = await get(), rows = buildToolCollectionRows(data);
  const codex = rows.find(r => r.id === "codex")!;
  check("duplicate receipt across devices remains one source record", () => { assert.equal(codex.records, 1); assert.equal(codex.devices.length, 2); });
  check("newer healthy device never masks other device read error", () => { assert.equal(codex.label, "읽기 오류 확인"); assert.equal(codex.attention, true); });
  check("parser heartbeat without records does not invent tool receipt time", () => {
    assert.equal(data.sourceStatus.find(s => s.tool === "claude_code")!.lastReceiptAt, null);
    assert.equal(rows.find(r => r.id === "claude_code")!.lastReceiptAt, null);
  });
  check("unknown queue remains unknown while explicit zero remains zero", () => {
    assert.equal(data.deviceStatus.find(d => d.pending === null)?.reportedRejected, null);
    const html = renderToStaticMarkup(<CollectionRows data={data} />);
    assert.match(html, /기기 전체 전송 대기 미확인/); assert.match(html, /기기 전체 전송 대기 7건/); assert.doesNotMatch(html, /14건/);
    const changed = structuredClone(data); changed.deviceStatus[0].pending = 0;
    assert.match(renderToStaticMarkup(<CollectionRows data={changed} />), /기기 전체 전송 대기 0건/);
  });
  check("namespace and receipts cannot imply globally complete collection", () => {
    const clean = structuredClone(data); clean.deviceStatus.forEach(d => d.parserHealth.forEach(p => { p.readErrors = 0; }));
    clean.sourceStatus.forEach(s => { s.healthStatus = "ok"; });
    assert.equal(buildToolCollectionRows(clean).find(r => r.id === "codex")!.label, "기록 수신 · 대조 필요");
    const html = renderToStaticMarkup(<CollectionRows data={clean} />);
    assert.match(html, /전체 대조/); assert.match(html, /미확인/); assert.doesNotMatch(html, /완전 수집|대조 완료/);
  });
  check("account identifiers are escaped", () => {
    const hostile = structuredClone(data); hostile.sourceStatus[0].accountId = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(<CollectionRows data={hostile} />); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
  });
  check("conflicts and pending aggregate refresh have explicit notices", () => {
    const conflict = structuredClone(data); conflict.sourceStatus.find(s => s.tool === "codex")!.conflictCount = 1; conflict.staleChains = 1;
    assert.equal(buildToolCollectionRows(conflict).find(r => r.id === "codex")!.label, "기록 충돌 확인");
    assert.match(renderToStaticMarkup(<CollectionRows data={conflict} />), /집계 갱신을 기다리고/);
  });
  check("invalid endpoint envelope is rejected instead of showing zero", () => { assert.equal(collectionOverviewSchema.safeParse({ error: "failure" }).success, false); });
  check("KST timestamps distinguish unavailable data", () => { assert.equal(formatCollectionTime("2026-10-01T00:00:00.000Z"), "2026-10-01 09:00 KST"); assert.equal(formatCollectionTime(null), "미확인"); assert.equal(formatCollectionTime("invalid"), "미확인"); });
  const unauthorized = await fetch(`${origin}/api/me/collection-status`); assert.equal(unauthorized.status, 401);
  console.log(`${passed} collection overview checks passed; actual HTTP response + server-rendered UI; anonymous 401`);
} finally {
  for (const name of ["usagerecords", "usagerecordchains", "usagerecordderived", "usagerecordconflicts", "usagerecorddevices", "usagerecorddevicesources"]) await db.collection(name).deleteMany({ memberId });
  await db.collection("members").deleteOne({ _id: memberId });
  await mongoose.disconnect();
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
