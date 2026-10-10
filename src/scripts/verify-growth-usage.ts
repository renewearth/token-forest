// Per person-day usage for the growth engine (src/lib/growth-days.ts): the pure
// combination rules, then the loaders against a DISPOSABLE MongoDB.
//   MONGODB_URI=mongodb://127.0.0.1:27398/tf-v2-test ./node_modules/.bin/tsx src/scripts/verify-growth-usage.ts
// Aborts unless the URI is one of the disposable test databases. Only its own
// synthetic members, rows and reports are created and removed.
import assert from "node:assert/strict";
import type { Types } from "mongoose";
import { closeDb, connectDb, Member, MemberIdentity, UsageDaily } from "@/lib/db";
import { UsageReport } from "@/lib/db/usage-report";
import { computeGrowth } from "@/lib/growth";
import {
  CLAUDE_REPORT_SOURCE, combineGrowthDays, GP_FAMILY_MIN_SHARE, GP_REF_FAMILY, loadGrowthDays,
  loadUnconfirmedGrowthDates, modelFamily, reportProductTool, unconfirmedAfter,
  type GrowthDailyRow, type GrowthReportRow,
} from "@/lib/growth-days";
import { SEED_TABLE } from "@/lib/pricing";
import { getGrowthDays, getUnconfirmedGrowthDates } from "@/lib/queries";
import { refRates } from "@/lib/units";
import { upsertUsageReportSnapshots } from "@/lib/usage-reports";
import type { UsageReportRow } from "@/lib/usage-report-types";

let checks = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    checks++;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    throw err;
  }
}

const D = "2026-10-01";
const SONNET = "claude-sonnet-5"; // the reference family: its tokens convert 1:1
const daily = (o: Partial<GrowthDailyRow>): GrowthDailyRow => ({ date: D, tool: "claude_code", model: SONNET, source: "uploader", ...o });
const report = (product: string, metrics: GrowthReportRow["metrics"], o: Partial<GrowthReportRow> = {}): GrowthReportRow => ({ date: D, product, model: SONNET, metrics, ...o });
const one = (rows: GrowthDailyRow[], reports: GrowthReportRow[] = []) => combineGrowthDays(SEED_TABLE, rows, reports);

