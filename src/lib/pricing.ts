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
// Analysis) use to compare models. The absolute dollar value is never shown
// in any UI — only relative shares (team total = 100) — so rates only need
// to be roughly proportional, not billing-accurate.
//
// Unlike the headline token metric (input+output, src/lib/queries.ts),
// cache tokens ARE included here: cache reads/writes are billed compute
// (Anthropic: cache read = 0.1x base input, 5m cache write = 1.25x).
//
// Sources (as of 2026-07-18):
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://developers.openai.com/api/docs/pricing
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching

type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Official USD per 1M tokens (cacheWrite = 5-minute cache write rate).
// Edit here when models/prices change; the index is relative, so only the
// ratios between tiers matter.
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

export type RateFamily = keyof typeof RATES;

// Family detection by keyword, so vendor-specific decorations all match:
// "claude-opus-4-8-thinking-high", "claude-4.6-sonnet-medium-thinking",
// "gpt-5.3-codex-high-fast", "claude-haiku-4-5-20251001", ...
// Cursor's non-model rows ("default", "premium", "") fall through to the
// per-tool fallback tier.
export function rateFamily(model: string, tool: string): RateFamily {
  const m = model.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("composer")) return "composer";
  if (m.includes("codex")) return "gptCodex";
  if (m.includes("gpt-5.5") || m.includes("gpt-5.6")) return "gpt55";
  if (m.includes("gpt-4o")) return "gpt4o";
  if (m.includes("gpt-") || /^o\d/.test(m)) return "gpt5";
  return tool === "codex" ? "gpt5" : "sonnet";
}

export type WeightableRow = {
  model: string;
  tool: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
};

// Approximate USD for one usage row. Internal weighting only — never render
// this as money.
export function estimateWeight(row: WeightableRow): number {
  const r = RATES[rateFamily(row.model ?? "", row.tool ?? "")];
  return (
    ((row.inputTokens ?? 0) * r.input +
      (row.outputTokens ?? 0) * r.output +
      (row.cacheReadTokens ?? 0) * r.cacheRead +
      (row.cacheCreationTokens ?? 0) * r.cacheWrite) /
    1_000_000
  );
}

// Top-price families; feeds the /me "premium model share" coaching metric.
export function isPremiumModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("fable") || m.includes("mythos") || m.includes("opus");
}
