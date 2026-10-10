// Per person-day usage for the growth engine (src/lib/growth.ts).
//
// Two sources are combined so people who never use Claude Code still grow:
//   - usage_daily: every collected tool (uploader, pollers, manual entries)
//   - the Claude spend report, imported one day per snapshot (claude-spend-csv)
//
// Rules:
//   - Report products other than "Claude Code" are ADDED to the day.
//   - "Claude Code" exists on both sides (the uploader sees local sessions of
//     any account, the report sees the company organization incl. cloud runs),
//     so the day takes the LARGER of the two — for tokens and for requests
//     independently — never the sum.
//   - "tokens" are reference-model-equivalent tokens with cache reads excluded,
//     against ONE fixed reference family so a price-table default change cannot
//     move everyone's history. Unpriced rows add 0 tokens; requests still count.
//   - The report's UTC date is taken as the person's activity date as-is.
//   - Report rows that map to no member (service rows, unregistered people) are
//     ignored.
import { Types } from "mongoose";
import { connectDb, Member, MemberIdentity, UsageDaily } from "@/lib/db";
import { UsageReport } from "@/lib/db/usage-report";
import { addDays } from "@/lib/date";
import type { GrowthDay } from "@/lib/growth";
import { canonicalizeModel } from "@/lib/models";
import { loadPriceTable } from "@/lib/price-table";
import { CURSOR_PLACEHOLDER_MODELS, matchPrice, type PriceTable } from "@/lib/pricing";
import { convert } from "@/lib/units";

// The yardstick for the volume ladder. Fixed on purpose (see header).
export const GP_REF_FAMILY = "sonnet-5";
// A model family counts toward diversity when it holds at least this share of
// the day's ladder tokens — products call small helper models on their own.
export const GP_FAMILY_MIN_SHARE = 0.1;
export const CLAUDE_REPORT_SOURCE = "claude-spend-csv";
const CLAUDE_CODE_PRODUCT = "Claude Code";
const CLAUDE_CODE_TOOL = "claude_code";

export type GrowthDailyRow = {
  date: string;
  tool: string;
  model: string;
  source: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  requests?: number | null;
  sessions?: number | null;
  fieldEvidence?: Record<string, string> | null;
};
export type GrowthReportRow = {
  date: string; // the report's own (UTC) day
  product: string;
  model: string;
  metrics: Partial<Record<"prompt_tokens" | "completion_tokens" | "uncached_input_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reported_requests", number>>;
};

const NON_MODELS = new Set<string>([...CURSOR_PLACEHOLDER_MODELS, "composer", ""]);
const FAMILY_KEYWORDS: Array<[string, string]> = [
  ["opus", "opus"], ["sonnet", "sonnet"], ["haiku", "haiku"], ["fable", "fable"], ["mythos", "fable"],
  ["codex", "gpt"], ["gpt", "gpt"], ["gemini", "gemini"], ["grok", "grok"], ["deepseek", "deepseek"], ["qwen", "qwen"],
];

// A product line, not a version: opus-5 and opus-5.5 are both "opus". Returns
// null for rows without a real model name.
export function modelFamily(table: PriceTable, model: string, tool: string, date: string): string | null {
  const name = canonicalizeModel(model).toLowerCase().trim();
  if (NON_MODELS.has(name)) return null;
  for (const [keyword, family] of FAMILY_KEYWORDS) if (name.includes(keyword)) return family;
  const priced = matchPrice(table, name, tool, date)?.family.toLowerCase();
  if (priced && priced !== "cursor-default") return priced.startsWith("gpt") ? "gpt" : priced;
  return name.match(/[a-z]+/)?.[0] ?? name;
}

function positive(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Same exclusions as the activity calendar (activity-calendar-query.ts):
// unsupported fields are not measurements, Copilot poller quantities are
// billing units, and Cursor poller model rows repeat the activity row's
// requests.
function measured(row: GrowthDailyRow, field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "requests" | "sessions"): number {
  if (row.fieldEvidence?.[field] === "unsupported") return 0;
  if (row.source === "poller" && row.tool === "copilot") return 0;
  if (field === "requests" && row.source === "poller" && row.tool === "cursor" && (row.model ?? "") !== "") return 0;
  const value = positive(row[field]);
  return (field === "requests" || field === "sessions") && !Number.isInteger(value) ? 0 : value;
}

// "Claude in Chrome" → claude_in_chrome, "Cowork" → claude_cowork.
export function reportProductTool(product: string): string {
  if (product === CLAUDE_CODE_PRODUCT) return CLAUDE_CODE_TOOL;
  const slug = product.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^claude_/, "");
  return `claude_${slug || "other"}`;
}

