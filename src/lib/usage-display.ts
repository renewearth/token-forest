// Display-only projection. Stored facts and legacy growth definitions stay unchanged.
import type { PriceTable } from "@/lib/pricing";
import type { UsageSelection } from "@/lib/units";
import { kstDate } from "@/lib/date";
import { observeUsage, observeField, mergeObservations, OBSERVATION_FIELDS, type Observation, type ObservationInput, type ObservationField } from "@/lib/observation";

export type UsageFact = ObservationInput & {
  date: string; tool: string; model: string; memberId: string;
  externalId: string; machineId: string; hour: string;
};
export type DisplayRow = UsageFact & { tokens: number; unpricedTokens: number; observation: Observation; requests: number };
export function projectUsage(rows: UsageFact[], table: PriceTable, sel: UsageSelection): DisplayRow[] {
  const today = kstDate(Date.now());
  return rows.map((r) => {
    const observation = observeUsage(r, table, sel, today);
    return { ...r, tokens: observation.value ?? 0, requests: observeField(r, "requests").value ?? 0,
      unpricedTokens: observation.unpricedTokens, observation };
  });
}
export type UsageGroup = {
  tokens: number; unpricedTokens: number; requests: number;
  input: number; output: number; cacheRead: number; cacheCreation: number;
  lastDate: string; tools: Set<string>; users: Set<string>;
  observation: Observation; fields: Record<ObservationField, number | null>;
};
export function groupUsage(rows: DisplayRow[], key: (r: DisplayRow) => string): Map<string, UsageGroup> {
  const buckets = new Map<string, DisplayRow[]>();
  for (const r of rows) { const k = key(r); const bucket = buckets.get(k) ?? []; bucket.push(r); buckets.set(k, bucket); }
  const groups = new Map<string, UsageGroup>();
  for (const [k, items] of buckets) {
    const observation = mergeObservations(items.map((r) => r.observation));
    const fields = Object.fromEntries(OBSERVATION_FIELDS.map((f) => {
      const readings = items.flatMap((r) => { const v = observeField(r, f).value; return v === null ? [] : [v]; });
      return [f, readings.length ? readings.reduce((a, b) => a + b, 0) : null];
    })) as Record<ObservationField, number | null>;
    groups.set(k, { tokens: observation.value ?? 0, unpricedTokens: observation.unpricedTokens, requests: fields.requests ?? 0,
      input: fields.inputTokens ?? 0, output: fields.outputTokens ?? 0, cacheRead: fields.cacheReadTokens ?? 0, cacheCreation: fields.cacheCreationTokens ?? 0,
      lastDate: items.map((r) => r.date).sort().at(-1) ?? "", tools: new Set(items.map((r) => r.tool)),
      users: new Set(items.filter((r) => r.observation.hasRecord).map((r) => r.memberId ? `m${r.memberId}` : `x${r.externalId}`)), observation, fields });
  }
  return groups;
}
