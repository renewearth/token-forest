// Cost-weighted usage index ("보정 지수").
//
// Raw token counts from different vendors aren't directly comparable —
// tokenizers differ (Anthropic's own pricing docs note that the newer
// tokenizer used by Opus 4.7+/Fable 5/Sonnet 5 produces ~30% more tokens for
// the same text; across vendors and languages the gap can reach an order of
// magnitude, Petrov et al. NeurIPS 2023, arXiv:2305.15425), and agentic
// tools burn orders of magnitude more tokens per unit of human effort than
// autocomplete. The only common denominator is price: weighting each row by
// its model's official list price (USD per 1M tokens) absorbs both
// differences — the same normalization industry benchmarks (e.g. Artificial
// Analysis) use to compare models.
//
// Showing dollars: this used to say the absolute dollar value is never shown
// in any UI (only relative shares, team total = 100). The product owner
// reversed that (2026-09-29 decision; collection v2, spec §3.2): usage charts
// may now show the "API 정가 환산 $" unit (src/lib/units.ts) — Σ tokens ×
// public list price, subscription use included at the model's API price. It is a yardstick of
// usage size, not spend, so it is always labelled "실제 지출 아님 — 공개 단가
// 환산". That puts the table's prices on screen: they must be the actual
// published list prices with a source (modelprices.sourceUrl), and unknown
// models stay 단가 미정 (never guessed). Relative shares (/team) still rely
// only on the ratios.
//
// Unlike the headline token metric (input+output, src/lib/queries.ts),
// cache tokens ARE included here: cache reads/writes are billed compute
// (Anthropic: cache read = 0.1x base input, 5m cache write = 1.25x).
//
// Sources (as of 2026-07-18):
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://developers.openai.com/api/docs/pricing
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching

import { todayKst } from "@/lib/date";

export type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Official USD per 1M tokens (cacheWrite = 5-minute cache write rate), as of
// 2026-07-18. Per-version Claude prices checked 2026-09-30 are in
// VERSION_RATES below; the GPT rows here were not re-verified then.
// Since 2026-09-30 the live prices are the `modelprices`
// collection (src/lib/price-table.ts, edited on /pricing); this constant is
// only the SEED that collection starts from — changing it here does not
// change a deployed table.
export const RATES = {
  fable: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  gpt55: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  gptCodex: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  gpt4o: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  // Older/unlisted GPT-5.x tiers (e.g. gpt-5.2) at their launch pricing.
  gpt5: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  // Cursor's in-house model; no public per-token price — assumed Sonnet-tier.
  composer: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} satisfies Record<string, Rates>;

// ---- price table ------------------------------------------------------------

// One price version of one model family. Matching (see matchPrice):
// - match: lowercase patterns tested against the lowercased model name.
//     "abc"    substring            (the common case)
//     "=abc"   whole name equals    ("=" alone = the empty model "")
//     "/re/"   regular expression
//   Empty → the family name itself as a substring.
// - provider: "" = every provider; otherwise the entry applies only to rows
//   whose provider equals it. Usage rows carry no provider of their own, so
//   the row's tool stands in unless the caller passes one explicitly.
// - priority: ascending match order across families (first match wins); the
//   seed keeps the order the old keyword rules were checked in. Versions of one
//   family share its priority; among them the latest effectiveFrom <= date wins.
export type ModelPrice = Rates & {
  family: string;
  match: string[];
  provider: string;
  priority: number;
  effectiveFrom: string; // YYYY-MM-DD, inclusive
  sourceUrl: string; // required — where the price was read
  checkedAt: string; // YYYY-MM-DD the source was last checked
  note: string;
  registeredBy: string; // member email, or "seed"
};

export type PriceTable = { entries: ModelPrice[] };

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";

// The old constants applied to every date, so the seed is effective from long
// before any usage row — a table migration must not turn history unpriced.
const SEED_EFFECTIVE_FROM = "2000-01-01";
const SEED_CHECKED_AT = "2026-07-18";
const SEED_NOTE = "2026-07-18 코드 상수 이관";
const ASSUMED_SONNET_NOTE = "공개 단가 없음 — Sonnet 급 가정(기존 정책)";
const VERSION_NOTE = "버전별 단가(2026-09-30 확인)";

