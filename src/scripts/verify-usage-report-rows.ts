// Claude spend-report rows in the dashboard's display queries.
// Pure checks always run. With an isolated database they also run end to end:
// MONGODB_URI=mongodb://127.0.0.1:27391/tf-v2-test-report-rows \
//   ./node_modules/.bin/tsx src/scripts/verify-usage-report-rows.ts
// No .env import, no production fallback. Cleanup is restricted to the
// synthetic identities/prices below.
import mongoose from "mongoose";
import { closeDb, connectDb, Member, MemberIdentity, ModelPrice, UsageDaily, UsageHourly, UsageSession } from "@/lib/db";
import { UsageReport } from "@/lib/db/usage-report";
import { addDays, kstDate } from "@/lib/date";
import {
  getMemberDailyConverted, getPeriodTotals, getUnmappedExternalIds, getUsageObservationSnapshot,
} from "@/lib/queries";
import type { UsageFact } from "@/lib/usage-display";
import { mergeReportFacts, reportFacts, supportsReportMatch } from "@/lib/usage-report-rows";
import type { UsageSelection } from "@/lib/units";

const DB_NAME = "tf-v2-test-report-rows";
const DOMAIN = "report-rows.test";
const EMAILS = [`one@${DOMAIN}`, `two@${DOMAIN}`];
const OLD = `old@${DOMAIN}`;
const GHOST = `ghost@${DOMAIN}`;
const OWN = { externalId: { $in: [...EMAILS, OLD, GHOST] } };
const ACCOUNT = "report-rows-account";
const PRICE_OWNER = `fixture@${DOMAIN}`;
const MODEL = "report-rows-priced";
const REF = "report-rows-reference";
const TODAY = kstDate(Date.now());
const D1 = addDays(TODAY, -3);
const D2 = addDays(TODAY, -2);
const RANGE = { from: addDays(TODAY, -7), to: TODAY };
let pass = 0;
let fail = 0;
let seeded = false;

function check(label: string, condition: boolean) {
  if (condition) pass++;
  else { fail++; console.error(`FAIL: ${label}`); }
}
function near(label: string, actual: number | null | undefined, expected: number) {
  check(`${label} (got ${actual}, expected ${expected})`, typeof actual === "number" && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)));
}

const fact = (over: Partial<UsageFact>): UsageFact => ({
  date: D1, tool: "claude_code", model: MODEL, memberId: "m1", externalId: EMAILS[0], machineId: "", hour: "", source: "uploader", ...over,
});
const snapshot = (date: string, collectedAt: string, rows: Array<{ product: string; externalId: string; metrics: Record<string, number> }>, end = date) => ({
  accountId: ACCOUNT, periodStart: date, periodEnd: end, collectedAt: new Date(collectedAt),
  rows: rows.map((row) => ({ ...row, model: MODEL })),
});

