import { Types } from "mongoose";
import { randomBytes } from "node:crypto";
import { connectDb, closeDb, Member, UsageDaily, SyncRun } from "@/lib/db";
import { upsertUsageReports } from "@/lib/usage-reports";

async function main() {
  if (process.env.MONGODB_URI !== "mongodb://127.0.0.1:27397/tf-v2-test-collection-preview") throw new Error("Collection preview synthetic database only");
  await connectDb();
  const members = ["합성 구성원 가", "합성 구성원 나", "합성 구성원 다"];
  for (let i = 0; i < members.length; i++) {
    const memberId = new Types.ObjectId(`00000000000000000000000${i + 1}`);
    const email = `fixture-${String.fromCharCode(97 + i)}@example.test`;
    await Member.updateOne({ _id: memberId }, { $set: { name: members[i], email, onboardedAt: new Date("2026-10-01T00:00:00Z") }, $setOnInsert: { ingestToken: randomBytes(32).toString("hex") } }, { upsert: true });
    for (let d = 1; d <= 6; d++) await UsageDaily.updateOne({ date: `2026-10-0${d}`, tool: "codex", model: "gpt-5", externalId: email, machineId: "synthetic" }, {
      $set: { memberId, inputTokens: (i + 1) * d * 1100, outputTokens: d * 90, cacheReadTokens: null, cacheCreationTokens: null, requests: d + i,
        source: "uploader", dateBasis: "KST", fieldEvidence: { inputTokens: "known", outputTokens: "known", cacheReadTokens: "unknown", cacheCreationTokens: "unsupported", requests: "known" } },
    }, { upsert: true });
  }
  await upsertUsageReports([
    { sourceId: "claude-spend-csv", accountId: "합성 조직", product: "Claude Chat", externalId: "fixture-a@example.test", model: "claude-sonnet-4-6", periodStart: "2026-10-01", periodEnd: "2026-10-06", timeZone: "UTC", granularity: "period", coverage: "overage", metrics: { prompt_tokens: 3200, completion_tokens: 400, reported_requests: 8, net_cost_usd: 0.02 } },
    { sourceId: "github-copilot-billing", accountId: "합성 조직", product: "GitHub Copilot AI credits", externalId: "org:synthetic", model: "", periodStart: "2026-10-02", periodEnd: "2026-10-02", timeZone: "UTC", granularity: "day", coverage: "full", metrics: { ai_credits: 2.75, net_cost_usd: 0.025 } },
    { sourceId: "gemini-workspace-activity", accountId: "합성 조직", product: "gemini_workspace:gemini_app", externalId: "fixture-b@example.test", model: "", periodStart: "2026-10-03", periodEnd: "2026-10-03", timeZone: "UTC", granularity: "day", coverage: "unknown", metrics: { active_uses: 3 } },
  ]);
  await SyncRun.updateOne({ tool: "copilot:organization:ai_credits:synthetic-hidden-org" }, { $set: { connectorTool: "copilot", status: "partial", lastSyncedDate: "2026-10-02", emptyScopeCount: 1 } }, { upsert: true });
  await SyncRun.updateOne({ tool: "gemini_workspace:synthetic-hidden-customer" }, { $set: { connectorTool: "gemini_workspace", status: "empty", emptyScopeCount: 1 } }, { upsert: true });
  console.log("Synthetic collection preview: 3 members, 18 daily rows, 3 reference reports");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeDb);
