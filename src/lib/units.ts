// Display units for usage charts (spec §3.2). Pure — no DB.
//
//   raw  토큰               sum of the explicitly selected token kinds.
//   usd  API 정가 환산 $    Σ over the four kinds: tokens × list price / 1e6.
//                           Not spend — subscription use is priced at the
//                           model's public API price too.
//   ref  〈모델〉 환산 토큰  Σ over the four kinds: tokens × model price ÷ the
//                           reference model's price for the same kind.
//
// Only raw tokens are stored; conversions run at read time, so a price-table
// edit applies to history at once. 한도 % is deliberately not a unit here
// (it is an account metric on a different axis) — see the limits gauge.

import {
  matchPrice,
  type ModelPrice,
  type PriceTable,
  type Rates,
  type WeightableRow,
} from "@/lib/pricing";

export type Unit = "raw" | "usd" | "ref";
export type TokenBasis = "all" | "no-cache-read" | "output" | "legacy" | "requests";
export const BASES: readonly TokenBasis[] = ["all", "no-cache-read", "output", "legacy", "requests"];
export const BASIS_LABELS: Record<TokenBasis, string> = {
  all: "전체 처리량", "no-cache-read": "캐시 읽기 제외", output: "출력량", legacy: "기존 기준", requests: "요청 수",
};
export function parseBasis(v: string | null | undefined): TokenBasis {
  return v === "no-cache-read" || v === "output" || v === "legacy" || v === "requests" ? v : "all";
}
export function basisHint(basis: TokenBasis): string {
  return { all: "일반 입력 + 캐시 읽기 + 캐시 쓰기 + 출력",
    "no-cache-read": "일반 입력 + 캐시 쓰기 + 출력", output: "출력", legacy: "일반 입력 + 출력", requests: "수집된 요청 건수 합계" }[basis];
}
export const UNITS: readonly Unit[] = ["raw", "usd", "ref"];

export const REF_TOOLTIP = "토큰 종류별 단가 비율로 계산한 추정값이며 기준 모델에 따라 값이 달라집니다.";
export const USD_DISCLAIMER = "공개 단가 추정값 · 청구 금액·구독료가 아닙니다.";

export function unitLabel(unit: Unit, refFamily: string | null, basis: TokenBasis = "all"): string {
  if (basis === "requests") return "요청 수";
  if (unit === "usd") return "API 정가 환산 $";
  if (unit === "ref") return `${refFamily ?? "기준 모델"} 환산 토큰`;
  return "토큰";
}

// Card hint: how the value is formed.
export function unitHint(unit: Unit, basis: TokenBasis = "all"): string {
  if (basis === "requests") return basisHint(basis);
  const formula = basisHint(basis);
  if (unit === "usd") return `(${formula}) 종류별 × 공개 단가`;
  if (unit === "ref") return `(${formula}) 종류별 × 모델 단가 ÷ 기준 단가`;
  return formula;
}

// `n` is pre-formatted by the caller (numStyle-aware).
export function unpricedNote(n: string): string {
  return `미환산 원본 ${n}토큰 · 단가 미등록`;
}

export function parseUnit(v: string | undefined | null): Unit {
  return v === "usd" || v === "ref" ? v : "raw";
}

export type Kind = keyof Rates;
const KINDS: Kind[] = ["input", "output", "cacheRead", "cacheWrite"];