function pure() {
  const index = new Map([[EMAILS[0], "m1"], [OLD, "m2"]]);
  const facts = reportFacts([
    snapshot(D1, "2026-01-01T00:00:00Z", [{ product: "Chat", externalId: EMAILS[0], metrics: { prompt_tokens: 999, completion_tokens: 999 } }]),
    snapshot(D1, "2026-01-02T00:00:00Z", [
      { product: "Chat", externalId: EMAILS[0].toUpperCase(), metrics: { prompt_tokens: 30, completion_tokens: 20 } },
      { product: "Claude in Chrome", externalId: OLD, metrics: { uncached_input_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 } },
      { product: "Cowork", externalId: GHOST, metrics: { uncached_input_tokens: 7, completion_tokens: 3 } },
      { product: "Chat", externalId: GHOST, metrics: { prompt_tokens: 0, completion_tokens: 0 } },
    ]),
    snapshot(D1, "2026-01-03T00:00:00Z", [{ product: "Chat", externalId: EMAILS[0], metrics: { prompt_tokens: 5000 } }], D2),
  ], index);
  check("latest single-day snapshot wins; period snapshots and all-zero rows are skipped", facts.length === 3);
  const chat = facts.find((f) => f.tool === "claude_chat");
  check("product becomes its own tool", !!chat && facts.some((f) => f.tool === "claude_in_chrome") && facts.some((f) => f.tool === "claude_cowork"));
  check("email match ignores case", chat?.memberId === "m1" && chat.externalId === EMAILS[0]);
  check("an older address registered as an identity maps to the member", facts.find((f) => f.tool === "claude_in_chrome")?.memberId === "m2");
  check("an unknown email stays unlinked", facts.find((f) => f.tool === "claude_cowork")?.memberId === "");
  check("without a breakdown the cache columns stay unmeasured", chat?.inputTokens === 30 && chat.cacheReadTokens === undefined && chat.fieldEvidence?.cacheReadTokens === undefined);
  check("a reported zero is a measurement", facts.find((f) => f.tool === "claude_in_chrome")?.fieldEvidence?.cacheReadTokens === "known");
  check("report rows carry the UTC date basis and source", chat?.dateBasis === "UTC" && chat.source === "claude-spend-csv");

  const local = [fact({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 9000, requests: 5 })];
  const bigger = fact({ source: "claude-spend-csv", inputTokens: 400, outputTokens: 100, fieldEvidence: { inputTokens: "known", outputTokens: "known" } });
  const smaller = fact({ source: "claude-spend-csv", inputTokens: 10, outputTokens: 5, fieldEvidence: { inputTokens: "known", outputTokens: "known" } });
  const merged = mergeReportFacts(local, [bigger]);
  check("larger report replaces the collected Claude Code rows", merged.length === 1 && merged[0].source === "claude-spend-csv");
  check("smaller report is dropped", mergeReportFacts(local, [smaller]).every((f) => f.source === "uploader"));
  check("cache reads do not decide the larger side", mergeReportFacts([fact({ inputTokens: 10, cacheReadTokens: 1e9 })], [bigger])[0].source === "claude-spend-csv");
  const tie = fact({ source: "claude-spend-csv", inputTokens: 100, outputTokens: 50, fieldEvidence: { inputTokens: "known", outputTokens: "known" } });
  check("a tie keeps the collected rows", mergeReportFacts(local, [tie]).every((f) => f.source === "uploader"));
  check("requests break a token tie", mergeReportFacts(local, [{ ...tie, requests: 6, fieldEvidence: { ...tie.fieldEvidence, requests: "known" } }])[0].source === "claude-spend-csv");
  check("the rule is per person: another member is untouched", mergeReportFacts(local, [{ ...bigger, memberId: "m2", externalId: EMAILS[1] }]).length === 2);
  check("the rule is per day", mergeReportFacts(local, [{ ...bigger, date: D2 }]).length === 2);
  check("unlinked Claude Code compares by email", mergeReportFacts([fact({ memberId: "", externalId: GHOST.toUpperCase(), inputTokens: 1 })], [{ ...bigger, memberId: "", externalId: GHOST }]).length === 1);
  check("other tools are never replaced", mergeReportFacts([fact({ tool: "codex", inputTokens: 1 })], [bigger, { ...bigger, tool: "claude_chat" }]).length === 3);

  check("date and member filters are supported", supportsReportMatch({ date: { $gte: D1, $lte: D2 }, memberId: { $ne: null } }) && supportsReportMatch({ memberId: null }));
  check("device, source, tool and hour filters get no report rows",
    !supportsReportMatch({ externalId: EMAILS[0] }) && !supportsReportMatch({ source: "uploader" }) && !supportsReportMatch({ tool: "claude_code" }) && !supportsReportMatch({ hour: { $gte: "x" } }));
}

async function cleanup() {
  await Promise.all([
    UsageDaily.deleteMany(OWN), MemberIdentity.deleteMany(OWN), Member.deleteMany({ email: { $in: EMAILS } }),
    UsageReport.deleteMany({ accountId: ACCOUNT }), ModelPrice.deleteMany({ registeredBy: PRICE_OWNER }),
  ]);
}

