import { connectDb, Member, VISIBLE_MEMBER, UsageDaily, UsageHourly } from "@/lib/db";
import { sourceDateBasis } from "@/lib/observation";
import { observeField, OBSERVATION_FIELDS } from "@/lib/observation";
import { applyReviewedCutovers } from "@/lib/collection-cutover-db";
import type { UsageFact } from "@/lib/usage-display";
import { activityDate, buildActivityCalendar, type ActivityEvidence } from "@/lib/activity-calendar";
import { todayKst } from "@/lib/date";

// Field semantics match observeField: measured positive subtotals count;
// billing quantities, unsupported fields, negatives and malformed counts do not.
const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests", "sessions"];
function positiveExpression() {
  return { $or: FIELDS.map(field => ({ $and: [
    { $isNumber: `$${field}` }, { $gt: [`$${field}`, 0] },
    { $lt: [`$${field}`, Number.MAX_VALUE] },
    { $ne: [`$fieldEvidence.${field}`, "unsupported"] },
    { $not: [{ $and: [{ $eq: ["$source", "poller"] }, { $or: [
      { $eq: ["$tool", "copilot"] },
      ...(field === "requests" ? [{ $and: [{ $eq: ["$tool", "cursor"] }, { $ne: [{ $ifNull: ["$model", ""] }, ""] }] }] : []),
    ] }] }] },
    ...(["requests", "sessions"].includes(field) ? [{ $eq: [{ $mod: [{ $cond: [{ $and: [{ $isNumber: `$${field}` }, { $lt: [`$${field}`, Number.MAX_VALUE] }, { $gt: [`$${field}`, 0] }] }, `$${field}`, 0] }, 1] }, 0] }] : []),
  ] })) };
}

export async function getActivityCalendar(today = todayKst()) {
  await connectDb();
  const members = await Member.find(VISIBLE_MEMBER, { name: 1 }).sort({ _id: 1 }).lean();
  const ids = members.map(m => m._id);
  const read = async (hourly: boolean): Promise<ActivityEvidence[]> => {
    const match = { memberId: { $in: ids } };
    const collection = hourly ? UsageHourly : UsageDaily;
    // Aggregate before leaving MongoDB. Model/device duplicates cannot inflate
    // activity dates and source accounts/credentials never enter the result.
    const rows = await collection.aggregate([
      { $match: match },
      { $project: { memberId: 1, date: hourly ? { $substrBytes: ["$hour", 0, 10] } : "$date", hour: hourly ? "$hour" : { $literal: "" },
        tool: 1, source: 1, dateBasis: 1, positive: { $cond: [positiveExpression(), 1, 0] } } },
      { $group: { _id: { memberId: "$memberId", date: "$date", hour: "$hour", tool: "$tool", source: "$source", dateBasis: "$dateBasis" }, positive: { $max: "$positive" } } },
      { $match: { positive: 1 } },
    ]);
    const facts = rows.map(r => {
      const item = r._id;
      // Preserve explicit unknown basis. New server poller rows carry UTC;
      // legacy missing metadata follows the existing observation convention.
      const dateBasis = sourceDateBasis({ ...item });
      const evidence = { ...item, dateBasis } as ActivityEvidence;
      // Reviewed local replacements are scoped to Korean dates. Normalize the
      // scope key BEFORE replacement while retaining the original hourly basis.
      const date = hourly ? activityDate(evidence) ?? item.date : item.date;
      return { ...item, date, dateBasis, memberId: String(item.memberId), model: "", externalId: "", machineId: "", positive: true };
    }) as Array<UsageFact & { positive?: boolean }>;
    const selected = await applyReviewedCutovers(facts, match, hourly ? "hour" : "day");
    return selected.map(row => ({ memberId: row.memberId, date: row.date, hour: row.hour,
      tool: row.tool, source: row.source ?? "", dateBasis: sourceDateBasis(row),
      positive: "positive" in row ? row.positive === true : OBSERVATION_FIELDS.some(field => (observeField(row, field).value ?? 0) > 0),
    }));
  };
  const [daily, hourly] = await Promise.all([read(false), read(true)]);
  return buildActivityCalendar(members.map(m => ({ id: String(m._id), name: m.name })), [...daily, ...hourly], today);
}