function pure() {
  check("the reference family exists in the seeded price table", () => assert.ok(refRates(SEED_TABLE, GP_REF_FAMILY, D)));
  check("the family share is 10%", () => assert.equal(GP_FAMILY_MIN_SHARE, 0.1));

  // Cache reads are excluded; the reference model's own tokens convert 1:1.
  const local = daily({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 9_999, cacheCreationTokens: 300, requests: 5 });
  check("ladder tokens exclude cache reads", () => assert.deepEqual(one([local]), [{ date: D, tools: ["claude_code"], tokens: 600, requests: 5, families: ["sonnet"] }]));

  // Other products are added; Claude Code takes the larger side per measure.
  const cowork = report("Cowork", { uncached_input_tokens: 1_000, completion_tokens: 500, cache_read_tokens: 50_000, cache_write_tokens: 0, prompt_tokens: 51_000, reported_requests: 7 });
  const codeSmall = report("Claude Code", { uncached_input_tokens: 400, completion_tokens: 100, reported_requests: 9 });
  const mixed = one([local], [cowork, codeSmall])[0];
  check("other products are added to the day", () => assert.equal(mixed.tokens, 600 + 1_500));
  check("Claude Code tokens: larger side, not the sum (uploader larger)", () => assert.equal(mixed.tokens - 1_500, 600));
  check("Claude Code requests: larger side independently (report larger)", () => assert.equal(mixed.requests, 7 + 9));
  check("report products appear as tools", () => assert.deepEqual(mixed.tools, ["claude_code", "claude_cowork"]));
  const codeBig = report("Claude Code", { uncached_input_tokens: 4_000, completion_tokens: 1_000, reported_requests: 2 });
  const reversed = one([local], [codeBig])[0];
  check("Claude Code tokens: larger side (report larger)", () => assert.equal(reversed.tokens, 5_000));
  check("Claude Code requests: larger side (uploader larger)", () => assert.equal(reversed.requests, 5));
  check("a report-only Claude Code day is still one tool", () => assert.deepEqual(one([], [codeBig])[0].tools, ["claude_code"]));

  // Report rows without the cache breakdown fall back to prompt tokens.
  check("prompt tokens are the fallback input", () => assert.equal(one([], [report("Chat", { prompt_tokens: 800, completion_tokens: 200, reported_requests: 1 })])[0].tokens, 1_000));
  check("with a breakdown, prompt tokens are not used", () => assert.equal(one([], [report("Chat", { prompt_tokens: 99_999, uncached_input_tokens: 10, cache_read_tokens: 99_000, completion_tokens: 5 })])[0].tokens, 15));

  // A person with no Claude Code at all.
  const only = one([], [report("Cowork", { uncached_input_tokens: 300_000, completion_tokens: 0, reported_requests: 60 }), report("Chat", { uncached_input_tokens: 10, completion_tokens: 10, reported_requests: 3 })]);
  check("report-only people get a day", () => assert.deepEqual(only, [{ date: D, tools: ["claude_chat", "claude_cowork"], tokens: 300_020, requests: 63, families: ["sonnet"] }]));
  check("the report date is used as-is", () => assert.equal(one([], [report("Chat", { reported_requests: 1 }, { date: "2026-10-03" })])[0].date, "2026-10-03"));

  // Unpriced models: requests count, tokens do not.
  const unpriced = one([daily({ tool: "othertool", model: "mystery-model-x", inputTokens: 5_000, requests: 3 })])[0];
  check("an unpriced model adds requests only", () => assert.deepEqual([unpriced.tokens, unpriced.requests, unpriced.tools], [0, 3, ["othertool"]]));
  check("with no priced tokens, families with requests count", () => assert.deepEqual(unpriced.families, ["mystery"]));

  // Every collected tool counts, not just the agentic two.
  const multi = one([local, daily({ tool: "cursor", model: SONNET, source: "poller", inputTokens: 50, outputTokens: 50, requests: 4 }), daily({ tool: "gemini", model: SONNET, outputTokens: 100, requests: 2 })])[0];
  check("non-Claude tools are included", () => assert.deepEqual([multi.tools, multi.tokens], [["claude_code", "cursor", "gemini"], 600 + 100 + 100]));
  check("Cursor poller model rows do not add requests", () => assert.equal(multi.requests, 5 + 0 + 2));
  check("Cursor poller activity rows do add requests", () => assert.equal(one([daily({ tool: "cursor", model: "", source: "poller", requests: 12 })])[0].requests, 12));

  // Values that are not usage.
  check("Copilot poller quantities are ignored", () => assert.deepEqual(one([daily({ tool: "copilot", source: "poller", inputTokens: 9_000, requests: 9 })]), []));
  check("manually entered Copilot rows still count", () => assert.equal(one([daily({ tool: "copilot", source: "manual", model: SONNET, inputTokens: 9_000 })])[0].tokens, 9_000));
  check("unsupported fields are ignored", () => assert.equal(one([daily({ inputTokens: 10, requests: 7, fieldEvidence: { requests: "unsupported" } })])[0].requests, 0));
  check("an all-zero row is not an active day", () => assert.deepEqual(one([daily({ inputTokens: 0, outputTokens: 0, requests: 0 })]), []));
  check("an all-zero report row is not an active day", () => assert.deepEqual(one([], [report("Chat", { reported_requests: 0, completion_tokens: 0 })]), []));
  check("a sessions-only row is an active day", () => assert.equal(one([daily({ sessions: 1 })]).length, 1));
  check("fractional request counts are ignored", () => assert.deepEqual(one([daily({ requests: 1.5 })]), []));

  // Model families: product lines, 10% share.
  check("versions collapse into one family", () => assert.deepEqual([modelFamily(SEED_TABLE, "claude-opus-5", "claude_code", D), modelFamily(SEED_TABLE, "claude-opus-5-5", "claude_code", D)], ["opus", "opus"]));
  check("GPT and Codex are one family", () => assert.deepEqual([modelFamily(SEED_TABLE, "gpt-5.5", "codex", D), modelFamily(SEED_TABLE, "codex-auto-review", "codex", D), modelFamily(SEED_TABLE, "o3", "codex", D)], ["gpt", "gpt", "gpt"]));
  check("placeholders and empty names are not models", () => assert.deepEqual(["", "auto", "default", "premium", "unknown", "composer"].map((m) => modelFamily(SEED_TABLE, m, "cursor", D)), [null, null, null, null, null, null]));
  check("other vendors keep their own family", () => assert.deepEqual([modelFamily(SEED_TABLE, "gemini-3.5-flash", "gemini", D), modelFamily(SEED_TABLE, "grok-4.6", "grok", D)], ["gemini", "grok"]));
  const share = (minor: number) => one([daily({ outputTokens: 1_000 - minor }), daily({ tool: "othertool", model: "claude-haiku-4-5", outputTokens: minor })]);
  const haikuTokens = (minor: number) => one([daily({ tool: "othertool", model: "claude-haiku-4-5", outputTokens: minor })])[0].tokens;
  const below = share(100), total = below[0].tokens;
  check("a family under 10% of the day is not counted", () => assert.ok(haikuTokens(100) < total * 0.1 && JSON.stringify(below[0].families) === '["sonnet"]'));
  const above = share(600);
  check("a family at or above 10% is counted", () => assert.ok(haikuTokens(600) >= above[0].tokens * 0.1 && JSON.stringify(above[0].families) === '["haiku","sonnet"]'));
  // Exactly 10%: haiku H tokens beside sonnet 9H tokens.
  const h = haikuTokens(1_000);
  const exact = one([daily({ outputTokens: Math.round(9 * h) }), daily({ tool: "othertool", model: "claude-haiku-4-5", outputTokens: 1_000 })])[0];
  check("exactly 10% counts", () => assert.ok(Number.isInteger(9 * h) && exact.tokens === 10 * h && JSON.stringify(exact.families) === '["haiku","sonnet"]'));
  const under = one([daily({ outputTokens: Math.round(9 * h) + 1 }), daily({ tool: "othertool", model: "claude-haiku-4-5", outputTokens: 1_000 })])[0];
  check("just under 10% does not count", () => assert.deepEqual(under.families, ["sonnet"]));
  check("Claude Code families come from the side that supplied its tokens", () => assert.deepEqual(one([daily({ model: "claude-opus-5", outputTokens: 10 })], [report("Claude Code", { uncached_input_tokens: 5_000 })])[0].families, ["sonnet"]));

  check("days come back sorted", () => assert.deepEqual(one([daily({ date: "2026-10-03", requests: 1 }), daily({ date: "2026-10-02", requests: 1 })]).map((d) => d.date), ["2026-10-02", "2026-10-03"]));
  check("product names map to tool ids", () => assert.deepEqual(["Claude Code", "Cowork", "Chat", "Claude in Chrome", "Claude Design", "Office Agents", "Claude Tag"].map(reportProductTool), ["claude_code", "claude_cowork", "claude_chat", "claude_in_chrome", "claude_design", "claude_office_agents", "claude_tag"]));

  check("no report means nothing is unconfirmed", () => assert.equal(unconfirmedAfter(null, "2026-10-11").size, 0));
  check("days after the latest report are unconfirmed", () => assert.deepEqual([...unconfirmedAfter("2026-10-09", "2026-10-11")], ["2026-10-10", "2026-10-11"]));
  check("a report through today leaves nothing unconfirmed", () => assert.equal(unconfirmedAfter("2026-10-11", "2026-10-11").size, 0));
  check("only the first three days after the latest report stay unconfirmed", () => assert.deepEqual([...unconfirmedAfter("2026-10-01", "2026-10-11")], ["2026-10-02", "2026-10-03", "2026-10-04"]));
}

