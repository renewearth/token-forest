import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { connectDb, MemberIdentity } from "@/lib/db";
import { UsageReport } from "@/lib/db/usage-report";
import { usageReportRowSchema, usageReportSnapshotSchema, reportSnapshotFor, type UsageReportRow, type UsageReportSnapshot } from "@/lib/usage-report-types";

// A complete successfully fetched scope is one atomic document. Replacements
// remove model/user rows absent from the corrected report, including empty days.
export function usageReportKey(scope: Omit<UsageReportSnapshot, "rows">): string {
  return createHash("sha256").update(JSON.stringify([
    scope.sourceId, scope.accountId, scope.periodStart, scope.periodEnd,
    scope.timeZone, scope.granularity, scope.coverage, scope.partition,
  ])).digest("hex");
}
export async function upsertUsageReportSnapshots(input: UsageReportSnapshot[]): Promise<{ upserted: number }> {
  const snapshots = input.map(snapshot => usageReportSnapshotSchema.parse(snapshot));
  const unique = new Map<string, UsageReportSnapshot>();
  for (const snapshot of snapshots) {
    const key = usageReportKey(snapshot);
    if (unique.has(key)) throw new Error("같은 범위의 보고서가 중복되었습니다");
    unique.set(key, snapshot);
  }
  if (!snapshots.length) return { upserted: 0 };
  await connectDb(); await UsageReport.init();
  const collectedAt = new Date();
  await UsageReport.bulkWrite([...unique].map(([key, snapshot]) => ({ replaceOne: {
    filter: { key }, replacement: { ...snapshot, key, collectedAt }, upsert: true,
  } })), { ordered: true });
  return { upserted: snapshots.reduce((count, snapshot) => count + snapshot.rows.length, 0) };
}
export async function upsertUsageReports(input: UsageReportRow[]): Promise<{ upserted: number }> {
  const groups = new Map<string, UsageReportSnapshot>();
  for (const raw of input) {
    const row = usageReportRowSchema.parse(raw);
    const scope = reportSnapshotFor(row); const key = usageReportKey(scope);
    const snapshot = groups.get(key) ?? scope;
    snapshot.rows.push(row); groups.set(key, snapshot);
  }
  return upsertUsageReportSnapshots([...groups.values()]);
}

// Called only with the authenticated viewer. User-level cost reports are not
// published to every member; organization aggregate rows remain operator-only.
export async function latestMemberUsageReports(member: { id: string; email: string }, limit = 60): Promise<Array<UsageReportRow & { collectedAt: Date }>> {
  await connectDb();
  const identities = await MemberIdentity.find({ memberId: new Types.ObjectId(member.id), tool: "copilot" }, { externalId: 1 }).lean();
  const own = [
    { "rows.sourceId": { $in: ["claude-spend-csv", "gemini-workspace-activity"] }, "rows.externalId": member.email.toLowerCase() },
    ...identities.map(identity => ({ "rows.sourceId": "github-copilot-billing", "rows.externalId": identity.externalId, "rows.accountId": `github:user:${identity.externalId.toLowerCase()}` })),
  ];
  const max = Math.min(200, Math.max(1, limit));
  return UsageReport.aggregate([
    { $unwind: "$rows" }, { $match: { $or: own } },
    { $sort: { collectedAt: -1, periodEnd: -1, "rows.product": 1, "rows.model": 1 } }, { $limit: max },
    { $replaceRoot: { newRoot: { $mergeObjects: ["$rows", { collectedAt: "$collectedAt" }] } } },
  ]);
}
