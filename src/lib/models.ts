// Canonical model catalog + label normalization.
//
// Single source of truth for model IDENTITY. Metrics that count distinct
// models — model diversity (usage-weighted entropy) and premium share — split
// one real model into two whenever the same model reaches the DB under two
// labels. That happened with a manual entry: Claude's usage UI shows bare
// names ("opus-5", "sonnet-5", "haiku-4-5"), a member hand-copied them, and
// they diverged from the uploader's full ids ("claude-opus-5", ...).
//
// Two layers use this file:
//   1. canonicalizeModel() runs inside the ingest upsert, so EVERY path
//      (manual form, CSV import, ingest API, uploader) is corrected — even
//      rows that never touch the UI.
//   2. MODEL_CATALOG feeds the manual form's model dropdown, so the common
//      case never produces a variant label in the first place.

// Canonical model ids per tool. Keys double as the standard tool list for the
// manual form's tool dropdown. Add new models here as they ship; the list is
// intentionally curated, not derived from the DB (which carries historical
// noise). Tools with no per-model breakdown (cursor, copilot) keep an empty
// list — the form still offers the free-text escape hatch.
export const MODEL_CATALOG = {
  claude_code: [
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-haiku-4-5-20251001",
  ],
  codex: [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4-mini",
    "codex-auto-review",
  ],
  gemini: ["gemini-3.5-flash", "gemini-3.5-pro"],
  grok: ["grok-4.6", "grok-4-fast-non-reasoning"],
  cursor: [],
  copilot: [],
} as const satisfies Record<string, readonly string[]>;

export type CatalogTool = keyof typeof MODEL_CATALOG;

// The standard tools, in catalog order — used to seed the tool dropdown.
export const CATALOG_TOOLS = Object.keys(MODEL_CATALOG) as CatalogTool[];

// Alias (lowercased raw label) -> canonical id. Kept tool-agnostic because the
// bare Claude labels are unambiguous. Extend when a new variant appears.
const ALIASES: Record<string, string> = {
  "opus-5": "claude-opus-5",
  "opus-4-8": "claude-opus-4-8",
  "sonnet-5": "claude-sonnet-5",
  "fable-5": "claude-fable-5",
  "haiku-4-5": "claude-haiku-4-5-20251001",
  "haiku-4-5-20251001": "claude-haiku-4-5-20251001",
};

// Normalize a raw model label to its canonical id. Empty/absent stays "" (the
// "no model breakdown" sentinel). Unknown labels pass through unchanged so new
// models are never silently dropped — they just aren't de-aliased until added.
export function canonicalizeModel(raw: string | null | undefined): string {
  const m = (raw ?? "").trim();
  if (m === "") return "";
  return ALIASES[m.toLowerCase()] ?? m;
}

// Models offered in the dropdown for a given tool ("" for unknown tools).
export function modelsForTool(tool: string): readonly string[] {
  return (MODEL_CATALOG as Record<string, readonly string[]>)[tool] ?? [];
}