const ACCOUNT = "synthetic-gp-org";
const reportRow = (date: string, externalId: string, product: string, metrics: UsageReportRow["metrics"], coverage: "full" | "unknown" = "full"): UsageReportRow => ({
  sourceId: CLAUDE_REPORT_SOURCE, accountId: ACCOUNT, product, externalId, model: SONNET,
  periodStart: date, periodEnd: date, timeZone: "UTC", granularity: "period", coverage, metrics,
});
const snapshot = (date: string, rows: UsageReportRow[], coverage: "full" | "unknown" = "full", periodEnd = date) => ({
  sourceId: CLAUDE_REPORT_SOURCE, accountId: ACCOUNT, periodStart: date, periodEnd, timeZone: "UTC",
  granularity: "period" as const, coverage, partition: "", rows: rows.map((r) => ({ ...r, periodEnd, coverage })),
});

async function cleanup() {
  const members = await Member.find({ email: /@gp-fixture\.example\.test$/ }, { _id: 1 }).lean();
  const ids = members.map((m) => m._id);
  await Promise.all([
    UsageDaily.deleteMany({ memberId: { $in: ids } }),
    MemberIdentity.deleteMany({ memberId: { $in: ids } }),
    Member.deleteMany({ _id: { $in: ids } }),
    UsageReport.deleteMany({ accountId: ACCOUNT }),
  ]);
}

