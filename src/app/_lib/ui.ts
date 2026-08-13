// Shared presentation helpers used by both server pages and client charts.

import { addDays, todayKst } from "@/lib/date";

const TOOL_LABELS: Record<string, string> = {
  cursor: "Cursor",
  claude_code: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  anthropic: "Anthropic",
  gemini: "Gemini",
  grok: "Grok",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

// Tools that report request counts but no token totals. Surfaced in the UI so
// "0 tokens" is never read as "no usage".
export const REQUESTS_ONLY_TOOLS = new Set(["copilot"]);

// Deterministic tool -> categorical slot (1..8). Fixed for the known tools so a
// tool keeps its color regardless of which others are present; unknown tools
// hash into a slot. Color follows the entity, never its rank.
const KNOWN_SLOTS: Record<string, number> = {
  cursor: 1,
  claude_code: 2,
  codex: 7,
  copilot: 4,
  anthropic: 5,
  gemini: 6,
  grok: 3,
};

export function toolSlot(tool: string): number {
  if (tool in KNOWN_SLOTS) return KNOWN_SLOTS[tool];
  let h = 0;
  for (let i = 0; i < tool.length; i++) h = (h * 31 + tool.charCodeAt(i)) >>> 0;
  return (h % 8) + 1;
}

export function toolColor(tool: string): string {
  return `var(--series-${toolSlot(tool)})`;
}

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// Compact-number style: Korean 만/억/조 units (default) or Western K/M/B.
// Chosen per viewer via the tm_numfmt cookie — read server-side by
// getNumStyle() (src/app/_lib/numfmt.ts) and client-side via useNumStyle()
// (src/app/_components/NumStyleProvider.tsx).
export type NumStyle = "kr" | "west";

export const NUM_STYLE_COOKIE = "tm_numfmt";

export function parseNumStyle(value: string | undefined | null): NumStyle {
  return value === "west" ? "west" : "kr";
}

// Compact for large standalone figures.
//   kr:   1,284 / 1.3만 / 5,487만 / 21.7억
//   west: 1,284 / 12.9K / 54.9M  / 2.2B
export function formatCompact(n: number, style: NumStyle = "kr"): string {
  const abs = Math.abs(n);
  if (style === "west") {
    if (abs < 1000) return String(Math.round(n));
    if (abs < 1_000_000) return `${trim(n / 1000)}K`;
    if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
    return `${trim(n / 1_000_000_000)}B`;
  }
  if (abs < 10_000) return formatNumber(n);
  if (abs < 100_000_000) return `${trimKr(n / 10_000)}만`;
  if (abs < 1_000_000_000_000) return `${trimKr(n / 100_000_000)}억`;
  return `${trimKr(n / 1_000_000_000_000)}조`;
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

// Korean unit values span 1–9999; keep one decimal while short, comma-group
// once whole digits carry enough precision.
function trimKr(n: number): string {
  return Math.abs(n) < 100 ? trim(n) : formatNumber(n);
}

// ---- date ranges ------------------------------------------------------------

export const RANGE_PRESETS = [
  { days: 7, label: "최근 7일" },
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 90일" },
] as const;

// Range is inclusive [from, to] in KST — "오늘"(to) must match the team's wall
// clock, and `from` is (days-1) KST-days earlier. addDays shifts a YYYY-MM-DD
// string by whole days (timezone-neutral), so no re-derivation of the instant.
export function rangeForDays(days: number): { from: string; to: string } {
  const to = todayKst();
  const from = addDays(to, -(days - 1));
  return { from, to };
}

export function parseDays(value: string | undefined, fallback = 30): number {
  const n = Number(value);
  return RANGE_PRESETS.some((p) => p.days === n) ? n : fallback;
}

// "2026-07-17T10:22:00" -> friendly label in KST. Best-effort only. The
// explicit timeZone matters: this renders server-side and the container runs
// UTC, so the default zone would show times 9 hours early.
export function formatTimestamp(ts: string | null): string {
  if (!ts) return "동기화 기록 없음";
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
