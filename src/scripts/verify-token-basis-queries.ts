// Real query integration test. No .env import, no production fallback.
// MONGODB_URI=mongodb://127.0.0.1:27391/tf-v2-test-ax-basis \
//   ./node_modules/.bin/tsx src/scripts/verify-token-basis-queries.ts [--keep-fixture]
// Cleanup is restricted to the synthetic identities/prices below. Seed prices
// inserted by loadPriceTable are retained. --keep-fixture supports UI previews.
import mongoose from "mongoose";
import {
  closeDb, connectDb, Device, Member, MemberIdentity, ModelPrice,
  UsageDaily, UsageDailyLegacy, UsageHourly, UsageSession,
} from "@/lib/db";
import { addDays, isoDaysAgo, kstDate } from "@/lib/date";
import { deriveUploaderRows } from "@/lib/sessions";
import {
  getDailyConvertedByMember, getDailyConvertedByTool, getGrowthDays, getHourlyHeatmap,
  getMemberBreakdown, getMemberDailyConverted, getMemberDailyTrend, getMemberLeaderboard, getMemberList,
  getMemberWowDeltas, getModelDistribution, getModelTierTrend,
  getMyMachines, getPeriodTotals, getScorecardWeeklySums, getToolSummary,
} from "@/lib/queries";
import { getTeamMaturity } from "@/lib/team-maturity";
import type { TokenBasis, Unit, UsageSelection } from "@/lib/units";

const DB_NAME = "tf-v2-test-ax-basis";
const EMAILS = ["one@token-basis.test", "two@token-basis.test"];
const OWN = { externalId: { $in: EMAILS } };
const PRICE_OWNER = "fixture@token-basis.test";
const MODEL = "token-basis-priced";
const REF = "token-basis-reference";
const CACHE_ONLY = "token-basis-unknown-cache";
const UNKNOWN = "token-basis-unknown-mixed";
const MACHINES = ["basis-device-one", "basis-device-two"];
const NOW = new Date();
const TODAY = kstDate(NOW.getTime());
const YESTERDAY = addDays(TODAY, -1);
const RANGE = { from: addDays(TODAY, -14), to: TODAY };
const KEEP = process.argv.includes("--keep-fixture");
let connected = false;
let seeded = false;
let pass = 0;
let fail = 0;

function check(label: string, condition: boolean) {
  if (condition) pass++;
  else { fail++; console.error(`FAIL: ${label}`); }
}
function near(label: string, actual: number, expected: number) {
  check(`${label} (got ${actual}, expected ${expected})`, Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)));
}
const sum = (rows: { tokens: number }[]) => rows.reduce((n, r) => n + r.tokens, 0);

async function fixedSnapshot(id: string) {
  const [growth, scoreWeekly, tools, maturity] = await Promise.all([
    getGrowthDays(id, RANGE.from), getScorecardWeeklySums(RANGE),
    getToolSummary(RANGE), getTeamMaturity(RANGE),
  ]);
  // Mongo $group and $addToSet do not promise order. Preserve every field and
  // value, but sort unordered collections by their semantic identity first.
  return {
    growth: growth.map((r) => ({ ...r, tools: [...r.tools].sort() })).sort((a, b) => a.date.localeCompare(b.date)),
    scoreWeekly: scoreWeekly.map((r) => ({ ...r, models: [...r.models].sort() }))
      .sort((a, b) => `${a.week}|${a.memberId}|${a.tool}`.localeCompare(`${b.week}|${b.memberId}|${b.tool}`)),
    tools: [...tools].sort((a, b) => a.tool.localeCompare(b.tool)),
    maturity,
  };
}

async function cleanup() {
  await Promise.all([
    Device.deleteMany(OWN), UsageSession.deleteMany(OWN), UsageDaily.deleteMany(OWN),
    UsageDailyLegacy.deleteMany(OWN), UsageHourly.deleteMany(OWN), MemberIdentity.deleteMany(OWN),
    Member.deleteMany({ email: { $in: EMAILS } }), ModelPrice.deleteMany({ registeredBy: PRICE_OWNER }),
  ]);
}

type Fact = {
  member: number; date: string; tool: string; model: string;
  input: number; output: number; read: number; write: number;
};
const facts: Fact[] = [
  { member: 0, date: TODAY, tool: "claude_code", model: MODEL, input: 100, output: 50, read: 1000, write: 200 },
  { member: 0, date: YESTERDAY, tool: "claude_code", model: MODEL, input: 100, output: 50, read: 1000, write: 200 },
  { member: 0, date: YESTERDAY, tool: "basis-tool", model: CACHE_ONLY, input: 0, output: 0, read: 11, write: 0 },
  { member: 0, date: TODAY, tool: "basis-tool", model: UNKNOWN, input: 7, output: 3, read: 5, write: 2 },
  { member: 1, date: YESTERDAY, tool: "claude_code", model: MODEL, input: 2000, output: 10, read: 0, write: 0 },
];