type Part = { tokens: number; requests: number; active: boolean; families: Map<string, { tokens: number; requests: number }> };
const emptyPart = (): Part => ({ tokens: 0, requests: 0, active: false, families: new Map() });
function addTo(part: Part, tokens: number, requests: number, active: boolean, family: string | null) {
  part.tokens += tokens;
  part.requests += requests;
  part.active ||= active;
  if (family && (tokens > 0 || requests > 0)) {
    const f = part.families.get(family) ?? { tokens: 0, requests: 0 };
    f.tokens += tokens;
    f.requests += requests;
    part.families.set(family, f);
  }
}

// Pure combination of one member's rows into growth days (sorted by date).
export function combineGrowthDays(table: PriceTable, daily: GrowthDailyRow[], reports: GrowthReportRow[]): GrowthDay[] {
  type Day = { other: Part; codeLocal: Part; codeReport: Part; tools: Set<string> };
  const days = new Map<string, Day>();
  const dayOf = (date: string) => {
    let day = days.get(date);
    if (!day) days.set(date, (day = { other: emptyPart(), codeLocal: emptyPart(), codeReport: emptyPart(), tools: new Set() }));
    return day;
  };
  const ladder = (row: { model: string; tool: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }, date: string) =>
    convert(table, row, "ref", GP_REF_FAMILY, date, "no-cache-read").value;

  for (const row of daily) {
    const fields = {
      inputTokens: measured(row, "inputTokens"), outputTokens: measured(row, "outputTokens"),
      cacheReadTokens: measured(row, "cacheReadTokens"), cacheCreationTokens: measured(row, "cacheCreationTokens"),
    };
    const requests = measured(row, "requests");
    const active = requests > 0 || measured(row, "sessions") > 0 || Object.values(fields).some((v) => v > 0);
    if (!active) continue;
    const day = dayOf(row.date);
    day.tools.add(row.tool);
    const tokens = ladder({ model: row.model ?? "", tool: row.tool, ...fields }, row.date);
    addTo(row.tool === CLAUDE_CODE_TOOL ? day.codeLocal : day.other, tokens, requests, true, modelFamily(table, row.model ?? "", row.tool, row.date));
  }

  for (const row of reports) {
    const m = row.metrics;
    const hasBreakdown = m.uncached_input_tokens !== undefined || m.cache_read_tokens !== undefined || m.cache_write_tokens !== undefined;
    const fields = {
      inputTokens: positive(hasBreakdown ? m.uncached_input_tokens : m.prompt_tokens),
      outputTokens: positive(m.completion_tokens),
      cacheReadTokens: positive(m.cache_read_tokens),
      cacheCreationTokens: positive(m.cache_write_tokens),
    };
    const requests = positive(m.reported_requests);
    const active = requests > 0 || Object.values(fields).some((v) => v > 0);
    if (!active) continue;
    const tool = reportProductTool(row.product);
    const day = dayOf(row.date);
    day.tools.add(tool);
    const tokens = ladder({ model: row.model ?? "", tool, ...fields }, row.date);
    addTo(tool === CLAUDE_CODE_TOOL ? day.codeReport : day.other, tokens, requests, true, modelFamily(table, row.model ?? "", tool, row.date));
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => {
      const tokens = day.other.tokens + Math.max(day.codeLocal.tokens, day.codeReport.tokens);
      const requests = day.other.requests + Math.max(day.codeLocal.requests, day.codeReport.requests);
      // Claude Code families come from the side that supplied its tokens (or,
      // with no priced tokens on either side, its requests).
      const code = day.codeLocal.tokens !== day.codeReport.tokens
        ? (day.codeLocal.tokens > day.codeReport.tokens ? day.codeLocal : day.codeReport)
        : (day.codeLocal.requests >= day.codeReport.requests ? day.codeLocal : day.codeReport);
      const families = new Map<string, { tokens: number; requests: number }>();
      for (const part of [day.other, code]) {
        for (const [family, v] of part.families) {
          const f = families.get(family) ?? { tokens: 0, requests: 0 };
          f.tokens += v.tokens;
          f.requests += v.requests;
          families.set(family, f);
        }
      }
      const counted = [...families.entries()]
        // The epsilon keeps an exact 10% share from failing on float rounding.
        .filter(([, v]) => (tokens > 0 ? v.tokens > 0 && v.tokens + 1e-6 >= tokens * GP_FAMILY_MIN_SHARE : v.requests > 0))
        .map(([family]) => family)
        .sort();
      return { date, tools: [...day.tools].sort(), tokens, requests, families: counted };
    });
}

