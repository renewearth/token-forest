import assert from "node:assert/strict";
import { Types } from "mongoose";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb, connectDb, Member, UsageDaily, UsageHourly } from "@/lib/db";
import { getActivityCalendar } from "@/lib/activity-calendar-query";
import { ActivityCalendar, ActivityCalendarProvider } from "@/app/_components/ActivityCalendar";
import { upsertHourlyRows } from "@/lib/usage";
import { MemberIdentity } from "@/lib/db";
import { UsageRecord } from "@/lib/db/usage-record";
import { ledgerDigest } from "@/lib/collection-cutover";
import { normalizeRecordSemantics, recordDigest, type UsageRecord as RecordSemantics } from "../../packages/protocol/records.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  if (process.env.MONGODB_URI !== "mongodb://127.0.0.1:27398/tf-v2-test-activity-calendar") throw Error("Disposable activity calendar DB required");
  await connectDb();
  const id = new Types.ObjectId(), hidden = new Types.ObjectId(), cutover = new Types.ObjectId();
  const ids = [id, hidden, cutover]; let passes = 0;
  const temp = mkdtempSync(join(tmpdir(), "tf-activity-cutover-"));
  const check = (label: string, run: () => void) => { run(); passes++; console.log(`PASS ${label}`); };
  try {
    await Member.collection.insertMany([{ _id: id, name: "Fixture", email: "fixture@example.test" }, { _id: hidden, name: "Hidden", hidden: true, email: "hidden@example.test" }]);
    const base = { memberId: id, tool: "codex", source: "uploader", dateBasis: "KST", externalId: "never-serialize-external-id", machineId: "", model: "" };
    await UsageDaily.collection.insertMany([
      { ...base, date: "2026-10-07", inputTokens: 2 },
      { ...base, date: "2026-10-07", model: "other-model", requests: 1 },
      { ...base, date: "2026-10-08", requests: 1.5 },
      { ...base, date: "2026-10-08", requests: Infinity },
      { ...base, date: "2026-10-08", inputTokens: 0 },
      { ...base, date: "2026-10-08", inputTokens: -1 },
      { ...base, date: "2026-10-08", inputTokens: 5, fieldEvidence: { inputTokens: "unsupported" } },
      { ...base, date: "2026-10-09", requests: 2, fieldEvidence: { requests: "unknown" } },
      { ...base, date: "2026-10-09", memberId: null, tool: "unlinked-private", inputTokens: 1 },
      { ...base, date: "2026-10-09", memberId: hidden, tool: "hidden-private", inputTokens: 1 },
      { ...base, date: "2026-10-08", tool: "copilot", source: "poller", requests: 50 },
      { ...base, date: "2026-10-08", tool: "cursor", source: "poller", model: "m", requests: 50 },
    ].map((doc, i) => ({ ...doc, machineId: `fixture-${i}` })));
    const before = await getActivityCalendar("2026-10-09");
    check("MongoDB invalid/default/unsupported/billing rows do not create activity", () => {
      assert.equal(before.people.length, 1); assert.deepEqual(before.people[0].days.map(d => d.date), ["2026-10-07", "2026-10-09"]); assert.equal(before.people[0].best.length, 1);
    });
    await UsageHourly.collection.insertMany([
      { ...base, date: undefined, hour: "2026-10-07T16", tool: "cursor", source: "poller", dateBasis: undefined, inputTokens: 10 },
      { ...base, date: undefined, hour: "2026-10-08T22", inputTokens: 20 },
      { ...base, date: undefined, hour: "2026-10-08T22", model: "duplicate", inputTokens: 20 },
    ]);
    const after = await getActivityCalendar("2026-10-09"); const p = after.people[0];
    check("real hourly UTC-to-KST conversion fills the original gap without duplication", () => { assert.equal(p.best.length, 3); assert.equal(p.current, 3); assert.equal(p.days.length, 3); assert.deepEqual(p.days[1].achievements, []); assert.deepEqual(p.days[2].achievements, [3]); });
    await MemberIdentity.collection.insertOne({ memberId: id, tool: "cursor", externalId: "cursor-fixture" });
    await upsertHourlyRows([
      { hour: "2026-10-08T16", tool: "cursor", model: "cursor-poller", externalId: "cursor-fixture", inputTokens: 3, source: "poller", dateBasis: "UTC" },
      { hour: "2026-10-08T16", tool: "cursor", model: "unknown-basis", externalId: "cursor-fixture", inputTokens: 4, source: "poller", dateBasis: "미확인" },
    ]);
    const stored = await UsageHourly.findOne({ externalId: "cursor-fixture", model: "cursor-poller" }).lean();
    const throughActualUpsert = await getActivityCalendar("2026-10-09");
    check("actual upsert preserves explicit UTC and never upgrades unknown provenance", () => {
      assert.equal(stored?.dateBasis, "UTC");
      assert(throughActualUpsert.people[0].days.find(d => d.date === "2026-10-09")?.sources.some(s => s.tool === "cursor" && s.confirmed && s.dateBasis === "UTC"));
      assert(throughActualUpsert.people[0].days.find(d => d.date === "2026-10-08")?.sources.some(s => s.tool === "cursor" && !s.confirmed && s.dateBasis === "미확인"));
    });
    check("public calendar payload has no external identities, models, billing, hidden or private events", () => {
      const json = JSON.stringify(after); for (const text of ["never-serialize", "other-model", "hidden-private", "unlinked-private", "ingestToken", "email", "gp"]) assert(!json.includes(text));
    });
    const html = renderToStaticMarkup(<ActivityCalendarProvider initialId={String(id)}><ActivityCalendar data={after} /></ActivityCalendarProvider>);
    check("actual rendered calendar has source scope, month/person controls, dates and no large longest card", () => {
      assert.match(html, /AI 활동 달력/); assert.match(html, /달력 구성원/); assert.match(html, /이전 달/); assert.match(html, /data-activity-date="2026-10-09"/); assert.doesNotMatch(html, /최장 연속 활동.*카드/);
    });
    const error = renderToStaticMarkup(<ActivityCalendarProvider initialId=""><ActivityCalendar data={{ today: "2026-10-09", people: [], available: false }} /></ActivityCalendarProvider>);
    check("calendar failure is a visible independent error state", () => assert.match(error, /role="alert"/));
    await Member.collection.insertOne({ _id: cutover, name: "Cutover", email: "cutover@example.test" });
    await UsageDaily.collection.insertMany(["2026-10-07", "2026-10-09"].map(date => ({ ...base, memberId: cutover, externalId: "cutover-fixture", date, inputTokens: 2 })));
    await UsageHourly.collection.insertOne({ ...base, memberId: cutover, externalId: "cutover-fixture", hour: "2026-10-07T16", dateBasis: "UTC", inputTokens: 5 });
    const beforeCutover = (await getActivityCalendar("2026-10-09")).people.find(p => p.id === String(cutover))!;
    assert.equal(beforeCutover.best.length, 3);
    const semantics = normalizeRecordSemantics({ tool: "codex", accountId: "cutover-fixture", recordId: "zero-event", sessionId: "zero-session", kind: "event", occurredAt: "2026-10-08T03:00:00.000Z", model: "fixture", provider: null, revision: 1, parserVersion: 1, completeness: "final", identityQuality: "native", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0, fieldEvidence: { inputTokens: "known", outputTokens: "known", cacheReadTokens: "known", cacheCreationTokens: "known", requests: "known" } } as RecordSemantics);
    const digest = recordDigest(semantics);
    await UsageRecord.collection.insertOne({ memberId: cutover, tool: "codex", date: "2026-10-08", semantics, digest });
    const scope = { memberId: String(cutover), tool: "codex", date: "2026-10-08", accountIds: ["cutover-fixture"], deviceIds: ["fixture"], expectedCount: 1, ledgerDigest: ledgerDigest([{ semantics, digest }]), inventoryDigest: "a".repeat(64), registeredScopeReviewed: true, reviewedAt: "2026-10-09T00:00:00.000Z" };
    const manifest = join(temp, "cutover.json"); writeFileSync(manifest, JSON.stringify({ version: 1, scopes: [scope] }));
    process.env.TOKEN_FOREST_RECORD_CUTOVER_FILE = manifest;
    const afterCutover = (await getActivityCalendar("2026-10-09")).people.find(p => p.id === String(cutover))!;
    check("reviewed KST zero replaces UTC prior-day legacy hours before streak computation", () => { assert.equal(afterCutover.best.length, 1); assert.equal(afterCutover.current, 1); assert(!afterCutover.days.some(d => d.date === "2026-10-08" && d.active)); });
    console.log(`${passes} activity calendar database/render checks passed`);
  } finally {
    await UsageDaily.collection.deleteMany({ memberId: { $in: [...ids, null] } });
    await UsageHourly.collection.deleteMany({ memberId: { $in: ids } });
    await Member.collection.deleteMany({ _id: { $in: ids } });
    await MemberIdentity.collection.deleteMany({ memberId: { $in: ids } });
    await UsageRecord.collection.deleteMany({ memberId: { $in: ids } });
    delete process.env.TOKEN_FOREST_RECORD_CUTOVER_FILE; rmSync(temp, { recursive: true, force: true });
    await closeDb();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