export const BASIS_KINDS: Record<TokenBasis, readonly Kind[]> = {
  all: ["input", "output", "cacheRead", "cacheWrite"],
  "no-cache-read": ["input", "output", "cacheWrite"],
  output: ["output"], legacy: ["input", "output"], requests: [],
};
function tokensOf(row: WeightableRow, basis: TokenBasis = "all"): Record<Kind, number> {
  const t = {
    input: row.inputTokens ?? 0,
    output: row.outputTokens ?? 0,
    cacheRead: row.cacheReadTokens ?? 0,
    cacheWrite: row.cacheCreationTokens ?? 0,
  };
  for (const k of KINDS) if (!BASIS_KINDS[basis].includes(k)) t[k] = 0;
  return t;
}
export function selectedTokens(row: WeightableRow, basis: TokenBasis = "all"): number {
  const t = tokensOf(row, basis);
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

// All four billable kinds — what "단가 미정 N토큰" counts (same as /pricing).
export function billableTokens(row: WeightableRow): number {
  const t = tokensOf(row);
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

// Every priced family, one per family, in match-priority order (a family's
// lowest priority across its versions/scopes). These are the ref dropdown.
export function pricedFamilies(table: PriceTable): string[] {
  const best = new Map<string, number>();
  for (const e of table.entries) {
    const p = best.get(e.family);
    if (p === undefined || e.priority < p) best.set(e.family, e.priority);
  }
  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([f]) => f);
}

// Default reference = the newest Sonnet line. Rule: among entries whose
// family starts with "sonnet", the lowest priority number (the most specific
// = newest version family, e.g. sonnet-5 at 25 before the sonnet 4.x catch-all
// at 30); tie → latest effectiveFrom. No sonnet family → the first priced
// family; empty table → null (ref unit unavailable). Note: a version family
// registered later on /pricing gets priority 500–600, so it becomes the
// default only if it is the sole sonnet family — pass ?ref= to pick it.
export function defaultRefFamily(table: PriceTable): string | null {
  let best: ModelPrice | null = null;
  for (const e of table.entries) {
    if (!e.family.startsWith("sonnet")) continue;
    if (
      !best ||
      e.priority < best.priority ||
      (e.priority === best.priority && e.effectiveFrom > best.effectiveFrom)
    ) {
      best = e;
    }
  }
  return best?.family ?? pricedFamilies(table)[0] ?? null;
}

// The reference family's prices on `date`: its latest version with
// effectiveFrom <= date (tie → lowest priority, i.e. the all-provider scope
// before a provider catch-all). If the family has no version in effect yet,
// its earliest version — the reference is a yardstick and must not vanish
// for older dates. Unknown family → null.
export function refRates(table: PriceTable, family: string, date: string): Rates | null {
  const own = table.entries.filter((e) => e.family === family);
  if (!own.length) return null;
  const effective = own.filter((e) => e.effectiveFrom <= date);
  const pool = effective.length ? effective : own;
  const pickLatest = effective.length > 0;
  let best = pool[0];
  for (const e of pool) {
    const newer = pickLatest ? e.effectiveFrom > best.effectiveFrom : e.effectiveFrom < best.effectiveFrom;
    if (newer || (e.effectiveFrom === best.effectiveFrom && e.priority < best.priority)) best = e;
  }
  return { input: best.input, output: best.output, cacheRead: best.cacheRead, cacheWrite: best.cacheWrite };
}

// One row in the chosen unit, priced on `date`.
// - raw: selected kinds; never unpriced.
// - unpriced (row has tokens, no price matched): value 0, unpriced true.
// - ref, a kind whose reference price is 0 (e.g. gpt cacheWrite): converted
//   through dollars instead — usd_k / ref.input — so those tokens are neither
//   dropped nor added raw. If ref.input is 0 too, the first positive ref price
//   is used; a reference with all prices 0 cannot convert → unpriced.
export function convert(
  table: PriceTable,
  row: WeightableRow & { requests?: number | null },
  unit: Unit,
  refFamily: string | null,
  date: string,
  basis: TokenBasis = "all",
): { value: number; unpriced: boolean } {
  if (basis === "requests") return { value: row.requests ?? 0, unpriced: false };
  const t = tokensOf(row, basis);
  if (unit === "raw") return { value: selectedTokens(row, basis), unpriced: false };

  const total = t.input + t.output + t.cacheRead + t.cacheWrite;
  if (total === 0) return { value: 0, unpriced: false };
  const hit = matchPrice(table, row.model ?? "", row.tool ?? "", date);
  if (!hit) return { value: 0, unpriced: true };

  if (unit === "usd") {
    let usd = 0;
    for (const k of KINDS) usd += (t[k] * hit[k]) / 1_000_000;
    return { value: usd, unpriced: false };
  }

  const ref = refFamily ? refRates(table, refFamily, date) : null;
  const fallback = ref ? KINDS.map((k) => ref[k]).find((p) => p > 0) : undefined;
  if (!ref || fallback === undefined) return { value: 0, unpriced: true };
  let value = 0;
  for (const k of KINDS) {
    const denom = ref[k] > 0 ? ref[k] : ref.input > 0 ? ref.input : fallback;
    value += (t[k] * hit[k]) / denom;
  }
  return { value, unpriced: false };
}

// Sums rows per key (e.g. date, or date|tool) in the chosen unit; each row is
// priced on its own date. unpricedTokens = billable tokens that could not be
// converted in the range (always 0 for raw).
export function sumConverted<R extends WeightableRow & { date: string }>(
  table: PriceTable,
  rows: R[],
  unit: Unit,
  refFamily: string | null,
  key: (row: R) => string,
  basis: TokenBasis = "all",
): { totals: Map<string, number>; unpricedTokens: number } {
  const totals = new Map<string, number>();
  let unpricedTokens = 0;
  for (const r of rows) {
    const c = convert(table, r, unit, refFamily, r.date, basis);
    const k = key(r);
    totals.set(k, (totals.get(k) ?? 0) + c.value);
    if (c.unpriced) unpricedTokens += selectedTokens(r, basis);
  }
  return { totals, unpricedTokens };
}

export type UnitSelection = { unit: Unit; ref: string | null; basis: TokenBasis; families: string[] };
export type UsageSelection = Pick<UnitSelection, "unit" | "ref" | "basis">;
export type SelectionParams = { unit?: string | null; ref?: string | null; basis?: string | null };

// URL params (?unit=raw|usd|ref&ref=<family>) → a valid selection. An unknown
// ?ref falls back to the default; with no priced family at all, ref → raw.
export function resolveUnitSelection(
  table: PriceTable,
  params: SelectionParams,
): UnitSelection {
  const families = pricedFamilies(table);
  const ref = params.ref && families.includes(params.ref) ? params.ref : defaultRefFamily(table);
  let unit = parseUnit(params.unit);
  const basis = parseBasis(params.basis);
  if (basis === "requests" || (unit === "ref" && !ref)) unit = "raw";
  return { unit, ref, basis, families };
}