// Independent arithmetic oracle: no units.ts conversion/selection helpers.
function expected(f: Fact, sel: UsageSelection): { value: number; unpriced: number } {
  const selected = sel.basis === "all" ? [f.input, f.output, f.read, f.write]
    : sel.basis === "no-cache-read" ? [f.input, f.output, 0, f.write]
    : sel.basis === "output" ? [0, f.output, 0, 0] : [f.input, f.output, 0, 0];
  const total = selected.reduce((a, b) => a + b, 0);
  if (sel.unit === "raw") return { value: total, unpriced: 0 };
  if (f.model !== MODEL) return { value: 0, unpriced: total };
  const rates = f.date === TODAY ? [4, 16, 2, 8] : [2, 8, 1, 4];
  const reference = [1, 2, 0.5, 1];
  return {
    value: selected.reduce((n, tokens, i) => n + tokens * rates[i] / (sel.unit === "usd" ? 1e6 : reference[i]), 0),
    unpriced: 0,
  };
}

async function main() {
  // Exact host/port/database allowlist, with no credentials, replica discovery,
  // URI options or SRV records. Validate before any connection or mutation.
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\]):(27391|27397|27398)\/tf-v2-test-ax-basis$/.test(process.env.MONGODB_URI ?? "")) {
    throw new Error("Refusing: use isolated loopback port 27391/27397 and database tf-v2-test-ax-basis only");
  }
  await connectDb();
  connected = true;
  if (mongoose.connection.name !== DB_NAME || ![27391, 27397, 27398].includes(mongoose.connection.port)) {
    throw new Error("Refusing: actual database or port does not match the isolated fixture database");
  }
  // Totals are unfiltered application queries: refuse mixed datasets instead
  // of deleting somebody else's records or silently weakening assertions.
  const foreign = await Promise.all([
    Member.countDocuments({ email: { $nin: EMAILS } }),
    UsageDaily.countDocuments({ externalId: { $nin: EMAILS } }),
    UsageHourly.countDocuments({ externalId: { $nin: EMAILS } }),
    UsageSession.countDocuments({ externalId: { $nin: EMAILS } }),
  ]);
  if (foreign.some(Boolean)) throw new Error("Refusing: isolated fixture database contains unrelated member/usage records");
  await cleanup();
  seeded = true;
  const members = await Member.create(EMAILS.map((email, i) => ({
    email, name: `기준 검증 ${i + 1}`, onboardedAt: NOW, toolPrefs: ["claude_code"],
  })));
  await MemberIdentity.create(members.flatMap((m) => ["claude_code", "basis-tool"].map((tool) => ({
    memberId: m._id, externalId: m.email, tool,
  }))));
  await ModelPrice.create([
    { family: MODEL, effectiveFrom: RANGE.from, input: 2, output: 8, cacheRead: 1, cacheWrite: 4 },
    { family: MODEL, effectiveFrom: TODAY, input: 4, output: 16, cacheRead: 2, cacheWrite: 8 },
    { family: REF, effectiveFrom: RANGE.from, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
  ].map((r) => ({ ...r, match: [`=${r.family}`], provider: "", priority: -100,
    sourceUrl: "https://example.test/synthetic-prices", checkedAt: TODAY,
    registeredBy: PRICE_OWNER, note: "Synthetic test prices; never for real usage" })));
  await Device.create(MACHINES.map((machineId) => ({
    machineId, externalId: EMAILS[0], uploaderVersion: "2.0.0", lastSeenAt: NOW,
  })));
  await UsageSession.create(facts.map((f, i) => ({
    externalId: EMAILS[f.member], memberId: members[f.member]._id,
    tool: f.tool, model: f.model, sessionId: `token-basis-session-${i}`,
    date: f.date, hour: `${f.date}T10`, provider: "", parserVersion: 1,
    inputTokens: f.input, outputTokens: f.output, cacheReadTokens: f.read,
    cacheCreationTokens: f.write, requests: 1,
    machineIds: f.member === 0 ? MACHINES : ["basis-member-two-device"],
  })));
  for (let i = 0; i < members.length; i++) {
    await deriveUploaderRows(EMAILS[i], facts.filter((f) => f.member === i).map(({ tool, date }) => ({ tool, date })));
  }
  await UsageDaily.collection.insertOne({
    externalId: EMAILS[1], memberId: members[1]._id, date: TODAY, tool: "basis-tool",
    model: "token-basis-missing", machineId: "", source: "manual", inputTokens: null,
  });
  const ids = members.map((m) => String(m._id));
  const fixedBefore = await fixedSnapshot(ids[0]);
  near("legacy omitted period total stays input+output", (await getPeriodTotals(RANGE)).totalTokens, 2320);
  // Growth days now cover every tool (4 session facts for member 0, 1 request
  // each, on 2 dates) and carry ladder tokens instead of raw agentic sums.
  near("growth request fact (all tools)", fixedBefore.growth.reduce((n, r) => n + (r.requests ?? 0), 0), 4);
  near("growth active days", fixedBefore.growth.length, 2);

  const bases: TokenBasis[] = ["all", "no-cache-read", "output", "legacy"];
  const units: Unit[] = ["raw", "usd", "ref"];
  for (const basis of bases) for (const unit of units) {
    const sel: UsageSelection = { basis, unit, ref: REF };
    const tag = `${basis}/${unit}`;
    const oracle = facts.map((f) => expected(f, sel));
    const total = oracle.reduce((n, r) => n + r.value, 0);
    const unpriced = oracle.reduce((n, r) => n + r.unpriced, 0);
    const [period, daily, tools, models, leaders, heatmap, tiers, machines, wow, memberList] = await Promise.all([
      getPeriodTotals(RANGE, sel), getDailyConvertedByTool(RANGE, sel), getToolSummary(RANGE, sel),
      getModelDistribution(RANGE, undefined, sel), getMemberLeaderboard(RANGE, sel),
      getHourlyHeatmap(RANGE, undefined, sel), getModelTierTrend(RANGE, sel),
      getMyMachines(EMAILS[0], NOW, sel), getMemberWowDeltas(sel),
      getMemberList(sel, RANGE),
    ]);
    near(`${tag} period`, period.totalTokens, total);
    near(`${tag} unpriced`, period.unpricedTokens ?? 0, unpriced);
    near(`${tag} daily`, daily.data.reduce((n, row) => n + daily.tools.reduce((s, tool) => s + Number(row[tool] ?? 0), 0), 0), total);
    near(`${tag} daily unpriced`, daily.unpricedTokens, unpriced);
    near(`${tag} tools`, sum(tools), total);
    near(`${tag} models`, sum(models), total);
    near(`${tag} leaders`, sum(leaders), total);
    near(`${tag} member list`, sum(memberList), total);
    near(`${tag} heatmap`, heatmap.flat().reduce<number>((n, v) => n + (v ?? 0), 0), total);
    check(`${tag} tier rows exist`, tiers.weeks.length > 0);
    for (const week of tiers.weeks) {
      const inWeek = facts.filter((f) => f.date >= week.week && f.date < addDays(week.week, 7));
      const weekTotal = inWeek.reduce((n, f) => n + expected(f, sel).value, 0);
      const priced = inWeek.filter((f) => f.model === MODEL).reduce((n, f) => n + expected(f, sel).value, 0);
      near(`${tag} ${week.week} priced tier share`, Number(week[MODEL] ?? 0), weekTotal ? priced / weekTotal * 100 : 0);
      near(`${tag} ${week.week} unknown tier share`, Number(week["단가 미정"] ?? 0), weekTotal ? (weekTotal - priced) / weekTotal * 100 : 0);
    }
    near(`${tag} requests unchanged`, period.totalRequests, facts.length);
    near(`${tag} original input unchanged`, period.totalInput, 2207);
    check(`${tag} stable member ID order`, leaders.every((r, i) => i === 0 || leaders[i - 1].memberId.localeCompare(r.memberId) <= 0));
    const expectedMembers = ids.map((id, member) => ({ id, value: facts.reduce((n, f) => n + (f.member === member ? expected(f, sel).value : 0), 0) }));
    const order = [...expectedMembers].sort((a, b) => a.id.localeCompare(b.id));
    check(`${tag} order independent of selected value`, leaders.map((r) => r.memberId).join() === order.map((r) => r.id).join());
    check(`${tag} list order independent of selected value`, memberList.map((r) => r.id).join() === order.map((r) => r.id).join());
    const comparison = await getDailyConvertedByMember(RANGE, sel);
    near(`${tag} overall line sums to period`, comparison.data.reduce((n, day) => n + Number(day.__total), 0), total);
    near(`${tag} comparison total`, comparison.members.reduce((n, m) => n + (m.total ?? 0), 0), expectedMembers.reduce((n, m) => n + m.value, 0));
    for (let i = 0; i < members.length; i++) {
      const member = comparison.members.find((m) => m.key === `m${ids[i]}`);
      near(`${tag} comparison person ${i}`, member?.total ?? -1, expectedMembers[i].value);
      near(`${tag} comparison daily ${i}`, comparison.data.reduce((n, day) => n + Number(day[`m${ids[i]}`] ?? 0), 0), expectedMembers[i].value);
      near(`${tag} comparison warning ${i}`, member?.unpricedTokens ?? -1, facts.filter((f) => f.member === i).reduce((n, f) => n + expected(f, sel).unpriced, 0));
    }
    check(`${tag} comparison fills missing days`, comparison.data.length === 15 && Number(comparison.data[0][`m${ids[0]}`]) === 0);
    for (let i = 0; i < members.length; i++) {
      const [rows, trend, panelTrend] = await Promise.all([
        getMemberBreakdown(ids[i], RANGE, sel), getMemberDailyConverted(ids[i], RANGE, sel),
        getMemberDailyTrend(ids[i], RANGE, sel),
      ]);
      near(`${tag} member ${i} breakdown`, sum(rows), expectedMembers[i].value);
      near(`${tag} member ${i} daily`, [...trend.byDate.values()].reduce((n, v) => n + v, 0), expectedMembers[i].value);
      near(`${tag} member ${i} panel trend`, sum(panelTrend), expectedMembers[i].value);
      near(`${tag} member ${i} list row`, memberList.find((r) => r.id === ids[i])?.tokens ?? -1, expectedMembers[i].value);
      const currentFacts = facts.filter((f) => f.member === i && f.date >= isoDaysAgo(7) && f.date < isoDaysAgo(0));
      near(`${tag} member ${i} week`, wow.find((r) => r.memberId === ids[i])?.tokens ?? 0, currentFacts.reduce((n, f) => n + expected(f, sel).value, 0));
      if (i === 0) {
        const cache = rows.find((r) => r.model === CACHE_ONLY);
        near(`${tag} cache-only value`, cache?.tokens ?? 0, expected(facts[2], sel).value);
        near(`${tag} cache-only warning`, cache?.unpricedTokens ?? 0, expected(facts[2], sel).unpriced);
        near(`${tag} original breakdown cache`, rows.reduce((n, r) => n + (r.cacheRead ?? 0), 0), 2016);
      } else {
        const missing = rows.find((r) => r.model === "token-basis-missing");
        check(`${tag} missing/null fields retained as zero`, !!missing && missing.tokens === 0 && missing.input === 0 && missing.output === 0);
        near(`${tag} missing fields no price warning`, missing?.unpricedTokens ?? 0, 0);
      }
    }
    check(`${tag} shared devices listed once`, machines.length === 2);
    for (const machine of machines) {
      near(`${tag} shared session ${machine.machineId}`, machine.recentTokens, expectedMembers[0].value);
      near(`${tag} device unknown warning`, machine.unpricedTokens ?? 0, unpriced);
    }
    const fixedAfter = await fixedSnapshot(ids[0]);
    for (const part of ["growth", "scoreWeekly", "tools", "maturity"] as const) {
      check(`${tag} fixed ${part} values unchanged`, JSON.stringify(fixedAfter[part]) === JSON.stringify(fixedBefore[part]));
    }
  }
  // Explicit raw basis example, independent of cross-view agreement.
  for (const [basis, value] of [["all", 1350], ["no-cache-read", 350], ["output", 50], ["legacy", 150]] as const) {
    const row = (await getMemberBreakdown(ids[0], { from: TODAY, to: TODAY }, { basis, unit: "raw", ref: REF })).find((r) => r.model === MODEL);
    near(`${basis} 100/1000/200/50 example`, row?.tokens ?? -1, value);
  }

  // Fixed-window cards need their own warnings. A 10-day-old unknown model
  // belongs to the previous-week/30-day seat views, outside a selected 7 days.
  const sevenDays = { from: addDays(TODAY, -6), to: TODAY };
  const thirtyDays = { from: addDays(TODAY, -29), to: TODAY };
  const outputUsd: UsageSelection = { basis: "output", unit: "usd", ref: REF };
  const beforeOld = await getToolSummary(sevenDays, outputUsd);
  const currentUnpriced = beforeOld.reduce((n, r) => n + (r.unpricedTokens ?? 0), 0);
  await UsageDaily.create([
    {
      externalId: EMAILS[0], memberId: members[0]._id, date: isoDaysAgo(10),
      tool: "basis-tool", model: "token-basis-old-unknown", machineId: "",
      source: "manual", inputTokens: 0, outputTokens: 99, cacheReadTokens: 0,
      cacheCreationTokens: 0, requests: 1,
    },
    {
      externalId: EMAILS[0], memberId: members[0]._id, date: YESTERDAY,
      tool: "basis-cache-only", model: CACHE_ONLY, machineId: "",
      source: "manual", inputTokens: 0, outputTokens: 0, cacheReadTokens: 777,
      cacheCreationTokens: 0, requests: 1,
    },
  ]);
  const [previousWeek, seats, currentTools, cacheAll, cacheOutput] = await Promise.all([
    getMemberWowDeltas(outputUsd), getMemberLeaderboard(thirtyDays, outputUsd),
    getToolSummary(sevenDays, outputUsd),
    getToolSummary(sevenDays, { basis: "all", unit: "raw", ref: REF }),
    getToolSummary(sevenDays, { basis: "output", unit: "raw", ref: REF }),
  ]);
  near("previous-week unknown output warning survives 7-day page selection", previousWeek.find((r) => r.memberId === ids[0])?.prevUnpricedTokens ?? 0, 99);
  near("30-day seat warning includes old unknown output", seats.find((r) => r.memberId === ids[0])?.unpricedTokens ?? 0, currentUnpriced + 99);
  near("7-day tool warning excludes old unknown output", currentTools.reduce((n, r) => n + (r.unpricedTokens ?? 0), 0), currentUnpriced);
  const allCache = cacheAll.find((r) => r.tool === "basis-cache-only");
  const outputCache = cacheOutput.find((r) => r.tool === "basis-cache-only");
  near("cache-only tool all/raw collected tokens", allCache?.collectedTokens ?? -1, 777);
  near("cache-only tool all/raw displayed tokens", allCache?.tokens ?? -1, 777);
  near("cache-only tool output/raw collected tokens retained", outputCache?.collectedTokens ?? -1, 777);
  near("cache-only tool output/raw selected tokens zero", outputCache?.tokens ?? -1, 0);
  // Requests-only tool must be included even without token or price information.
  await UsageDaily.create({ externalId: EMAILS[1], memberId: members[1]._id, date: TODAY,
    tool: "copilot", model: "requests-only", machineId: "", source: "manual", requests: 7 });
  const requestSel: UsageSelection = { basis: "requests", unit: "raw", ref: REF };
  const [requestPeriod, requestPeople, requestTools, requestMember, requestBreakdown, requestList] = await Promise.all([
    getPeriodTotals(sevenDays, requestSel), getDailyConvertedByMember(sevenDays, requestSel),
    getDailyConvertedByTool(sevenDays, requestSel), getMemberDailyConverted(ids[1], sevenDays, requestSel),
    getMemberBreakdown(ids[1], sevenDays, requestSel), getMemberList(requestSel, sevenDays),
  ]);
  near("request total includes request-only tool", requestPeriod.totalTokens, 13);
  near("request period agrees with stored requests", requestPeriod.totalTokens, requestPeriod.totalRequests);
  near("requests never unpriced", requestPeriod.unpricedTokens ?? -1, 0);
  near("request person one", requestPeople.members.find(m => m.key === `m${ids[0]}`)?.total ?? -1, 5);
  near("request person two", requestPeople.members.find(m => m.key === `m${ids[1]}`)?.total ?? -1, 8);
  near("request total line today", Number(requestPeople.data.find(d => d.date === TODAY)?.__total), 9);
  near("request total line yesterday", Number(requestPeople.data.find(d => d.date === YESTERDAY)?.__total), 4);
  near("requests tool graph", requestTools.data.reduce((n,d) => n + requestTools.tools.reduce((sum,t) => sum + Number(d[t]), 0), 0), 13);
  near("request member graph", [...requestMember.byDate.values()].reduce((n,v) => n+v, 0), 8);
  near("request member detail", sum(requestBreakdown), 8);
  near("request member list", requestList.find(m => m.id === ids[1])?.tokens ?? -1, 8);

}

main().catch((error: unknown) => {
  fail++;
  // Do not dump database documents, connection strings, or authentication data.
  console.error(error instanceof Error && error.message.startsWith("Refusing:") ? error.message : "Integration verification aborted; inspect the isolated fixture database and test assertions.");
}).finally(async () => {
  if (seeded && !(KEEP && fail === 0)) await cleanup();
  if (connected) await closeDb();
  console.log(`PASS=${pass} FAIL=${fail}`);
  if (KEEP && fail === 0) console.log("Synthetic fixture retained in tf-v2-test-ax-basis; no authentication token was created.");
  process.exitCode = fail ? 1 : 0;
});