// Emails a member is known by: the account email plus any identity that is an
// email (e.g. an older address). Lowercased.
async function memberEmails(memberId: Types.ObjectId): Promise<string[]> {
  const [member, identities] = await Promise.all([
    Member.findById(memberId, { email: 1 }).lean(),
    MemberIdentity.find({ memberId }, { externalId: 1 }).lean(),
  ]);
  const emails = new Set<string>();
  for (const value of [member?.email, ...identities.map((i) => i.externalId)]) {
    const email = (value ?? "").trim().toLowerCase();
    if (email.includes("@")) emails.add(email);
  }
  return [...emails];
}

// One member's single-day Claude report rows since `since`. When the same day
// was imported more than once for an account (e.g. with another coverage
// label), only the most recently collected snapshot is used.
async function memberReportRows(emails: string[], since: string): Promise<GrowthReportRow[]> {
  if (emails.length === 0) return [];
  const snapshots = await UsageReport.find(
    { sourceId: CLAUDE_REPORT_SOURCE, periodStart: { $gte: since }, $expr: { $eq: ["$periodStart", "$periodEnd"] } },
    { accountId: 1, periodStart: 1, collectedAt: 1, rows: 1 },
  ).sort({ collectedAt: -1 }).lean();
  const wanted = new Set(emails);
  const seen = new Set<string>();
  const out: GrowthReportRow[] = [];
  for (const snapshot of snapshots) {
    const key = `${snapshot.accountId}|${snapshot.periodStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const row of snapshot.rows ?? []) {
      if (!wanted.has(String(row.externalId ?? "").trim().toLowerCase())) continue;
      out.push({ date: snapshot.periodStart, product: row.product, model: row.model ?? "", metrics: row.metrics ?? {} });
    }
  }
  return out;
}

// 멤버의 날짜별 성장 재료. since(포함) 이후 날짜만.
export async function loadGrowthDays(memberId: string, since: string): Promise<GrowthDay[]> {
  await connectDb();
  const id = new Types.ObjectId(memberId);
  const [table, daily, emails] = await Promise.all([
    loadPriceTable(),
    UsageDaily.find(
      { memberId: id, date: { $gte: since } },
      { date: 1, tool: 1, model: 1, source: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, requests: 1, sessions: 1, fieldEvidence: 1 },
    ).lean(),
    memberEmails(id),
  ]);
  const reports = await memberReportRows(emails, since);
  return combineGrowthDays(table, daily as unknown as GrowthDailyRow[], reports);
}

// Dates the daily report has not covered yet: every day after its latest
// stored day up to `today`. The report arrives a day late, so a missing record
// there is "not confirmed", not "absent". No report at all → nothing is
// unconfirmed (behaviour as before reports existed).
export function unconfirmedAfter(latestReportDate: string | null, today: string): Set<string> {
  const dates = new Set<string>();
  if (!latestReportDate) return dates;
  for (let d = addDays(latestReportDate, 1); d <= today; d = addDays(d, 1)) dates.add(d);
  return dates;
}

export async function loadUnconfirmedGrowthDates(today: string): Promise<Set<string>> {
  await connectDb();
  const latest = await UsageReport.findOne(
    { sourceId: CLAUDE_REPORT_SOURCE, $expr: { $eq: ["$periodStart", "$periodEnd"] } },
    { periodStart: 1 },
  ).sort({ periodStart: -1 }).lean();
  return unconfirmedAfter(latest?.periodStart ?? null, today);
}
