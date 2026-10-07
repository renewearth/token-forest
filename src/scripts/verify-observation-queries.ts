// Real query integration, synthetic local test database only. Never loads .env.
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { connectDb, closeDb, Member, UsageDaily, UsageHourly } from "@/lib/db";
import { getMemberUsageObservationSnapshot, getMemberDailyConverted, getDailyRequests, getUsageObservationSnapshot, getMemberBreakdown, getMemberDailyTrend, getMemberLeaderboard, getHourlyHeatmap, getPeriodTotals } from "@/lib/queries";
const uri = process.env.MONGODB_URI ?? "";
const parsed = new URL(uri);
if (parsed.hostname !== "127.0.0.1" ||
  !((parsed.port === "27391" && /^\/tf-v2-test-ax[-\w]*$/.test(parsed.pathname)) ||
    (["27397", "27398"].includes(parsed.port) && parsed.pathname === "/tf-v2-test"))) {
  throw new Error("Refusing non-synthetic local AX database");
}
const ids = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
const own = { _id: { $in: ids } };
const marker = `observation-${ids[0]}`;
const range = { from: "2090-01-01", to: "2090-01-03" };
const selection = { basis: "output" as const, unit: "raw" as const, ref: null };
let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
async function main() {
try {
  await connectDb();
  await Member.insertMany(ids.map((_id, i) => ({ _id, name: i < 2 ? "동명이인" : "숨김 신원 비노출", email: `${marker}-${i}@example.invalid`, hidden: i === 2 })));
  await UsageDaily.collection.insertMany([
    { date: range.from, outputTokens: 10, requests: 2, memberId: ids[0] },
    { date: range.to, outputTokens: 5, requests: null, memberId: ids[0] },
    { date: range.from, outputTokens: 9, requests: 1, memberId: ids[2] },
    { date: range.to, outputTokens: null, requests: 3, memberId: ids[0] },
  ].map((r, i) => ({ ...r, tool: "synthetic-ax", model: `${marker}-${i}`, externalId: marker, machineId: `machine-${i}`, source: "manual", inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, updatedAt: new Date() })));
  await UsageHourly.collection.insertOne({ hour: `${range.from}T09`, tool: "synthetic-ax", model: marker, externalId: marker, memberId: ids[0], outputTokens: 10, source: "manual" });
  const snapshot = await getUsageObservationSnapshot(range, selection);
  check("same query snapshot: period = daily tool = daily member sums", () => {
    assert.equal(snapshot.totals.observation?.value, 24);
    assert.equal(snapshot.people.observation.value, 24);
    assert.equal(snapshot.tools.observation?.value, 24);
    assert.equal(snapshot.people.data.reduce((sum, d) => sum + Number(d.__total ?? 0), 0), 24);
    assert.equal(snapshot.tools.data.reduce((sum, d) => sum + Number(d.__total ?? 0), 0), 24);
    assert.equal(snapshot.totals.observation?.complete, false);
  });
  check("gap null; visible member without records null; hidden member contributes anonymously", () => {
    assert.equal(snapshot.people.data[1].__total, null);
    assert.equal(snapshot.people.members.find((m) => m.key === `m${ids[1]}`)?.total, null);
    assert.equal(snapshot.people.members.find((m) => m.key === "other")?.total, 9);
    assert.ok(!JSON.stringify(snapshot.people).includes("숨김 신원 비노출"));
    assert.ok(!JSON.stringify(snapshot.people).includes(String(ids[2])));
  });
  const requests = await getUsageObservationSnapshot(range, { ...selection, basis: "requests" });
  check("requests missing row excluded, observed requests summed", () => { assert.equal(requests.totals.observation?.value, 6); assert.equal(requests.people.data[1].__total, null); });
  const requestTrend = await getDailyRequests(range);
  check("standalone request chart keeps null date gap", () => { assert.equal(requestTrend.length, 3); assert.equal(requestTrend[1].observedRequests, null); });
  const usd = await getUsageObservationSnapshot(range, { ...selection, unit: "usd" });
  check("all unpriced actual query: null total/lines and original 24 tokens", () => {
    assert.equal(usd.totals.observation?.value, null); assert.equal(usd.totals.unpricedTokens, 24);
    assert.ok(usd.people.data.every((d) => d.__total === null)); assert.ok(usd.tools.data.every((d) => d.__total === null));
  });
  const [breakdown, trend, members, heatmap, legacy] = await Promise.all([getMemberBreakdown(String(ids[0]), range, selection), getMemberDailyTrend(String(ids[0]), range, selection), getMemberLeaderboard(range, selection), getHourlyHeatmap(range, String(ids[0]), selection), getPeriodTotals(range)]);
  check("detail returns field null and missing daily cell null", () => { assert.equal(breakdown[0].fields?.inputTokens, null); assert.equal(trend.length, 3); assert.equal(trend[1].observedTokens, null); });
  check("record evidence survives selected metric null, no-record member retained", () => {
    assert.equal(members.find((m) => m.memberId === String(ids[0]))?.hasRecord, true);
    assert.equal(members.find((m) => m.memberId === String(ids[1]))?.hasRecord, false);
    assert.equal(members.find((m) => m.memberId === String(ids[1]))?.observation?.value, null);
    assert.ok(!members.some((m) => m.memberId === String(ids[2])));
  });
  check("hourly matrix gaps null and daily+hourly never double count", () => {
    assert.equal(heatmap.flat().filter((v) => v !== null).length, 1); assert.equal(heatmap.flat().reduce<number>((sum, v) => sum + (v ?? 0), 0), 10);
    assert.equal(legacy.totalTokens, 24);
  });
  // Store the proofs in Mongo itself: this catches projection losses that a
  // pure observeUsage fixture cannot detect. This range is separate from above.
  const evidenceRange = { from: "2091-02-01", to: "2091-02-02" };
  await UsageDaily.collection.insertMany([
    { date: evidenceRange.from, fieldEvidence: { outputTokens: "known", inputTokens: "unknown", requests: "unsupported" },
      completeEvidence: { source: "manual", account: marker, date: evidenceRange.from, fields: ["outputTokens"] }, dateBasis: "KST" },
    { date: evidenceRange.to },
  ].map((r, i) => ({ ...r, tool: "synthetic-ax-evidence", model: `${marker}-evidence-${i}`, externalId: marker,
    machineId: "evidence-machine", memberId: ids[0], source: "manual", outputTokens: 0, inputTokens: i ? null : 100,
    requests: i ? null : 5, updatedAt: new Date() })));
  await UsageHourly.collection.insertOne({ hour: `${evidenceRange.from}T09`, tool: "synthetic-ax-evidence", model: marker,
    externalId: marker, memberId: ids[0], source: "manual", outputTokens: 0, fieldEvidence: { outputTokens: "known" }, dateBasis: "KST" });
  const [proven, provenDetail, provenRequests, provenAll, provenHourly, converted] = await Promise.all([
    getUsageObservationSnapshot(evidenceRange, selection), getMemberBreakdown(String(ids[0]), evidenceRange, selection),
    getUsageObservationSnapshot(evidenceRange, { ...selection, basis: "requests" }),
    getUsageObservationSnapshot(evidenceRange, { ...selection, basis: "all" }),
    getHourlyHeatmap(evidenceRange, String(ids[0]), selection),
    getMemberDailyConverted(String(ids[0]), evidenceRange, selection),
  ]);
  check("Mongo-projected known zero stays zero; proof does not fill another date or member", () => {
    assert.equal(proven.totals.observation?.value, 0); assert.equal(proven.people.data[0][`m${ids[0]}`], 0);
    assert.equal(proven.people.data[1][`m${ids[0]}`], null); assert.equal(proven.people.data[0][`m${ids[1]}`], null);
    assert.equal(provenDetail[0].fields?.outputTokens, 0);
    // A proof for one source/account/day is not evidence of a complete team period.
    assert.equal(proven.totals.observation?.complete, false);
  });
  check("Mongo field overrides and explicit source date basis survive projection", () => {
    assert.equal(provenAll.totals.observation?.value, 100); // observed subtotal, completeness unknown
    assert.equal(provenRequests.totals.observation?.value, null); // requests 5 explicitly unsupported
    assert.equal(provenRequests.people.observations[evidenceRange.from][`m${ids[0]}`].status, "unsupported");
    assert.deepEqual(proven.people.observations[evidenceRange.from][`m${ids[0]}`].dateBases, ["KST"]);
    assert.ok(provenAll.totals.observation?.unknownFields.includes("inputTokens"));
  });
  check("hourly and member conversion query paths preserve zero evidence", () => {
    assert.deepEqual(provenHourly.flat().filter((v) => v !== null), [0]);
    assert.equal(converted.observationsByDate.get(evidenceRange.from)?.value, 0);
    assert.deepEqual(converted.observationsByDate.get(evidenceRange.from)?.dateBases, ["KST"]);
    assert.equal(converted.observationsByDate.get(evidenceRange.to)?.value, null);
    assert.equal(converted.sourceObservations.find((row) => row.date === evidenceRange.from)?.observation.status, "confirmed-zero");
    assert.equal(converted.sourceObservations.find((row) => row.date === evidenceRange.to)?.observation.status, "unknown");
  });
  const missingRequestsRange = { from: "2092-03-01", to: "2092-03-02" };
  await UsageDaily.collection.insertMany([
    { date: missingRequestsRange.from, outputTokens: 20, requests: null },
    { date: missingRequestsRange.to, outputTokens: 3, requests: 0 },
    { date: "2092-03-03", outputTokens: 2, requests: 0, fieldEvidence: { requests: "known" } },
  ].map((row, i) => ({ ...row, tool: "synthetic-ax-requests", model: `${marker}-requests-${i}`, externalId: marker,
    machineId: "requests-machine", memberId: ids[0], source: "manual", updatedAt: new Date() })));
  const [missingRequests, knownZeroRequests, memberMissingRequests] = await Promise.all([
    getUsageObservationSnapshot(missingRequestsRange, selection),
    getUsageObservationSnapshot({ from: "2092-03-03", to: "2092-03-03" }, selection),
    getMemberUsageObservationSnapshot(String(ids[0]), missingRequestsRange, selection),
  ]);
  check("home auxiliary request total stays null with valid tokens but all missing/default-zero requests", () => {
    assert.equal(missingRequests.totals.observation?.value, 23);
    assert.equal(missingRequests.totals.totalRequests, 0); // numeric legacy compatibility only
    assert.equal(missingRequests.totals.observedRequests, null);
    assert.equal(missingRequests.totals.observedRequests ?? "—", "—");
    assert.equal(snapshot.totals.observedRequests, 6); // independent of selected output basis
  });
  check("explicit observed request zero stays zero and member auxiliary requests remain nullable", () => {
    assert.equal(knownZeroRequests.totals.observedRequests, 0);
    assert.equal(knownZeroRequests.totals.observedRequests ?? "—", 0);
    assert.ok(memberMissingRequests.breakdown.every((row) => row.fields?.requests === null));
    assert.ok(memberMissingRequests.trend.every((row) => row.observedRequests === null));
    assert.equal(memberMissingRequests.observation.value, 23);
  });
  const legacyCopilotDay = "2093-04-01";
  await UsageDaily.collection.insertOne({
    date: legacyCopilotDay, tool: "copilot", model: marker, externalId: marker,
    machineId: "legacy-copilot", source: "poller", requests: 1.5,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
    updatedAt: new Date(),
  });
  const legacyRange = { from: legacyCopilotDay, to: legacyCopilotDay };
  const [legacyTotals, legacyRequestTrend, legacyObserved] = await Promise.all([
    getPeriodTotals(legacyRange),
    getDailyRequests(legacyRange),
    getUsageObservationSnapshot(legacyRange, { ...selection, basis: "requests" }),
  ]);
  check("historical Copilot billing quantity is excluded from request aggregates", () => {
    assert.equal(legacyTotals.totalRequests, 0);
    assert.equal(legacyRequestTrend[0].observedRequests, null);
    assert.equal(legacyObserved.totals.observedRequests, null);
  });
  console.log(`Observation query verification: ${checks} PASS, 0 FAIL`);
} finally {
  await Promise.all([UsageDaily.deleteMany({ externalId: marker }), UsageHourly.deleteMany({ externalId: marker }), Member.deleteMany(own)]);
  await closeDb();
}

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