async function database() {
  await connectDb();
  await cleanup();
  // Unconfirmed dates are derived from every stored daily Claude report, so
  // refuse to run beside another task's reports instead of deleting them.
  const preexisting = await UsageReport.countDocuments({ sourceId: CLAUDE_REPORT_SOURCE, $expr: { $eq: ["$periodStart", "$periodEnd"] } });
  assert.equal(preexisting, 0, "another task left daily Claude reports in the disposable database");
  const none = await loadUnconfirmedGrowthDates("2026-10-11");
  check("no report at all → nothing unconfirmed", () => assert.equal(none.size, 0));

  const [a, b, c] = await Member.create([
    { name: "Fixture A", email: "a@gp-fixture.example.test" },
    { name: "Fixture B", email: "b@gp-fixture.example.test" },
    { name: "Fixture C", email: "c@gp-fixture.example.test" },
  ]);
  await MemberIdentity.create({ memberId: b._id, tool: "claude_report", externalId: "Old-B@gp-fixture.example.test" });
  const dailyDoc = (memberId: Types.ObjectId, o: Record<string, unknown>) => ({ date: D, tool: "claude_code", model: SONNET, externalId: "fixture", machineId: "sessions", memberId, source: "uploader", ...o });
  await UsageDaily.create([
    dailyDoc(a._id, { inputTokens: 100, outputTokens: 200, cacheReadTokens: 9_999, cacheCreationTokens: 300, requests: 5 }),
    dailyDoc(a._id, { tool: "codex", model: "gpt-5.5", outputTokens: 50, requests: 2 }),
    dailyDoc(a._id, { date: "2026-09-20", outputTokens: 10, requests: 1 }),
    dailyDoc(c._id, { tool: "copilot", source: "poller", inputTokens: 500, requests: 5 }),
  ]);
  await upsertUsageReportSnapshots([
    snapshot(D, [
      reportRow(D, "a@gp-fixture.example.test", "Cowork", { uncached_input_tokens: 1_000, completion_tokens: 500, cache_read_tokens: 50_000, reported_requests: 7 }),
      reportRow(D, "a@gp-fixture.example.test", "Claude Code", { uncached_input_tokens: 4_000, completion_tokens: 1_000, reported_requests: 2 }),
      reportRow(D, "old-b@gp-fixture.example.test", "Chat", { uncached_input_tokens: 30, completion_tokens: 20, reported_requests: 4 }),
      reportRow(D, "nobody@gp-fixture.example.test", "Chat", { completion_tokens: 999_999, reported_requests: 999 }),
      reportRow(D, "(org service usage)", "Claude Tag", { completion_tokens: 777_777, reported_requests: 777 }),
    ]),
    // The same day imported earlier under another coverage label: superseded.
    snapshot(D, [reportRow(D, "a@gp-fixture.example.test", "Cowork", { uncached_input_tokens: 900_000, reported_requests: 900 }, "unknown")], "unknown"),
    // A later single day for B only (a UTC date with no uploader record).
    snapshot("2026-10-02", [reportRow("2026-10-02", "old-b@gp-fixture.example.test", "Cowork", { uncached_input_tokens: 10, reported_requests: 1 })]),
    // A multi-day period report is not a daily record.
    snapshot("2026-09-01", [reportRow("2026-09-01", "a@gp-fixture.example.test", "Cowork", { uncached_input_tokens: 5_000_000, reported_requests: 5_000 })], "full", "2026-09-30"),
  ]);
  await UsageReport.updateOne({ accountId: ACCOUNT, periodStart: D, coverage: "unknown" }, { $set: { collectedAt: new Date("2026-01-01T00:00:00Z") } });

  const aDays = await loadGrowthDays(String(a._id), "2026-06-01");
  const aDay = aDays.find((d) => d.date === D)!;
  check("stored daily rows and the report combine for one member", () => assert.deepEqual(aDays.map((d) => d.date), ["2026-09-20", D]));
  const gptTokens = combineGrowthDays(SEED_TABLE, [daily({ tool: "codex", model: "gpt-5.5", outputTokens: 50 })], [])[0].tokens;
  check("Cowork is added, Claude Code takes the larger side (report), Codex is included", () => assert.equal(aDay.tokens, 1_500 + 5_000 + gptTokens));
  check("requests: Cowork 7 + Claude Code max(5, 2) + Codex 2", () => assert.equal(aDay.requests, 7 + 5 + 2));
  check("tools list covers uploader tools and report products", () => assert.deepEqual(aDay.tools, ["claude_code", "claude_cowork", "codex"]));
  check("the superseded same-day snapshot is not used", () => assert.ok(aDay.tokens < 100_000));
  check("the multi-day period report is ignored", () => assert.ok(!aDays.some((d) => d.date === "2026-09-01")));
  const sinceD = await loadGrowthDays(String(a._id), D);
  check("since is inclusive and filters earlier days", () => assert.deepEqual(sinceD.map((d) => d.date), [D]));

  const bDays = await loadGrowthDays(String(b._id), "2026-06-01");
  check("an identity email (any case) maps report rows to the member", () => assert.deepEqual(bDays, [
    { date: D, tools: ["claude_chat"], tokens: 50, requests: 4, families: ["sonnet"] },
    { date: "2026-10-02", tools: ["claude_cowork"], tokens: 10, requests: 1, families: ["sonnet"] },
  ]));
  check("a report-only member grows", () => assert.equal(computeGrowth(bDays, "2026-06-01", "2026-10-02").streakDays, 2));
  const cDays = await loadGrowthDays(String(c._id), "2026-06-01");
  check("unmapped report rows and Copilot poller rows give no days", () => assert.deepEqual(cDays, []));
  const viaQueries = await getGrowthDays(String(a._id), "2026-06-01");
  check("queries.getGrowthDays is the same loader", () => assert.deepEqual(viaQueries, aDays));

  const pending = await loadUnconfirmedGrowthDates("2026-10-05");
  check("unconfirmed = days after the latest single-day report", () => assert.deepEqual([...pending], ["2026-10-03", "2026-10-04", "2026-10-05"]));
  const pendingViaQueries = await getUnconfirmedGrowthDates("2026-10-05");
  check("queries.getUnconfirmedGrowthDates is the same loader", () => assert.deepEqual([...pendingViaQueries], [...pending]));
  const withPending = computeGrowth(bDays, "2026-06-01", "2026-10-05", undefined, pending);
  check("the member's streak holds while the report is pending", () => assert.deepEqual([withPending.streakDays, withPending.idleDays], [2, 0]));
  check("without the pending set the same days are idle", () => assert.equal(computeGrowth(bDays, "2026-06-01", "2026-10-05").streakDays, 0));

  await cleanup();
}

async function main() {
  pure();
  const uri = process.env.MONGODB_URI ?? "";
  if (!["mongodb://127.0.0.1:27391/tf-v2-test", "mongodb://127.0.0.1:27397/tf-v2-test", "mongodb://127.0.0.1:27398/tf-v2-test"].includes(uri)) {
    throw new Error("Pure checks passed. The database checks need a disposable tf-v2-test database (MONGODB_URI).");
  }
  await database();
  await closeDb();
  console.log(`${checks} growth usage checks passed`);
}
main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
