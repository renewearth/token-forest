import type { Types } from "mongoose";
import { METRIC_FIELDS, type MetricField, type UsageRecord } from "../../packages/protocol/records.mjs";
import { UsageRecord as UsageRecordModel, UsageRecordChain, UsageRecordDerived } from "@/lib/db/usage-record";

type Numeric = Record<MetricField, number | null>;
type Contribution = { date: string; hour: string; model: string; verification: "verified" | "unverified"; metrics: Numeric; reset: boolean };
export type DerivedRow = { grain: "day" | "hour"; period: string; model: string; verification: "verified" | "unverified"; metrics: Numeric; fieldEvidence: Record<MetricField, "known" | "unknown">; resetCount: number };

function values(record: UsageRecord): Numeric {
  return Object.fromEntries(METRIC_FIELDS.map((f) => [f, record[f] ?? null])) as Numeric;
}

// Pure full-chain union: a delayed snapshot changes the following delta too.
// Timestamp ties with differing counters are ambiguous and remain unverified.
export function deriveRecordRows(records: UsageRecord[]): { rows: DerivedRow[]; conflictCount: number } {
  const sorted = [...records].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordId.localeCompare(b.recordId));
  const contributions: Contribution[] = [];
  const previous: Partial<Record<MetricField, number>> = {};
  let conflictCount = 0;
  let cumulativeTainted = false;
  let previousModel: string | null = null;
  for (let i = 0; i < sorted.length;) {
    const at = Date.parse(sorted[i].occurredAt);
    const group: UsageRecord[] = [];
    while (i < sorted.length && Date.parse(sorted[i].occurredAt) === at) group.push(sorted[i++]);
    const cumulatives = group.filter((r) => r.kind === "cumulative");
    const sig = new Set(cumulatives.map((r) => JSON.stringify([values(r), r.model, r.provider])));
    const ambiguous = sig.size > 1;
    if (ambiguous) conflictCount += cumulatives.length;
    if (ambiguous) cumulativeTainted = true;
    const acceptedCumulative = ambiguous ? [] : cumulatives.slice(0, 1);
    for (const r of [...group.filter((x) => x.kind === "event"), ...acceptedCumulative]) {
      const current = values(r);
      let reset = false;
      let impossibleCacheDelta = false;
      const metrics = { ...current };
      if (r.kind === "cumulative") {
        if (previousModel !== null && previousModel !== r.model) cumulativeTainted = true;
        if (r.completeness !== "final" || r.identityQuality !== "native") cumulativeTainted = true;
        for (const f of METRIC_FIELDS) {
          const n = current[f];
          if (n === null || r.fieldEvidence?.[f] !== "known") { metrics[f] = null; continue; }
          const prior = previous[f];
          if (prior !== undefined && n < prior) reset = true;
          metrics[f] = prior === undefined || n < prior ? n : n - prior;
          previous[f] = n;
        }
        // Cumulative inputTokens is the raw source total (including cache).
        // Only the derived increment is uncached input for the legacy graph.
        // Missing cache evidence makes that increment unknown, not raw input.
        const rawInputDelta = metrics.inputTokens;
        const cacheDelta = metrics.cacheReadTokens;
        if (rawInputDelta === null || cacheDelta === null) metrics.inputTokens = null;
        else {
          if (cacheDelta > rawInputDelta) impossibleCacheDelta = true;
          metrics.inputTokens = Math.max(0, rawInputDelta - cacheDelta);
        }
        // A drop might be a legitimate reset, but the wire carries no reset
        // proof. Preserve its candidate delta while blocking verified cutover.
        if (reset || impossibleCacheDelta) { cumulativeTainted = true; conflictCount++; }
        previousModel = r.model;
      }
      const date = new Date(Date.parse(r.occurredAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const hour = new Date(Date.parse(r.occurredAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 13);
      contributions.push({ date, hour, model: r.model,
        verification: r.completeness === "final" && r.identityQuality === "native" && (r.kind === "event" || !cumulativeTainted) ? "verified" : "unverified",
        metrics, reset });
    }
  }
  const groups = new Map<string, DerivedRow>();
  for (const c of contributions) for (const [grain, period] of [["day", c.date], ["hour", c.hour]] as const) {
    const key = JSON.stringify([grain, period, c.model, c.verification]);
    let row = groups.get(key);
    if (!row) {
      row = { grain, period, model: c.model, verification: c.verification,
        metrics: Object.fromEntries(METRIC_FIELDS.map((f) => [f, 0])) as Numeric,
        fieldEvidence: Object.fromEntries(METRIC_FIELDS.map((f) => [f, "known"])) as DerivedRow["fieldEvidence"], resetCount: 0 };
      groups.set(key, row);
    }
    if (c.reset) row.resetCount++;
    for (const f of METRIC_FIELDS) {
      if (c.metrics[f] === null) { row.metrics[f] = null; row.fieldEvidence[f] = "unknown"; }
      else if (row.metrics[f] !== null) row.metrics[f] += c.metrics[f];
    }
  }
  return { rows: [...groups.values()].sort((a, b) => a.period.localeCompare(b.period) || a.model.localeCompare(b.model)), conflictCount };
}

export async function deriveRecordChain(memberId: Types.ObjectId, tool: string, accountId: string, sessionId: string) {
  const key = { memberId, tool, accountId, sessionId };
  const chain = await UsageRecordChain.findOne(key).lean();
  if (!chain) return { rows: [], conflictCount: 0, generation: 0 };
  const stored = await UsageRecordModel.find(key).sort({ occurredAt: 1, recordId: 1 }).lean();
  const source = stored.map((r) => r.semantics as UsageRecord);
  const result = deriveRecordRows(source);
  // A newer derivation can never be replaced by this snapshot. Readers must
  // compare derived.generation with chain.generation before treating it current.
  await UsageRecordDerived.findOneAndUpdate(
    { ...key, $or: [{ generation: { $lt: chain.generation } }, { generation: { $exists: false } }] },
    { $set: { ...key, generation: chain.generation, rows: result.rows, conflictCount: result.conflictCount, derivedAt: new Date() } },
    { upsert: true, returnDocument: "after" },
  ).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
  });
  return { ...result, generation: chain.generation };
}