// Current Claude versions whose list price differs from their family entry
// (RATES = older versions: opus 4.x/5, sonnet 4.x, fable 5). Checked
// 2026-09-30 against ANTHROPIC_PRICING; cacheWrite = 5-minute write =
// 1.25 × input (platform.claude.com/docs/en/build-with-claude/prompt-caching).
// OpenAI/GPT seed prices (gptCodex, gpt55, gpt4o, gpt5) were NOT re-verified
// on 2026-09-30 — they are still the 2026-07-18 constants above.
const VERSION_RATES = {
  "fable-5.1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
} satisfies Record<string, Rates>;

// A version entry: its own family name (so /pricing versions of it inherit
// per version, R10) and a priority just below its family's, so it matches
// before the family catch-all.
function seedVersion(family: keyof typeof VERSION_RATES, priority: number, match: string[]): ModelPrice {
  return {
    family,
    match,
    provider: "",
    priority,
    effectiveFrom: SEED_EFFECTIVE_FROM,
    ...VERSION_RATES[family],
    sourceUrl: ANTHROPIC_PRICING,
    checkedAt: "2026-09-30",
    note: VERSION_NOTE,
    registeredBy: "seed",
  };
}

// Cursor's mode/tier placeholders — not model names. Single source of truth
// for the cursor-default seed entry below and queries.ts NON_MODEL_NAMES.
export const CURSOR_PLACEHOLDER_MODELS = ["default", "premium", "auto", "unknown"] as const;

// Literal length of a user pattern ("=abc" → 3, "abc" → 3).
function literalLength(p: string): number {
  return p.startsWith("=") ? p.length - 1 : p.length;
}

// Priority for a family registered on /pricing (not seeded): 600 − its longest
// literal pattern (capped at 100) → 500..600. More specific patterns match
// first; all user families sit after the seeded keyword families (10–90) and
// before the provider-scoped catch-alls (900 codex, 910 cursor-default).
export function newFamilyPriority(patterns: string[]): number {
  const longest = patterns.reduce((m, p) => Math.max(m, literalLength(p)), 0);
  return 600 - Math.min(longest, 100);
}

function seed(
  family: keyof typeof RATES,
  priority: number,
  match: string[],
  sourceUrl: string,
  extra: { provider?: string; family?: string; note?: string } = {},
): ModelPrice {
  return {
    family: extra.family ?? family,
    match,
    provider: extra.provider ?? "",
    priority,
    effectiveFrom: SEED_EFFECTIVE_FROM,
    ...RATES[family],
    sourceUrl,
    checkedAt: SEED_CHECKED_AT,
    note: extra.note ?? SEED_NOTE,
    registeredBy: "seed",
  };
}

// The former rateFamily() keyword chain, one entry per rule, in its order,
// with version entries (priority family − 5) just before their family.
// Anything none of these match used to fall back to a per-tool tier; now it is
// unpriced ("단가 미정") except the two cases kept below on purpose.
// "sonnet-5" is a substring of claude-sonnet-5 / -5-5 / -5.5 but not of
// sonnet 4.x names (claude-sonnet-4-5, claude-4.6-sonnet-…).
export const SEED_PRICES: ModelPrice[] = [
  seedVersion("fable-5.1", 5, ["fable-5-1", "fable-5.1"]),
  seed("fable", 10, ["fable", "mythos"], ANTHROPIC_PRICING),
  seedVersion("opus-5.5", 15, ["opus-5-5", "opus-5.5"]),
  seed("opus", 20, ["opus"], ANTHROPIC_PRICING),
  seedVersion("sonnet-5", 25, ["sonnet-5", "sonnet-5."]),
  seed("sonnet", 30, ["sonnet"], ANTHROPIC_PRICING),
  seed("haiku", 40, ["haiku"], ANTHROPIC_PRICING),
  seed("composer", 50, ["composer"], ANTHROPIC_PRICING, { note: ASSUMED_SONNET_NOTE }),
  seed("gptCodex", 60, ["codex"], OPENAI_PRICING),
  seed("gpt55", 70, ["gpt-5.5", "gpt-5.6"], OPENAI_PRICING),
  seed("gpt4o", 80, ["gpt-4o"], OPENAI_PRICING),
  seed("gpt5", 90, ["gpt-", "/^o\\d/"], OPENAI_PRICING),
  // Codex CLI rows whose model has no keyword (incl. "" when the log has no
  // turn_context model) were priced as gpt5 — kept so codex numbers don't move.
  seed("gpt5", 900, ["/.*/"], OPENAI_PRICING, {
    provider: "codex",
    note: `${SEED_NOTE} — codex 도구의 키워드 없는 모델은 기존대로 gpt5 단가`,
  }),
  // Cursor's non-model rows ("" activity rows + mode/tier placeholders).
  seed("sonnet", 910, ["=", ...CURSOR_PLACEHOLDER_MODELS.map((n) => `=${n}`)], ANTHROPIC_PRICING, {
    provider: "cursor",
    family: "cursor-default",
    note: ASSUMED_SONNET_NOTE,
  }),
];

