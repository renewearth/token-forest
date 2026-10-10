import { BASIS_KINDS, convert, type Kind, type TokenBasis, type UsageSelection } from "@/lib/units";
import type { PriceTable, WeightableRow } from "@/lib/pricing";

export type ObservationField = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "requests" | "sessions";
export type FieldStatus = "known" | "unknown" | "unsupported";
export type DateBasis = "KST" | "UTC" | "미확인";
export type Observation = {
  value: number | null;
  status: "observed" | "confirmed-zero" | "unknown" | "unsupported";
  complete: boolean;
  hasRecord: boolean;
  invalid: boolean;
  unknownFields: ObservationField[];
  unsupportedFields: ObservationField[];
  unpricedTokens: number;
  dateBases: DateBasis[];
  sources: string[];
  lastReceived: string | null;
  inProgress: boolean;
};
export type ObservationInput = WeightableRow & {
  date: string; tool?: string; memberId?: string; externalId?: string; source?: string;
  requests?: number | null; sessions?: number | null; updatedAt?: Date | string;
  // This evidence is deliberately opt-in. Historical zero defaults are not evidence.
  fieldEvidence?: Partial<Record<ObservationField, FieldStatus>>;
  dateBasis?: DateBasis;
  completeEvidence?: { source: string; account: string; date: string; fields: ObservationField[] };
};
const KIND_FIELD: Record<Kind, ObservationField> = {
  input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadTokens", cacheWrite: "cacheCreationTokens",
};
export const OBSERVATION_FIELDS: ObservationField[] = [...Object.values(KIND_FIELD), "requests", "sessions"];
export function selectedFields(basis: TokenBasis): ObservationField[] {
  return basis === "requests" ? ["requests"] : BASIS_KINDS[basis].map((k) => KIND_FIELD[k]);
}
export function observeField(row: ObservationInput, field: ObservationField): { value: number | null; status: FieldStatus; invalid: boolean } {
  const evidence = row.fieldEvidence?.[field];
  // Historical poller Copilot rows contain billing quantities, not model calls.
  // Cursor token events deliberately omit requests to avoid duplicate daily totals.
  const unsupported = evidence === "unsupported" || (row.source === "poller" && (
    (row.tool === "copilot") ||
    (row.tool === "cursor" && !!row.model && field === "requests")
  ));
  if (unsupported) return { value: null, status: "unsupported", invalid: false };
  const value = row[field];
  if (value === undefined || value === null) return { value: null, status: "unknown", invalid: false };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || ((field === "requests" || field === "sessions") && !Number.isInteger(value))) {
    return { value: null, status: "unknown", invalid: true };
  }
  // An incomplete aggregate may still contain a measured positive subtotal.
  // Keep that lower bound while marking completeness unknown. An unproven 0
  // cannot distinguish no usage from missing data.
  if (evidence === "unknown") return { value: value > 0 ? value : null, status: "unknown", invalid: false };
  if (value === 0 && evidence !== "known") return { value: null, status: "unknown", invalid: false };
  return { value, status: "known", invalid: false };
}
export function sourceDateBasis(row: ObservationInput): DateBasis {
  if (row.dateBasis) return row.dateBasis;
  // These pollers explicitly create UTC date buckets. Uploader tools/versions
  // mix conventions; do not infer their basis from a tool name or heartbeat.
  return row.source === "poller" && (row.tool === "cursor" || row.tool === "copilot") ? "UTC" : "미확인";
}
export function emptyObservation(): Observation {
  return { value: null, status: "unknown", complete: false, hasRecord: false, invalid: false,
    unknownFields: [], unsupportedFields: [], unpricedTokens: 0, dateBases: [], sources: [], lastReceived: null, inProgress: false };
}
export function observeUsage(row: ObservationInput, table: PriceTable, sel: UsageSelection, today?: string): Observation {
  const fields = selectedFields(sel.basis);
  const readings = fields.map((field) => ({ field, ...observeField(row, field) }));
  const known = readings.filter((r) => r.status === "known");
  const measured = readings.filter((r) => r.value !== null);
  const clean: ObservationInput = { date: row.date, tool: row.tool, model: row.model };
  for (const field of OBSERVATION_FIELDS) clean[field] = 0;
  for (const item of measured) clean[item.field] = item.value;
  const converted = measured.length ? convert(table, clean, sel.basis === "requests" ? "raw" : sel.unit, sel.ref, row.date, sel.basis) : null;
  const evidence = row.completeEvidence;
  const complete = !!evidence && evidence.source === row.source && evidence.account === row.externalId && evidence.date === row.date &&
    fields.every((f) => evidence.fields.includes(f)) && known.length === fields.length && row.date !== today && !converted?.unpriced;
  const value = converted && !converted.unpriced ? converted.value : null;
  const timestamp = row.updatedAt ? new Date(row.updatedAt).getTime() : NaN;
  return { value, complete, status: value === null ? (readings.every((r) => r.status === "unsupported") ? "unsupported" : "unknown") : complete && value === 0 ? "confirmed-zero" : "observed",
    hasRecord: OBSERVATION_FIELDS.some((f) => (observeField(row, f).value ?? 0) > 0),
    invalid: readings.some((r) => r.invalid), unknownFields: readings.filter((r) => r.status === "unknown").map((r) => r.field),
    unsupportedFields: readings.filter((r) => r.status === "unsupported").map((r) => r.field),
    unpricedTokens: converted?.unpriced ? measured.reduce((sum, r) => sum + r.value!, 0) : 0,
    dateBases: [sourceDateBasis(row)], sources: [`${row.tool || "미확인 도구"} · ${row.source || "수집 경로 미확인"} · 일자 기준: ${sourceDateBasis(row)}`],
    lastReceived: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, inProgress: row.date === today,
  };
}
export function mergeObservations(items: Observation[], expectedScopeComplete = false): Observation {
  if (!items.length) return emptyObservation();
  const values = items.flatMap((o) => o.value === null ? [] : [o.value]);
  const value = values.length ? values.reduce((a, b) => a + b, 0) : null;
  const complete = expectedScopeComplete && items.every((o) => o.complete);
  return { value, complete, status: value === null ? (items.every((o) => o.status === "unsupported") ? "unsupported" : "unknown") : complete && value === 0 ? "confirmed-zero" : "observed",
    hasRecord: items.some((o) => o.hasRecord), invalid: items.some((o) => o.invalid),
    unknownFields: [...new Set(items.flatMap((o) => o.unknownFields))], unsupportedFields: [...new Set(items.flatMap((o) => o.unsupportedFields))],
    unpricedTokens: items.reduce((sum, o) => sum + o.unpricedTokens, 0), dateBases: [...new Set(items.flatMap((o) => o.dateBases))],
    sources: [...new Set(items.flatMap((o) => o.sources))].sort(), lastReceived: items.flatMap((o) => o.lastReceived ? [o.lastReceived] : []).sort().at(-1) ?? null,
    inProgress: items.some((o) => o.inProgress),
  };
}
export function observationLabel(o: Observation): string {
  const status = o.status === "unsupported" ? "제공되지 않는 지표" : o.value === null ? "수집 미확인" : o.status === "confirmed-zero" ? "확인된 0" : o.complete ? "수집 합계" : "수집 합계 · 일부 수집";
  return `${status}${o.unpricedTokens > 0 ? " · 미환산 원본 있음" : ""}${o.invalid ? " · 잘못된 자료 있음" : ""}${o.inProgress ? " · 오늘 진행 중" : ""}`;
}
export function compareObservations(previous: Observation, current: Observation): { label: string; delta: number | null; percent: number | null } {
  if (!previous.complete || !current.complete || previous.value === null || current.value === null || previous.inProgress || current.inProgress || previous.unpricedTokens || current.unpricedTokens ||
    [...previous.sources].sort().join("|") !== [...current.sources].sort().join("|") || [...previous.dateBases].sort().join("|") !== [...current.dateBases].sort().join("|")) return { label: "비교 조건 확인 필요", delta: null, percent: null };
  const delta = current.value - previous.value;
  return { label: delta > 0 ? "증가" : delta < 0 ? "감소" : "변화 없음", delta, percent: previous.value === 0 ? null : delta / previous.value * 100 };
}
