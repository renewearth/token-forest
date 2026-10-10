import { Types } from "mongoose";
import { connectDb, Member, MemberIdentity, UsageDaily } from "@/lib/db";
import { getSyncFreshness } from "@/lib/queries";

export type CollectionHistory = {
  tool: string;
  rows: number;
  latestUsageDate: string | null;
  lastReceivedAt: string | null;
};

const iso = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;

export async function getMemberCollectionHistory(member: { id: string; email: string }) {
  await connectDb();
  const id = new Types.ObjectId(member.id);
  const [identities, settings] = await Promise.all([
    MemberIdentity.find({ memberId: id }, { tool: 1, externalId: 1 }).lean(),
    Member.aggregate<{ hasGitHubCredential: boolean }>([
      { $match: { _id: id } },
      { $project: { _id: 0, hasGitHubCredential: { $and: [
        { $eq: [{ $type: "$githubTokenEnc" }, "string"] }, { $ne: ["$githubTokenEnc", ""] },
      ] } } },
    ]),
  ]);
  // A linked row belongs to its member even when an external identifier was
  // reused. Only unlinked rows may fall back to verified member identities.
  const fallback = [
    { externalId: member.email, source: "uploader" },
    ...identities.map(({ tool, externalId }) => ({ tool, externalId })),
  ];
  const rows = await UsageDaily.aggregate([
    { $match: { $or: [{ memberId: id }, { memberId: null, $or: fallback }] } },
    { $group: { _id: "$tool", rows: { $sum: 1 }, latestUsageDate: { $max: "$date" }, lastReceivedAt: { $max: "$updatedAt" } } },
    { $sort: { _id: 1 } },
  ]);
  return {
    history: rows.map((row): CollectionHistory => ({ tool: row._id, rows: row.rows, latestUsageDate: row.latestUsageDate ?? null, lastReceivedAt: iso(row.lastReceivedAt) })),
    copilot: { identityConfigured: identities.some(i => i.tool === "copilot"), credentialConfigured: settings[0]?.hasGitHubCredential ?? false },
  };
}

export async function getUsageFreshness() {
  await connectDb();
  const [usage, api] = await Promise.all([
    UsageDaily.aggregate([
      { $group: { _id: "$tool", latestUsageDate: { $max: "$date" }, lastReceivedAt: { $max: "$updatedAt" } } },
    ]),
    getSyncFreshness(),
  ]);
  const byTool = new Map(usage.map(row => [String(row._id), row]));
  const apiByTool = new Map(api.map(row => [row.tool, row]));
  return [...new Set([...byTool.keys(), ...apiByTool.keys()])].sort().map(tool => {
    const row = byTool.get(tool), sync = apiByTool.get(tool);
    return { tool, latestUsageDate: (row?.latestUsageDate as string | undefined) ?? null,
      lastReceivedAt: iso(row?.lastReceivedAt), apiStatus: sync?.status ?? null, apiCheckedAt: sync?.ranAt ?? null };
  });
}
