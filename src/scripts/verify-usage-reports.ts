import assert from "node:assert/strict";
import { Types } from "mongoose";
import { buildWeeklyReport } from "@/lib/slack";
import { isoDaysAgo } from "@/lib/date";
import { parseClaudeSpendCsv, parseReportCsv } from "@/lib/report-import";
import { usageReportRowSchema, reportSnapshotFor } from "@/lib/usage-report-types";
import { upsertUsageReports, upsertUsageReportSnapshots, latestMemberUsageReports } from "@/lib/usage-reports";
import { UsageReport } from "@/lib/db/usage-report";
import { connectDb, closeDb, UsageDaily, MemberIdentity } from "@/lib/db";
import { fetchGeminiWorkspaceReports } from "@/connectors/gemini-workspace";

let checks = 0;
function check(fn: () => void) { fn(); checks++; }
async function main() {
  if (!["mongodb://127.0.0.1:27397/tf-v2-test", "mongodb://127.0.0.1:27398/tf-v2-test"].includes(process.env.MONGODB_URI ?? "")) throw new Error("Use the collection task's disposable database only");
  const context = { accountId: "synthetic-org", periodStart: "2026-10-01", periodEnd: "2026-10-06", timeZone: "UTC", coverage: "overage" as const };
  const csv = 'email,product,model,total_requests,total_prompt_tokens,total_completion_tokens,total_net_spend_usd\r\nfixture@example.test,Chat,"model, quoted",0,,35,1.25\r\n';
  const rows = parseClaudeSpendCsv(csv, context);
  check(() => assert.equal(rows.length, 1));
  check(() => assert.deepEqual(rows[0].metrics, { completion_tokens: 35, reported_requests: 0, net_cost_usd: 1.25 }));
  check(() => assert.equal(rows[0].granularity, "period"));
  check(() => assert.equal(rows[0].coverage, "overage"));
  check(() => assert.equal(rows[0].periodEnd, "2026-10-06"));
  check(() => assert.deepEqual(parseReportCsv('\uFEFFa,b\r\n"x\ny","a""b"'), [["a", "b"], ["x\ny", 'a"b']]));
  for (const invalid of ['a,b\n"unterminated', 'a,b\n"x"bad,2']) check(() => assert.throws(() => parseReportCsv(invalid)));
  check(() => assert.throws(() => parseClaudeSpendCsv(csv.replace(",0,,35", ",-1,,35"), context)));
  check(() => assert.throws(() => parseClaudeSpendCsv(csv + csv.split("\r\n")[1], context)));
  check(() => assert.throws(() => usageReportRowSchema.parse({ ...rows[0], periodStart: "2026-02-30" })));
  check(() => assert.throws(() => usageReportRowSchema.parse({ ...rows[0], timeZone: "guess" })));
  check(() => assert.throws(() => usageReportRowSchema.parse({ ...rows[0], raw: { prompt: "must not persist" } })));
  check(() => assert.throws(() => usageReportRowSchema.parse({ ...rows[0], metrics: { completion_tokens: Infinity } })));
  await connectDb(); await UsageReport.deleteMany({ accountId: context.accountId });
  const before = await UsageDaily.countDocuments();
  await upsertUsageReports(rows); await upsertUsageReports(rows);
  assert.equal(await UsageReport.countDocuments({ accountId: context.accountId }), 1); checks++;
  assert.equal(await UsageDaily.countDocuments(), before); checks++;
  await assert.rejects(upsertUsageReports([rows[0], rows[0]])); checks++;
  const stored = await UsageReport.findOne({ accountId: context.accountId }).lean();
  check(() => assert.equal(stored?.rows[0]?.metrics.prompt_tokens, undefined));
  check(() => assert.equal(stored?.rows[0]?.metrics.reported_requests, 0));
  const corrected = { ...rows[0], model: "corrected-model" };
  await upsertUsageReports([corrected]);
  const replaced = await UsageReport.findOne({ accountId: context.accountId }).lean();
  check(() => assert.deepEqual(replaced?.rows.map(row => row.model), ["corrected-model"]));
  await upsertUsageReportSnapshots([reportSnapshotFor(corrected)]);
  const emptied = await UsageReport.findOne({ accountId: context.accountId }).lean();
  check(() => assert.deepEqual(emptied?.rows, []));
  const stranger = { ...rows[0], externalId: "stranger@example.test", metrics: { net_cost_usd: 975.5 } };
  await upsertUsageReports([rows[0], stranger]);
  const memberId = new Types.ObjectId();
  const mine = await latestMemberUsageReports({ id: String(memberId), email: "fixture@example.test" });
  check(() => assert.equal(mine.length, 1));
  check(() => assert.equal(mine[0].externalId, "fixture@example.test"));
  check(() => assert.equal(mine.some(row => row.metrics.net_cost_usd === 975.5), false));
  const copilot = { ...rows[0], sourceId: "github-copilot-billing", product: "GitHub Copilot AI credits", accountId: "github:organization:test-org", externalId: "fixture-login", metrics: { ai_credits: 8.5 } };
  await upsertUsageReports([copilot]);
  await MemberIdentity.create({ memberId, tool: "copilot", externalId: "fixture-login" });
  const withIdentity = await latestMemberUsageReports({ id: String(memberId), email: "fixture@example.test" });
  check(() => assert.equal(withIdentity.some(row => row.accountId === copilot.accountId), false));
  await MemberIdentity.deleteMany({ memberId });
  await UsageReport.deleteMany({ accountId: copilot.accountId });
  const legacy = await UsageDaily.create({ date: isoDaysAgo(3), tool: "copilot", model: "synthetic-legacy", externalId: "reports-verification", machineId: "", source: "poller", requests: 987654 });
  try { const text = await buildWeeklyReport(); check(() => assert.equal(text.includes("987,654"), false)); }
  finally { await UsageDaily.deleteOne({ _id: legacy._id }); }
  await upsertUsageReports([{ ...rows[0], periodEnd: "2026-10-07" }]);
  assert.equal(await UsageReport.countDocuments({ accountId: context.accountId }), 2); checks++;

  // Synthetic adapter examples follow public schema; they are not a recorded
  // response from this company's account and cannot prove plan entitlement.
  const activity = (id: string, category: string) => ({ id: { time: "2026-10-01T23:30:00Z", uniqueQualifier: id, applicationName: "gemini_in_workspace_apps", customerId: "synthetic-org" }, actor: { email: "fixture@example.test" }, events: [{ name: "feature_utilization", type: "ai_usage_event", parameters: [{ name: "app_name", value: "gemini_app" }, { name: "event_category", value: category }] }] });
  const a = activity("one", "active_conversations"); let calls = 0;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    check(() => assert.equal(url.searchParams.get("startTime"), "2026-10-01T00:00:00Z"));
    check(() => assert.equal(url.searchParams.has("access_token"), false));
    check(() => assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic"));
    calls++;
    return Response.json(calls === 1 ? { items: [a, activity("passive", "inactive")], nextPageToken: "next" } : { items: [a, activity("two", "active_generate"), activity("unknown", "unknown")] });
  }) as typeof fetch;
  const reports = await fetchGeminiWorkspaceReports("2026-10-01", { accountId: "synthetic-org", token: "synthetic", fetcher: fake, now: new Date("2026-10-07T00:00:00Z") });
  check(() => assert.equal(calls, 2)); check(() => assert.equal(reports.length, 1));
  check(() => assert.deepEqual(reports[0].metrics, { active_uses: 2 }));
  check(() => assert.equal(reports[0].periodStart, "2026-10-01"));
  check(() => assert.equal(reports[0].coverage, "unknown"));
  await assert.rejects(fetchGeminiWorkspaceReports("2026-10-01", { accountId: "synthetic-org", token: "synthetic", fetcher: (async () => new Response("private body", { status: 403 })) as typeof fetch }), /HTTP 403/); checks++;
  await assert.rejects(fetchGeminiWorkspaceReports("2026-10-01", { accountId: "wrong-account", token: "synthetic", fetcher: (async () => Response.json({ items: [a] })) as typeof fetch }), /계정 범위/); checks++;
  await UsageReport.deleteMany({ accountId: context.accountId });
  console.log(`usage reports: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeDb);
