import { readFile } from "node:fs/promises";
import { Types } from "mongoose";
import { UsageRecord, UsageRecordConflict } from "@/lib/db/usage-record";
import { deriveRecordRows } from "@/lib/record-derivation";
import { cutoverSchema, cutoverBlockers, replaceReviewedScopes, supportsCutoverMatch, matchesFact, type CutoverScope, type LedgerEntry } from "@/lib/collection-cutover";
import type { UsageRecord as Semantics } from "../../packages/protocol/records.mjs";
import type { UsageFact } from "@/lib/usage-display";
import { todayKst } from "@/lib/date";

export async function readCutoverCandidate(scope: CutoverScope, grain: "day" | "hour") {
  // Read from the beginning, including the cumulative baseline before the day.
  // The digest freezes that complete history through the reviewed day's end.
  const filter = { memberId: new Types.ObjectId(scope.memberId), tool: scope.tool, date: { $lte: scope.date } };
  const docs = await UsageRecord.find(filter).lean();
  const entries: LedgerEntry[] = docs.map((d) => ({ semantics: d.semantics as Semantics, digest: d.digest }));
  const conflicts = await UsageRecordConflict.countDocuments({ memberId: filter.memberId, tool: scope.tool });
  const chains = new Map<string, Semantics[]>();
  for (const e of entries) {
    const key = JSON.stringify([e.semantics.accountId, e.semantics.sessionId]);
    const group = chains.get(key) ?? []; group.push(e.semantics); chains.set(key, group);
  }
  let conflictCount = conflicts;
  let unverified = false;
  const facts: UsageFact[] = [];
  for (const records of chains.values()) {
    const result = deriveRecordRows(records); conflictCount += result.conflictCount;
    for (const row of result.rows) if (row.grain === grain && row.period.slice(0, 10) === scope.date) {
      if (row.verification !== "verified") unverified = true;
      facts.push({ date: scope.date, hour: grain === "hour" ? row.period : "", tool: scope.tool, model: row.model,
        memberId: scope.memberId, externalId: records[0].accountId, machineId: "", source: "uploader-records",
        ...row.metrics, fieldEvidence: row.fieldEvidence, dateBasis: "KST", updatedAt: scope.reviewedAt });
    }
  }
  const blockers = cutoverBlockers(scope, entries, todayKst(), conflictCount);
  if (!facts.length) blockers.push("target_day_unobserved");
  if (unverified) blockers.push("unverified_derived");
  return { scope, facts, entries, conflictCount, blockers };
}

export async function applyReviewedCutovers(legacy: UsageFact[], match: Record<string, unknown>, grain: "day" | "hour"): Promise<UsageFact[]> {
  const file = process.env.TOKEN_FOREST_RECORD_CUTOVER_FILE;
  if (!file || !supportsCutoverMatch(match)) return legacy;
  // A corrupt manifest is a visible configuration error, never a silent switch.
  const manifest = cutoverSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const candidates = [];
  for (const scope of manifest.scopes) {
    // Date/member/tool filters must match before loading a user's ledger. For
    // hourly queries, filter each derived hour after replacing the day scope.
    const dayMatch = Object.fromEntries(Object.entries(match).filter(([key]) => key !== "hour"));
    const fact = { ...scope, externalId: "", machineId: "", model: "", hour: "" } as UsageFact;
    if (!matchesFact(fact, dayMatch)) continue;
    const candidate = await readCutoverCandidate(scope, grain);
    if (candidate.blockers.length) {
      // Do not silently revert a reviewed source to legacy inflated totals.
      // Operator must review the changed ledger or explicitly remove the scope.
      throw Error(`Reviewed collection scope requires reconciliation: ${candidate.blockers.join(",")}`);
    }
    candidate.facts = candidate.facts.filter((r) => matchesFact(r, match));
    candidates.push(candidate);
  }
  return replaceReviewedScopes(legacy, candidates);
}