export const SEED_TABLE: PriceTable = { entries: SEED_PRICES };

function patternMatches(pattern: string, m: string): boolean {
  if (pattern.startsWith("=")) return m === pattern.slice(1);
  if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(m);
    } catch {
      return false; // registerPrice rejects bad regexes; never throw at read time
    }
  }
  return m.includes(pattern);
}

export function entryMatches(entry: ModelPrice, model: string): boolean {
  const m = (model ?? "").toLowerCase();
  const patterns = entry.match.length ? entry.match : [entry.family.toLowerCase()];
  return patterns.some((p) => patternMatches(p, m));
}

// The price entry that applies to (model, tool) on `date`, or null = 단가 미정.
export function matchPrice(
  table: PriceTable,
  model: string,
  tool: string,
  date: string,
  provider?: string,
): ModelPrice | null {
  const scope = provider ?? tool ?? "";
  let best: ModelPrice | null = null;
  for (const e of table.entries) {
    if (e.effectiveFrom > date) continue;
    if (e.provider !== "" && e.provider !== scope) continue;
    if (!entryMatches(e, model)) continue;
    if (
      !best ||
      e.priority < best.priority ||
      (e.priority === best.priority && e.effectiveFrom > best.effectiveFrom)
    ) {
      best = e;
    }
  }
  return best;
}

export function priceFor(
  table: PriceTable,
  model: string,
  tool: string,
  date: string,
  provider?: string,
): Rates | null {
  const e = matchPrice(table, model, tool, date, provider);
  return e
    ? { input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite }
    : null;
}

export type WeightableRow = {
  model: string;
  tool: string;
  // YYYY-MM-DD the tokens were used; picks the price version. Omitted →
  // today (KST, the team's day boundary), i.e. the current price.
  date?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
};

// Approximate USD for one usage row. unpriced = the row has tokens but no
// price matched — it contributes 0 and callers can say "일부 미환산".
// A row without tokens is never unpriced (there is nothing to price).
export function estimateWeightWith(
  table: PriceTable,
  row: WeightableRow,
): { usd: number; unpriced: boolean } {
  const input = row.inputTokens ?? 0;
  const output = row.outputTokens ?? 0;
  const cacheRead = row.cacheReadTokens ?? 0;
  const cacheWrite = row.cacheCreationTokens ?? 0;
  const date = row.date ?? todayKst();
  const r = priceFor(table, row.model ?? "", row.tool ?? "", date);
  if (!r) return { usd: 0, unpriced: input + output + cacheRead + cacheWrite > 0 };
  return {
    usd:
      (input * r.input + output * r.output + cacheRead * r.cacheRead + cacheWrite * r.cacheWrite) /
      1_000_000,
    unpriced: false,
  };
}

// Synchronous, seed-table estimate for callers that can't await the DB table.
// Internal weighting only — seed prices, no DB table, so don't render this as
// money; the $ chart unit uses the live table via src/lib/units.ts. Unpriced → 0.
export function estimateWeight(row: WeightableRow): number {
  return estimateWeightWith(SEED_TABLE, row).usd;
}

// Top-price families; feeds the /me "premium model share" coaching metric.
export function isPremiumModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("fable") || m.includes("mythos") || m.includes("opus");
}