async function integration() {
  // Exact host/port/database allowlist, validated before any connection.
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\]):(27391|27397|27398)\/tf-v2-test-report-rows$/.test(process.env.MONGODB_URI ?? "")) {
    throw new Error("Refusing: use an isolated loopback test port and database tf-v2-test-report-rows only");
  }
  await connectDb();
  if (mongoose.connection.name !== DB_NAME) throw new Error("Refusing: actual database does not match the isolated fixture database");
  // Totals are unfiltered application queries: refuse mixed datasets.
  const foreign = await Promise.all([
    Member.countDocuments({ email: { $nin: EMAILS } }), UsageDaily.countDocuments({ externalId: { $nin: EMAILS } }),
    UsageHourly.countDocuments({}), UsageSession.countDocuments({}), UsageReport.countDocuments({ accountId: { $ne: ACCOUNT } }),
  ]);
  if (foreign.some(Boolean)) throw new Error("Refusing: isolated fixture database contains unrelated records");
  await cleanup();
  seeded = true;

  const members = await Member.create(EMAILS.map((email, i) => ({ email, name: `보고서 검증 ${i + 1}`, onboardedAt: new Date(), toolPrefs: [] })));
  const [one, two] = members.map((m) => String(m._id));
  await MemberIdentity.create([
    { memberId: members[0]._id, tool: "claude_code", externalId: EMAILS[0] },
    { memberId: members[1]._id, tool: "claude_report", externalId: OLD },
  ]);
  await ModelPrice.create([
    { family: MODEL, input: 2, output: 8, cacheRead: 1, cacheWrite: 4 },
    { family: REF, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
  ].map((r) => ({ ...r, effectiveFrom: RANGE.from, match: [`=${r.family}`], provider: "", priority: -100,
    sourceUrl: "https://example.test/synthetic-prices", checkedAt: TODAY, registeredBy: PRICE_OWNER, note: "Synthetic test prices; never for real usage" })));
  const known = { inputTokens: "known", outputTokens: "known", cacheReadTokens: "known", cacheCreationTokens: "known", requests: "known" };
  await UsageDaily.create([
    { date: D1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 0, requests: 5 },
    { date: D2, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 9 },
  ].map((r) => ({ ...r, tool: "claude_code", model: MODEL, externalId: EMAILS[0], memberId: members[0]._id, machineId: "report-rows-device",
    source: "uploader", dateBasis: "KST", fieldEvidence: known })) as never);
  const scope = { sourceId: "claude-spend-csv", accountId: ACCOUNT, timeZone: "UTC", partition: "" };
  const row = (date: string, end: string, coverage: string, product: string, externalId: string, metrics: Record<string, number>) => ({
    sourceId: scope.sourceId, accountId: ACCOUNT, product, externalId, model: MODEL, periodStart: date, periodEnd: end,
    timeZone: "UTC", granularity: date === end ? "day" : "period", coverage, metrics,
  });
  await UsageReport.create([
    // Stale import of the same day: must lose to the newer snapshot below.
    { ...scope, key: "report-rows-stale", periodStart: D1, periodEnd: D1, granularity: "day", coverage: "unknown", collectedAt: new Date(Date.now() - 86_400_000),
      rows: [row(D1, D1, "unknown", "Chat", EMAILS[0], { prompt_tokens: 900_000, completion_tokens: 900_000 })] },
    { ...scope, key: "report-rows-d1", periodStart: D1, periodEnd: D1, granularity: "day", coverage: "full", collectedAt: new Date(),
      rows: [
        row(D1, D1, "full", "Claude Code", EMAILS[0], { uncached_input_tokens: 400, completion_tokens: 100, cache_read_tokens: 2000, cache_write_tokens: 0 }),
        row(D1, D1, "full", "Chat", EMAILS[0], { prompt_tokens: 30, completion_tokens: 20 }),
        row(D1, D1, "full", "Cowork", OLD, { uncached_input_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }),
        row(D1, D1, "full", "Chat", GHOST, { uncached_input_tokens: 7, completion_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 }),
      ] },
    { ...scope, key: "report-rows-d2", periodStart: D2, periodEnd: D2, granularity: "day", coverage: "full", collectedAt: new Date(),
      rows: [row(D2, D2, "full", "Claude Code", EMAILS[0], { uncached_input_tokens: 100, completion_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 })] },
    // A whole-period report is not a daily record.
    { ...scope, key: "report-rows-period", periodStart: D1, periodEnd: D2, granularity: "period", coverage: "full", collectedAt: new Date(),
      rows: [row(D1, D2, "full", "Chat", EMAILS[0], { prompt_tokens: 700_000, completion_tokens: 700_000 })] },
  ] as never);

  const raw: UsageSelection = { unit: "raw", ref: null, basis: "all" };
  const snap = await getUsageObservationSnapshot(RANGE, raw);
  check("report products appear as tools", ["claude_chat", "claude_code", "claude_cowork"].every((t) => snap.tools.tools.includes(t)));
  const day = (date: string) => snap.people.data.find((d) => d.date === date) ?? {};
  near("day 1: larger report replaces collected Claude Code, Chat is added", day(D1)[`m${one}`] as number, 2500 + 50);
  near("day 2: collected Claude Code stays, smaller report is dropped", day(D2)[`m${one}`] as number, 1500);
  near("an older address counts for its owner", day(D1)[`m${two}`] as number, 15);
  near("an unknown email lands in the unlinked bucket", day(D1).other as number, 10);
  near("day total matches the lines", day(D1).__total as number, 2575);
  near("period total matches the lines", snap.totals.totalTokens, 2550 + 1500 + 15 + 10);
  const toolDay = snap.tools.data.find((d) => d.date === D1) ?? {};
  near("tool view: Claude Code is the report side on day 1", toolDay.claude_code as number, 2500);
  near("tool view: Chat sums linked and unlinked rows", toolDay.claude_chat as number, 60);
  check("three people were active", snap.totals.activeMembers === 3);

  const mine = await getMemberDailyConverted(one, RANGE, raw);
  near("member view agrees with the team view", mine.byDate.get(D1), 2550);
  const requests = await getUsageObservationSnapshot(RANGE, { unit: "raw", ref: null, basis: "requests" });
  near("requests: a report without a request count adds none", requests.totals.totalTokens, 9);
  const usd = await getMemberDailyConverted(one, RANGE, { unit: "usd", ref: null, basis: "all" });
  near("usd conversion covers report rows", usd.byDate.get(D1), (400 * 2 + 100 * 8 + 2000 * 1 + 30 * 2 + 20 * 8) / 1e6);
  const ref = await getMemberDailyConverted(one, RANGE, { unit: "ref", ref: REF, basis: "no-cache-read" });
  near("reference conversion covers report rows", ref.byDate.get(D1), 400 * 2 / 1 + 100 * 8 / 2 + 30 * 2 / 1 + 20 * 8 / 2);
  check("report rows are priced", usd.unpricedTokens === 0);

  const unmapped = await getUnmappedExternalIds("", raw);
  check("an unknown report email is listed as unlinked usage", unmapped.some((u) => u.externalId === GHOST && u.tool === "claude_chat" && u.tokens === 10));
  check("linked report emails are not listed as unlinked", !unmapped.some((u) => u.externalId === EMAILS[0] || u.externalId === OLD));
  const legacy = await getPeriodTotals(RANGE);
  near("fixed legacy totals (no selection) are unchanged", legacy.totalTokens, 150 + 1500);
}

async function main() {
  pure();
  if (process.env.MONGODB_URI) await integration();
  else console.log("MONGODB_URI not set: database checks skipped");
}

main()
  .catch((error) => { fail++; console.error(error instanceof Error ? error.message : error); })
  .finally(async () => {
    try { if (seeded) await cleanup(); } finally { await closeDb(); }
    console.log(`verify-usage-report-rows: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  });
