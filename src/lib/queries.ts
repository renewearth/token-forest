import { Types } from "mongoose";
import {
  connectDb,
  Digest,
  LimitSnapshot as LimitSnapshotModel,
  Member,
  SyncRun,
  UsageDaily,
  UsageHourly,
  VISIBLE_MEMBER,
} from "@/lib/db";
import { canClaim } from "@/lib/claim";
import { isoDaysAgo } from "@/lib/date";
import { RATES, estimateWeight, isPremiumModel, rateFamily } from "@/lib/pricing";
import type { GrowthDay } from "@/lib/growth";
import { EMPTY_SUMS, addSums } from "@/lib/scorecard";
import type { ScoreSums } from "@/lib/scorecard";

// Headline tokens per row = input + output. Cache tokens are excluded — they
// dwarf real usage by orders of magnitude and would drown the adoption signal;
// the same definition is used by the Slack weekly report (src/lib/slack.ts).
// Tools that report no tokens (e.g. Copilot) contribute 0 here; their activity
// shows up in `requests` instead.
export const TOKENS_EXPR = {
  $add: [{ $ifNull: ["$inputTokens", 0] }, { $ifNull: ["$outputTokens", 0] }],
};

// Active-user identity: linked member if mapped, else the raw external id.
// Prefixes prevent an ObjectId-shaped external_id from colliding with a
// member id. Must match the Slack report's definition (src/lib/slack.ts).
export const ACTIVE_USER_EXPR = {
  $cond: [
    { $eq: [{ $ifNull: ["$memberId", null] }, null] },
    { $concat: ["x", "$externalId"] },
    { $concat: ["m", { $toString: "$memberId" }] },
  ],
};

const REQUESTS_EXPR = { $ifNull: ["$requests", 0] };

export type DateRange = { from: string; to: string };

function inRange({ from, to }: DateRange) {
  return { date: { $gte: from, $lte: to } };
}

// ---- Overview ---------------------------------------------------------------

export type PeriodTotals = {
  totalTokens: number;
  totalInput: number;
  totalOutput: number;
  totalRequests: number;
  activeMembers: number;
  toolCount: number;
};

export async function getPeriodTotals(range: DateRange): Promise<PeriodTotals> {
  await connectDb();
  const [row] = await UsageDaily.aggregate([
    { $match: inRange(range) },
    {
      $group: {
        _id: null,
        totalTokens: { $sum: TOKENS_EXPR },
        totalInput: { $sum: { $ifNull: ["$inputTokens", 0] } },
        totalOutput: { $sum: { $ifNull: ["$outputTokens", 0] } },
        totalRequests: { $sum: REQUESTS_EXPR },
        users: { $addToSet: ACTIVE_USER_EXPR },
        tools: { $addToSet: "$tool" },
      },
    },
  ]);
  return {
    totalTokens: row?.totalTokens ?? 0,
    totalInput: row?.totalInput ?? 0,
    totalOutput: row?.totalOutput ?? 0,
    totalRequests: row?.totalRequests ?? 0,
    activeMembers: row?.users?.length ?? 0,
    toolCount: row?.tools?.length ?? 0,
  };
}

export type ToolSummary = {
  tool: string;
  tokens: number;
  requests: number;
  activeMembers: number;
};

export async function getToolSummary(range: DateRange): Promise<ToolSummary[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: inRange(range) },
    {
      $group: {
        _id: "$tool",
        tokens: { $sum: TOKENS_EXPR },
        requests: { $sum: REQUESTS_EXPR },
        users: { $addToSet: ACTIVE_USER_EXPR },
      },
    },
    { $sort: { tokens: -1, requests: -1 } },
  ]);
  return rows.map((r) => ({
    tool: r._id as string,
    tokens: r.tokens,
    requests: r.requests,
    activeMembers: r.users.length,
  }));
}

// Wide-format daily series for a stacked chart: one row per date, one numeric
// column per tool. Pivoted here so the client component stays presentational.
export type DailySeries = {
  data: Array<Record<string, string | number>>;
  tools: string[];
};

export async function getDailyTokensByTool(
  range: DateRange,
): Promise<DailySeries> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: inRange(range) },
    {
      $group: {
        _id: { date: "$date", tool: "$tool" },
        tokens: { $sum: TOKENS_EXPR },
      },
    },
    { $sort: { "_id.date": 1 } },
  ]);
  return pivot(
    rows.map((r) => ({ date: r._id.date, tool: r._id.tool, tokens: r.tokens })),
    "tokens",
  );
}

export async function getDailyRequests(
  range: DateRange,
): Promise<Array<{ date: string; requests: number }>> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: inRange(range) },
    { $group: { _id: "$date", requests: { $sum: REQUESTS_EXPR } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ date: r._id as string, requests: r.requests }));
}

// Monday (YYYY-MM-DD) of the ISO week containing the given date — computed in
// JS so we don't depend on Mongo $dateTrunc; stable across year boundaries.
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

// Per-tool weekly active users — adoption. Daily distinct-user sets come from
// Mongo; weekly bucketing happens here (the data is tiny).
export async function getWeeklyActiveByTool(
  range: DateRange,
): Promise<DailySeries> {
  await connectDb();
  const rows: Array<{ _id: { date: string; tool: string }; users: string[] }> =
    await UsageDaily.aggregate([
      { $match: inRange(range) },
      {
        $group: {
          _id: { date: "$date", tool: "$tool" },
          users: { $addToSet: ACTIVE_USER_EXPR },
        },
      },
    ]);
  const weekly = new Map<string, Set<string>>(); // `${week}|${tool}`
  for (const r of rows) {
    const key = `${mondayOf(r._id.date)}|${r._id.tool}`;
    let set = weekly.get(key);
    if (!set) weekly.set(key, (set = new Set()));
    for (const u of r.users) set.add(u);
  }
  const flat = [...weekly.entries()]
    .map(([key, users]) => {
      const [week, tool] = key.split("|");
      return { date: week, tool, members: users.size };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return pivot(flat, "members");
}

export type SyncFreshness = {
  tool: string;
  lastSyncedDate: string | null;
  status: string;
  ranAt: string;
  message: string | null;
};

// Latest sync_run per tool.
export async function getSyncFreshness(): Promise<SyncFreshness[]> {
  await connectDb();
  const rows = await SyncRun.aggregate([
    { $sort: { _id: -1 } },
    {
      $group: {
        _id: "$tool",
        lastSyncedDate: { $first: "$lastSyncedDate" },
        status: { $first: "$status" },
        ranAt: { $first: "$ranAt" },
        message: { $first: "$message" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({
    tool: r._id as string,
    lastSyncedDate: r.lastSyncedDate ?? null,
    status: r.status,
    ranAt: r.ranAt instanceof Date ? r.ranAt.toISOString() : String(r.ranAt),
    message: r.message ?? null,
  }));
}

// ---- Members ----------------------------------------------------------------

export type MemberListRow = {
  id: string;
  name: string;
  email: string;
  tokens: number;
  requests: number;
  tools: string[];
  lastActive: string | null;
};

export async function getMemberList(): Promise<MemberListRow[]> {
  await connectDb();
  const [membersList, usage] = await Promise.all([
    Member.find(VISIBLE_MEMBER).sort({ name: 1 }).lean(),
    UsageDaily.aggregate([
      { $match: { memberId: { $ne: null } } },
      {
        $group: {
          _id: "$memberId",
          tokens: { $sum: TOKENS_EXPR },
          requests: { $sum: REQUESTS_EXPR },
          tools: { $addToSet: "$tool" },
          lastActive: { $max: "$date" },
        },
      },
    ]),
  ]);
  const byMember = new Map(usage.map((u) => [String(u._id), u]));
  return membersList
    .map((m) => {
      const u = byMember.get(String(m._id));
      return {
        id: String(m._id),
        name: m.name,
        email: m.email,
        tokens: u?.tokens ?? 0,
        requests: u?.requests ?? 0,
        tools: (u?.tools ?? []).sort(),
        lastActive: u?.lastActive ?? null,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

// Usage rows that never linked to a member — a missing identity mapping the
// admin should notice and fix.
export type UnmappedRow = {
  tool: string;
  externalId: string;
  tokens: number;
  requests: number;
  lastDate: string;
  claimable: boolean;
};

export async function getUnmappedExternalIds(
  viewerEmail: string,
): Promise<UnmappedRow[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { memberId: null } },
    {
      $group: {
        _id: { tool: "$tool", externalId: "$externalId" },
        tokens: { $sum: TOKENS_EXPR },
        requests: { $sum: REQUESTS_EXPR },
        lastDate: { $max: "$date" },
      },
    },
    { $sort: { lastDate: -1 } },
  ]);
  return rows.map((r) => ({
    tool: r._id.tool,
    externalId: r._id.externalId,
    tokens: r.tokens,
    requests: r.requests,
    lastDate: r.lastDate,
    claimable: canClaim(r._id.externalId, viewerEmail),
  }));
}

// ---- Member detail ----------------------------------------------------------

export type MemberInfo = { id: string; name: string; email: string };
// Alias kept for UI components that predate the Mongo migration.
export type Member = MemberInfo;

export async function getMember(id: string): Promise<MemberInfo | undefined> {
  await connectDb();
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return undefined;
  const m = await Member.findById(id).lean();
  return m ? { id: String(m._id), name: m.name, email: m.email } : undefined;
}

// All members for the manual-entry select (no aggregates).
export async function getAllMembers(): Promise<MemberInfo[]> {
  await connectDb();
  const rows = await Member.find(VISIBLE_MEMBER).sort({ name: 1 }).lean();
  return rows.map((m) => ({ id: String(m._id), name: m.name, email: m.email }));
}

// Distinct tool names seen so far, for the free-text datalist.
export async function getKnownTools(): Promise<string[]> {
  await connectDb();
  const tools = await UsageDaily.distinct("tool");
  return tools.sort();
}

export type MemberBreakdownRow = {
  tool: string;
  model: string;
  tokens: number;
  input: number;
  output: number;
  requests: number;
};

export async function getMemberBreakdown(
  id: string,
  range: DateRange,
): Promise<MemberBreakdownRow[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { memberId: oid(id), ...inRange(range) } },
    {
      $group: {
        _id: { tool: "$tool", model: "$model" },
        tokens: { $sum: TOKENS_EXPR },
        input: { $sum: { $ifNull: ["$inputTokens", 0] } },
        output: { $sum: { $ifNull: ["$outputTokens", 0] } },
        requests: { $sum: REQUESTS_EXPR },
      },
    },
    { $sort: { tokens: -1, requests: -1 } },
  ]);
  return rows.map((r) => ({
    tool: r._id.tool,
    model: r._id.model,
    tokens: r.tokens,
    input: r.input,
    output: r.output,
    requests: r.requests,
  }));
}

export async function getMemberDailyTrend(
  id: string,
  range: DateRange,
): Promise<Array<{ date: string; tokens: number; requests: number }>> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { memberId: oid(id), ...inRange(range) } },
    {
      $group: {
        _id: "$date",
        tokens: { $sum: TOKENS_EXPR },
        requests: { $sum: REQUESTS_EXPR },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({
    date: r._id as string,
    tokens: r.tokens,
    requests: r.requests,
  }));
}

// Tools this member has ever used (for the detail header, ignores range).
export async function getMemberTools(id: string): Promise<string[]> {
  await connectDb();
  const tools = await UsageDaily.distinct("tool", { memberId: oid(id) });
  return tools.sort();
}

// ---- per-machine collection status (for /me) --------------------------------

export type MachineStatus = {
  machineId: string;
  lastDate: string;
  recentTokens: number; // input+output, last 14 days
  recentRequests: number;
};

// Which machines are uploading this member's Claude Code usage, and how
// recently — lets a member confirm a newly installed machine is being counted.
export async function getMyMachines(email: string): Promise<MachineStatus[]> {
  await connectDb();
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await UsageDaily.aggregate([
    { $match: { tool: "claude_code", externalId: email } },
    {
      $group: {
        _id: "$machineId",
        lastDate: { $max: "$date" },
        recentTokens: {
          $sum: { $cond: [{ $gte: ["$date", since] }, TOKENS_EXPR, 0] },
        },
        recentRequests: {
          $sum: {
            $cond: [{ $gte: ["$date", since] }, { $ifNull: ["$requests", 0] }, 0],
          },
        },
      },
    },
    { $sort: { lastDate: -1 } },
  ]);
  return rows.map((r) => ({
    machineId: (r._id as string) ?? "",
    lastDate: r.lastDate,
    recentTokens: r.recentTokens,
    recentRequests: r.recentRequests,
  }));
}

// ---- plan-limit snapshots (own collection; per member + Claude account) -----

export type LimitSnapshot = {
  memberId: string;
  accountEmail: string; // distinguishes a member's multiple Claude accounts
  organization: string; // distinguishes plans within one account ("" legacy)
  window: string; // five_hour | seven_day | seven_day_opus | ...
  utilizationPct: number;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  resetsAt: string | null;
  date: string;
  updatedAt: string | null; // snapshot write time — freshness display
};

// Latest snapshot per (member, account, window). Optionally scoped to one
// member (member-detail / me).
export async function getLatestLimits(
  memberId?: string,
): Promise<LimitSnapshot[]> {
  await connectDb();
  const match = memberId ? { memberId: oid(memberId) } : {};
  const rows = await LimitSnapshotModel.aggregate([
    { $match: match },
    { $sort: { date: -1, updatedAt: -1 } },
    {
      $group: {
        _id: {
          memberId: "$memberId",
          accountEmail: "$accountEmail",
          organization: { $ifNull: ["$organization", ""] },
          window: "$window",
        },
        utilizationPct: { $first: "$utilizationPct" },
        subscriptionType: { $first: "$subscriptionType" },
        rateLimitTier: { $first: "$rateLimitTier" },
        resetsAt: { $first: "$resetsAt" },
        date: { $first: "$date" },
        updatedAt: { $first: "$updatedAt" },
      },
    },
  ]);
  return rows.map((r) => ({
    memberId: String(r._id.memberId),
    accountEmail: r._id.accountEmail,
    organization: r._id.organization ?? "",
    window: r._id.window,
    utilizationPct: r.utilizationPct,
    subscriptionType: r.subscriptionType ?? null,
    rateLimitTier: r.rateLimitTier ?? null,
    resetsAt: r.resetsAt ?? null,
    date: r.date,
    updatedAt:
      r.updatedAt instanceof Date ? r.updatedAt.toISOString() : (r.updatedAt ?? null),
  }));
}

// ---- analytics: leaderboard / heatmap / model share / WoW -------------------

export type LeaderboardRow = {
  memberId: string;
  name: string;
  email: string;
  tokens: number;
  requests: number;
  byTool: Record<string, number>; // per-tool token split for the stacked bar
  // Cost-weighted share of the team total (=100) and its per-tool split, in
  // index points — see src/lib/pricing.ts for why raw tokens can't be
  // compared across sources.
  weightedShare: number;
  byToolShare: Record<string, number>;
};

// Token/request ranking of linked members, with a per-tool token breakdown so
// the bar can stack by tool. Unlinked usage (memberId null) is excluded — an
// unattributed row has no member to rank. The model dimension is kept in the
// pipeline solely to price each slice; pricing lives in JS, not the DB.
export async function getMemberLeaderboard(
  range: DateRange,
): Promise<LeaderboardRow[]> {
  await connectDb();
  const [members, usage] = await Promise.all([
    Member.find().lean(),
    UsageDaily.aggregate([
      { $match: { memberId: { $ne: null }, ...inRange(range) } },
      {
        $group: {
          _id: { memberId: "$memberId", tool: "$tool", model: "$model" },
          tokens: { $sum: TOKENS_EXPR },
          requests: { $sum: REQUESTS_EXPR },
          inputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          outputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          cacheReadTokens: { $sum: { $ifNull: ["$cacheReadTokens", 0] } },
          cacheCreationTokens: {
            $sum: { $ifNull: ["$cacheCreationTokens", 0] },
          },
        },
      },
    ]),
  ]);
  const byMember = new Map<
    string,
    {
      tokens: number;
      requests: number;
      weight: number;
      byTool: Record<string, number>;
      byToolWeight: Record<string, number>;
    }
  >();
  for (const u of usage) {
    const id = String(u._id.memberId);
    let agg = byMember.get(id);
    if (!agg) {
      byMember.set(
        id,
        (agg = { tokens: 0, requests: 0, weight: 0, byTool: {}, byToolWeight: {} }),
      );
    }
    const tool = u._id.tool;
    const weight = estimateWeight({ ...u, tool, model: u._id.model });
    agg.tokens += u.tokens;
    agg.requests += u.requests;
    agg.weight += weight;
    agg.byTool[tool] = (agg.byTool[tool] ?? 0) + u.tokens;
    agg.byToolWeight[tool] = (agg.byToolWeight[tool] ?? 0) + weight;
  }
  const totalWeight = [...byMember.values()].reduce((s, a) => s + a.weight, 0);
  const toShare = (w: number) => (totalWeight > 0 ? (w / totalWeight) * 100 : 0);
  const memberById = new Map(members.map((m) => [String(m._id), m]));
  return [...byMember.entries()]
    .map(([id, agg]) => {
      const m = memberById.get(id);
      return {
        memberId: id,
        name: m?.name ?? "(알 수 없음)",
        email: m?.email ?? "",
        tokens: agg.tokens,
        requests: agg.requests,
        byTool: agg.byTool,
        weightedShare: toShare(agg.weight),
        byToolShare: Object.fromEntries(
          Object.entries(agg.byToolWeight).map(([t, w]) => [t, toShare(w)]),
        ),
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

// 7×24 matrix [dayOfWeek 0=Mon..6=Sun][hour 0..23] of summed tokens, from
// usage_hourly ONLY (never summed with usage_daily). The hour string carries
// its own date, so the range is matched lexicographically on "YYYY-MM-DDTHH";
// dow/hour are bucketed in JS (tiny data). Scoped to one member when given.
export async function getHourlyHeatmap(
  range: DateRange,
  memberId?: string,
): Promise<number[][]> {
  await connectDb();
  const match: Record<string, unknown> = {
    hour: { $gte: `${range.from}T00`, $lte: `${range.to}T23` },
  };
  if (memberId) match.memberId = oid(memberId);
  const rows = await UsageHourly.aggregate([
    { $match: match },
    { $group: { _id: "$hour", tokens: { $sum: TOKENS_EXPR } } },
  ]);
  const matrix = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) {
    const hourStr = r._id as string; // "YYYY-MM-DDTHH" (UTC)
    const d = new Date(`${hourStr}:00:00Z`);
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
    matrix[dow][d.getUTCHours()] += r.tokens;
  }
  return matrix;
}

export type ModelDistRow = { model: string; tool: string; tokens: number };

// Token share per (tool, model), positive totals only, largest first — feeds
// the model-mix donut. Scoped to one member when given.
export async function getModelDistribution(
  range: DateRange,
  memberId?: string,
): Promise<ModelDistRow[]> {
  await connectDb();
  const match: Record<string, unknown> = { ...inRange(range) };
  if (memberId) match.memberId = oid(memberId);
  const rows = await UsageDaily.aggregate([
    { $match: match },
    {
      $group: {
        _id: { tool: "$tool", model: "$model" },
        tokens: { $sum: TOKENS_EXPR },
      },
    },
    { $match: { tokens: { $gt: 0 } } },
    { $sort: { tokens: -1 } },
  ]);
  return rows.map((r) => ({
    tool: r._id.tool,
    model: r._id.model,
    tokens: r.tokens,
  }));
}

export type WowRow = {
  memberId: string;
  name: string;
  tokens: number; // trailing 7 full days
  prevTokens: number; // the 7 days before that
  pct: number | null; // null when prevTokens is 0 (no baseline → "신규")
};

// Per-member token change: trailing 7 full days vs the prior 7. Window math
// mirrors the Slack weekly report (src/lib/slack.ts): [today-7, today) vs
// [today-14, today-7), both half-open. Linked members only.
export async function getMemberWowDeltas(): Promise<WowRow[]> {
  await connectDb();
  const today = isoDaysAgo(0);
  const weekAgo = isoDaysAgo(7);
  const twoWeeksAgo = isoDaysAgo(14);
  const [members, current, previous] = await Promise.all([
    Member.find().lean(),
    memberTokensInWindow(weekAgo, today),
    memberTokensInWindow(twoWeeksAgo, weekAgo),
  ]);
  const ids = new Set([...current.keys(), ...previous.keys()]);
  const memberById = new Map(members.map((m) => [String(m._id), m]));
  return [...ids]
    .map((id) => {
      const tokens = current.get(id) ?? 0;
      const prevTokens = previous.get(id) ?? 0;
      const pct =
        prevTokens === 0 ? null : ((tokens - prevTokens) / prevTokens) * 100;
      return {
        memberId: id,
        name: memberById.get(id)?.name ?? "(알 수 없음)",
        tokens,
        prevTokens,
        pct,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

// memberId -> summed tokens over [fromDate, toDateExclusive), linked only.
async function memberTokensInWindow(
  fromDate: string,
  toDateExclusive: string,
): Promise<Map<string, number>> {
  const rows = await UsageDaily.aggregate([
    {
      $match: {
        memberId: { $ne: null },
        date: { $gte: fromDate, $lt: toDateExclusive },
      },
    },
    { $group: { _id: "$memberId", tokens: { $sum: TOKENS_EXPR } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.tokens as number]));
}

// ---- team analytics ---------------------------------------------------------

export type WeeklyRate = {
  week: string;
  activePct: number;
  active: number;
  total: number;
};

// Weekly distinct active members ÷ current member count, as a percentage.
// Denominator is TODAY's member count — we don't reconstruct historical
// membership (documented simplification in the spec). Linked members only:
// an unmapped external id can't be counted against the roster.
export async function getTeamAdoptionRate(
  range: DateRange,
): Promise<WeeklyRate[]> {
  await connectDb();
  const [total, rows] = await Promise.all([
    Member.countDocuments(VISIBLE_MEMBER),
    UsageDaily.aggregate([
      { $match: { memberId: { $ne: null }, ...inRange(range) } },
      {
        $group: {
          _id: "$date",
          members: { $addToSet: { $toString: "$memberId" } },
        },
      },
    ]),
  ]);
  const weekly = new Map<string, Set<string>>();
  for (const r of rows) {
    const week = mondayOf(r._id as string);
    let set = weekly.get(week);
    if (!set) weekly.set(week, (set = new Set()));
    for (const m of r.members as string[]) set.add(m);
  }
  return [...weekly.entries()]
    .map(([week, members]) => ({
      week,
      active: members.size,
      total,
      activePct: total > 0 ? (members.size / total) * 100 : 0,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

export type MatrixCell = { tool: string; lastDate: string };
export type MatrixRow = { memberId: string; name: string; cells: MatrixCell[] };

// Display order for tools we know about; anything else seen in the data is
// appended after these, alphabetically.
const MATRIX_TOOL_ORDER = ["cursor", "claude_code", "codex", "gemini", "grok", "copilot"];

// member × tool grid of last-usage dates — whole history, not range-bound,
// because the question is "언제 마지막으로 썼나". Registered members with no
// usage at all still get a row (empty cells) so gaps are visible.
export async function getAdoptionMatrix(): Promise<{
  tools: string[];
  rows: MatrixRow[];
}> {
  await connectDb();
  const [members, usage] = await Promise.all([
    Member.find(VISIBLE_MEMBER).sort({ name: 1 }).lean(),
    UsageDaily.aggregate([
      { $match: { memberId: { $ne: null } } },
      {
        $group: {
          _id: { memberId: "$memberId", tool: "$tool" },
          lastDate: { $max: "$date" },
        },
      },
    ]),
  ]);
  const seen = new Set<string>(usage.map((u) => u._id.tool as string));
  const tools = [
    ...MATRIX_TOOL_ORDER,
    ...[...seen].filter((t) => !MATRIX_TOOL_ORDER.includes(t)).sort(),
  ];
  const cellsByMember = new Map<string, Map<string, string>>();
  for (const u of usage) {
    const id = String(u._id.memberId);
    let byTool = cellsByMember.get(id);
    if (!byTool) cellsByMember.set(id, (byTool = new Map()));
    byTool.set(u._id.tool, u.lastDate);
  }
  const rows = members.map((m) => {
    const byTool = cellsByMember.get(String(m._id));
    return {
      memberId: String(m._id),
      name: m.name,
      cells: tools.flatMap((tool) => {
        const lastDate = byTool?.get(tool);
        return lastDate ? [{ tool, lastDate }] : [];
      }),
    };
  });
  return { tools, rows };
}

export type InactiveMember = {
  name: string;
  email: string;
  lastDate: string | null;
};

// Registered members with no usage rows in the trailing `days` days.
// lastDate is the all-time last usage date (null = never recorded).
export async function getInactiveMembers(days = 7): Promise<InactiveMember[]> {
  await connectDb();
  const cutoff = isoDaysAgo(days);
  const [members, usage] = await Promise.all([
    Member.find(VISIBLE_MEMBER).sort({ name: 1 }).lean(),
    UsageDaily.aggregate([
      { $match: { memberId: { $ne: null } } },
      { $group: { _id: "$memberId", lastDate: { $max: "$date" } } },
    ]),
  ]);
  const lastByMember = new Map(
    usage.map((u) => [String(u._id), u.lastDate as string]),
  );
  return members
    .map((m) => ({
      name: m.name,
      email: m.email,
      lastDate: lastByMember.get(String(m._id)) ?? null,
    }))
    .filter((m) => m.lastDate === null || m.lastDate < cutoff);
}

export type TierWeek = { week: string } & Record<string, number | string>;

// Weekly token (input+output) share % per pricing family (fable/opus/…).
// Weeks whose token total is 0 are skipped — a share of nothing isn't a
// data point. families is sorted by whole-range token sum, descending, so
// stacked-area layers keep a stable, biggest-first order.
export async function getModelTierTrend(
  range: DateRange,
): Promise<{ weeks: TierWeek[]; families: string[] }> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: inRange(range) },
    {
      $group: {
        _id: { date: "$date", tool: "$tool", model: "$model" },
        tokens: { $sum: TOKENS_EXPR },
      },
    },
  ]);
  const byWeek = new Map<string, Map<string, number>>();
  const familyTotals = new Map<string, number>();
  for (const r of rows) {
    if (r.tokens <= 0) continue;
    const family = rateFamily(String(r._id.model ?? ""), r._id.tool);
    const week = mondayOf(r._id.date);
    let byFamily = byWeek.get(week);
    if (!byFamily) byWeek.set(week, (byFamily = new Map()));
    byFamily.set(family, (byFamily.get(family) ?? 0) + r.tokens);
    familyTotals.set(family, (familyTotals.get(family) ?? 0) + r.tokens);
  }
  const families = [...familyTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, byFamily]) => {
      const total = [...byFamily.values()].reduce((s, v) => s + v, 0);
      const row: TierWeek = { week };
      for (const f of families) row[f] = ((byFamily.get(f) ?? 0) / total) * 100;
      return row;
    });
  return { weeks, families };
}

// peakPct arrived with the daily-peak feature (Task 1); snapshots written
// before the backfill only carry last-write utilizationPct — fall back so
// history doesn't show holes.
const PEAK_PCT_EXPR = { $ifNull: ["$peakPct", "$utilizationPct"] };

export type LimitDay = { date: string; window: string; peakPct: number };
export type LimitAccountHistory = {
  memberName: string;
  accountEmail: string;
  organization: string;
  days: LimitDay[];
};

// Daily peak utilization per (member, account, organization) over the range.
// One snapshot doc exists per (date, …, window) — the unique index in
// models.ts — so no dedup grouping is needed, just a sorted projection.
export async function getLimitHistory(
  range: DateRange,
): Promise<LimitAccountHistory[]> {
  await connectDb();
  const [members, rows] = await Promise.all([
    Member.find().lean(),
    LimitSnapshotModel.aggregate([
      { $match: inRange(range) },
      {
        $project: {
          memberId: 1,
          accountEmail: 1,
          organization: { $ifNull: ["$organization", ""] },
          date: 1,
          window: 1,
          peakPct: PEAK_PCT_EXPR,
        },
      },
      { $sort: { date: 1, window: 1 } },
    ]),
  ]);
  const nameById = new Map(members.map((m) => [String(m._id), m.name]));
  const byAccount = new Map<string, LimitAccountHistory>();
  for (const r of rows) {
    const key = `${r.memberId}|${r.accountEmail}|${r.organization}`;
    let acc = byAccount.get(key);
    if (!acc) {
      byAccount.set(
        key,
        (acc = {
          memberName: nameById.get(String(r.memberId)) ?? "(알 수 없음)",
          accountEmail: r.accountEmail,
          organization: r.organization,
          days: [],
        }),
      );
    }
    acc.days.push({ date: r.date, window: r.window, peakPct: r.peakPct });
  }
  return [...byAccount.values()].sort(
    (a, b) =>
      a.memberName.localeCompare(b.memberName) ||
      a.accountEmail.localeCompare(b.accountEmail) ||
      a.organization.localeCompare(b.organization),
  );
}

export type LimitHitRow = {
  memberName: string;
  accountEmail: string;
  organization: string;
  window: string;
  days90: number; // peakPct >= 90 인 날 수
  days100: number; // peakPct >= 100 인 날 수
};

// How many days each (account, window) hit ≥90% / ≥100% of its plan limit —
// the "who needs a bigger seat" signal. Rows that never came close (both
// counts 0) are noise and dropped.
export async function getLimitHitCounts(
  range: DateRange,
): Promise<LimitHitRow[]> {
  await connectDb();
  const [members, rows] = await Promise.all([
    Member.find().lean(),
    LimitSnapshotModel.aggregate([
      { $match: inRange(range) },
      {
        $group: {
          _id: {
            memberId: "$memberId",
            accountEmail: "$accountEmail",
            organization: { $ifNull: ["$organization", ""] },
            window: "$window",
          },
          days90: {
            $sum: { $cond: [{ $gte: [PEAK_PCT_EXPR, 90] }, 1, 0] },
          },
          days100: {
            $sum: { $cond: [{ $gte: [PEAK_PCT_EXPR, 100] }, 1, 0] },
          },
        },
      },
      { $match: { $or: [{ days90: { $gt: 0 } }, { days100: { $gt: 0 } }] } },
      { $sort: { days90: -1, days100: -1 } },
    ]),
  ]);
  const nameById = new Map(members.map((m) => [String(m._id), m.name]));
  return rows.map((r) => ({
    memberName: nameById.get(String(r._id.memberId)) ?? "(알 수 없음)",
    accountEmail: r._id.accountEmail,
    organization: r._id.organization,
    window: r._id.window,
    days90: r.days90,
    days100: r.days100,
  }));
}

// ---- digests -----------------------------------------------------------------

export type MyDigest = {
  date: string;
  content: string;
  materials: string;
  status: string;
};

// Latest unresolved draft within the trailing 7 days (the /me approval card),
// if any. Drafts are private: only ever queried by their owner's memberId.
export async function getMyDigest(memberId: string): Promise<MyDigest | null> {
  await connectDb();
  const doc = await Digest.findOne({
    memberId: oid(memberId),
    status: "draft",
    date: { $gte: isoDaysAgo(7) },
  })
    .sort({ date: -1 })
    .lean();
  if (!doc) return null;
  return {
    date: doc.date,
    content: doc.content,
    materials: doc.materials,
    status: doc.status,
  };
}

export type TeamDigest = { date: string; memberName: string; content: string };

// Member-approved (shared) digests only — drafts and skips never appear on
// /team. Newest date first, then member name.
export async function getTeamDigests(days = 7): Promise<TeamDigest[]> {
  await connectDb();
  const [members, docs] = await Promise.all([
    Member.find().lean(),
    Digest.find({ status: "shared", date: { $gte: isoDaysAgo(days) } }).lean(),
  ]);
  const nameById = new Map(members.map((m) => [String(m._id), m.name]));
  return docs
    .map((d) => ({
      date: d.date,
      memberName: nameById.get(String(d.memberId)) ?? "(알 수 없음)",
      content: d.content,
    }))
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.memberName.localeCompare(b.memberName),
    );
}

export type DigestConflict = {
  repo: string;
  members: string[];
  fileCount: number;
  sampleFiles: string[];
};

// Overlapping touched files across SHARED digests only. Trust contract: an
// unshared draft never feeds any team-level computation — conflict detection
// included — so nothing a member hasn't approved can leak through a banner.
export async function getDigestConflicts(days = 7): Promise<DigestConflict[]> {
  await connectDb();
  const [members, docs] = await Promise.all([
    Member.find().lean(),
    Digest.find({ status: "shared", date: { $gte: isoDaysAgo(days) } }).lean(),
  ]);
  const nameById = new Map(members.map((m) => [String(m._id), m.name]));
  // (repo, file) -> distinct member names who touched it in a shared digest.
  const touchers = new Map<string, Set<string>>();
  for (const d of docs) {
    const name = nameById.get(String(d.memberId)) ?? "(알 수 없음)";
    for (const t of d.touchedFiles ?? []) {
      for (const file of t.files ?? []) {
        const key = `${t.repo}\u0000${file}`;
        let set = touchers.get(key);
        if (!set) touchers.set(key, (set = new Set()));
        set.add(name);
      }
    }
  }
  // Files with 2+ members, grouped per (repo, member combination) so one
  // banner line covers the whole overlapping set.
  const groups = new Map<string, DigestConflict>();
  for (const [key, names] of touchers) {
    if (names.size < 2) continue;
    const [repo, file] = key.split("\u0000");
    const memberNames = [...names].sort();
    const groupKey = `${repo}\u0000${memberNames.join(",")}`;
    let g = groups.get(groupKey);
    if (!g) {
      groups.set(
        groupKey,
        (g = { repo, members: memberNames, fileCount: 0, sampleFiles: [] }),
      );
    }
    g.fileCount += 1;
    if (g.sampleFiles.length < 3) g.sampleFiles.push(file);
  }
  return [...groups.values()].sort(
    (a, b) => b.fileCount - a.fileCount || a.repo.localeCompare(b.repo),
  );
}

// ---- helpers ----------------------------------------------------------------

// Aggregation $match does not auto-cast strings to ObjectId — do it explicitly.
function oid(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}

function pivot(
  rows: Array<{ date: string; tool: string } & Record<string, unknown>>,
  valueKey: string,
): DailySeries {
  const toolSet = new Set<string>();
  const byDate = new Map<string, Record<string, string | number>>();
  for (const r of rows) {
    toolSet.add(r.tool);
    let bucket = byDate.get(r.date);
    if (!bucket) {
      bucket = { date: r.date };
      byDate.set(r.date, bucket);
    }
    bucket[r.tool] = Number(r[valueKey] ?? 0);
  }
  const tools = [...toolSet].sort();
  const data = [...byDate.values()].map((bucket) => {
    for (const t of tools) if (!(t in bucket)) bucket[t] = 0;
    return bucket;
  });
  return { data, tools };
}

// 멤버의 날짜별 활동 재료. distinct 툴 목록 + 에이전틱 툴(claude_code·codex)
// input/cacheRead/output/cacheCreation 합. since(포함) 이후 날짜만. 성장엔진 입력용.
// 효율보너스(수율)에 기여하는 에이전틱 툴. 활동일·스트릭·다양성은 전 툴 기준.
export const EFFICIENCY_TOOLS = ["claude_code", "codex"];

export async function getGrowthDays(
  memberId: string,
  since: string,
): Promise<GrowthDay[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { memberId: oid(memberId), date: { $gte: since } } },
    {
      $group: {
        _id: "$date",
        tools: { $addToSet: "$tool" },
        input: {
          $sum: {
            $cond: [{ $in: ["$tool", EFFICIENCY_TOOLS] }, { $ifNull: ["$inputTokens", 0] }, 0],
          },
        },
        cacheRead: {
          $sum: {
            $cond: [{ $in: ["$tool", EFFICIENCY_TOOLS] }, { $ifNull: ["$cacheReadTokens", 0] }, 0],
          },
        },
        output: {
          $sum: {
            $cond: [{ $in: ["$tool", EFFICIENCY_TOOLS] }, { $ifNull: ["$outputTokens", 0] }, 0],
          },
        },
        cacheCreation: {
          $sum: {
            $cond: [{ $in: ["$tool", EFFICIENCY_TOOLS] }, { $ifNull: ["$cacheCreationTokens", 0] }, 0],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({
    date: r._id as string,
    tools: (r.tools as string[]) ?? [],
    input: r.input as number,
    cacheRead: r.cacheRead as number,
    output: r.output as number,
    cacheCreation: r.cacheCreation as number,
  }));
}

// ---- scorecard (스펙: 2026-07-26-ai-scorecard-design.md) ----

export type ScorecardMemberRow = {
  memberId: string;
  tool: string;
  sums: ScoreSums;
  models: string[]; // 이 (멤버,도구)에서 쓴 모델들 (확장 축 모델 종 수용)
};

// 멤버×도구 합산 — 스코어카드의 원재료. Copilot은 토큰 null이라 자연 제외됨.
export async function getScorecardSums(range: DateRange): Promise<ScorecardMemberRow[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { date: { $gte: range.from, $lte: range.to }, memberId: { $ne: null } } },
    {
      $group: {
        _id: { memberId: "$memberId", tool: "$tool" },
        input: { $sum: { $ifNull: ["$inputTokens", 0] } },
        output: { $sum: { $ifNull: ["$outputTokens", 0] } },
        cacheRead: { $sum: { $ifNull: ["$cacheReadTokens", 0] } },
        cacheCreation: { $sum: { $ifNull: ["$cacheCreationTokens", 0] } },
        requests: { $sum: { $ifNull: ["$requests", 0] } },
        sessions: { $sum: { $ifNull: ["$sessions", 0] } },
        models: { $addToSet: "$model" },
      },
    },
  ]);
  return rows.map((r) => ({
    memberId: String(r._id.memberId),
    tool: r._id.tool,
    sums: {
      input: r.input, output: r.output, cacheRead: r.cacheRead,
      cacheCreation: r.cacheCreation, requests: r.requests, sessions: r.sessions,
    },
    models: (r.models as string[]).filter((m) => m !== ""),
  }));
}

// 주별 멤버×도구 합산 — 팀 추세(풀드+중앙값)용. week = ISO 월요일(mondayOf 재사용).
export type ScorecardWeeklyRow = ScorecardMemberRow & { week: string };

export async function getScorecardWeeklySums(range: DateRange): Promise<ScorecardWeeklyRow[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { date: { $gte: range.from, $lte: range.to }, memberId: { $ne: null } } },
    {
      $group: {
        _id: { memberId: "$memberId", tool: "$tool", date: "$date" },
        input: { $sum: { $ifNull: ["$inputTokens", 0] } },
        output: { $sum: { $ifNull: ["$outputTokens", 0] } },
        cacheRead: { $sum: { $ifNull: ["$cacheReadTokens", 0] } },
        cacheCreation: { $sum: { $ifNull: ["$cacheCreationTokens", 0] } },
        requests: { $sum: { $ifNull: ["$requests", 0] } },
        sessions: { $sum: { $ifNull: ["$sessions", 0] } },
      },
    },
  ]);
  const acc = new Map<string, ScorecardWeeklyRow>();
  for (const r of rows) {
    const week = mondayOf(r._id.date);
    const key = `${week}|${r._id.memberId}|${r._id.tool}`;
    const cur = acc.get(key) ?? {
      week, memberId: String(r._id.memberId), tool: r._id.tool,
      sums: { ...EMPTY_SUMS }, models: [],
    };
    cur.sums = addSums(cur.sums, r);
    acc.set(key, cur);
  }
  return [...acc.values()];
}

// 프리미엄 비중 (팀 효율 축, 기존 지표 이관) — 주별·멤버별 프리미엄(Opus/Fable급)
// 토큰 대 전체 토큰. 모델 구분이 필요해 getScorecardWeeklySums(도구 단위 합산)로는
// 계산할 수 없다 — 별도로 모델 단위까지 그룹핑한다. tokens = input+output
// (TOKENS_EXPR과 동일 정의, 캐시 토큰 제외).
export type PremiumShareWeeklyRow = {
  week: string;
  memberId: string;
  premiumTokens: number;
  totalTokens: number;
};

export async function getPremiumShareWeekly(range: DateRange): Promise<PremiumShareWeeklyRow[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { date: { $gte: range.from, $lte: range.to }, memberId: { $ne: null } } },
    {
      $group: {
        _id: { memberId: "$memberId", date: "$date", model: "$model" },
        tokens: { $sum: TOKENS_EXPR },
      },
    },
  ]);
  const acc = new Map<string, PremiumShareWeeklyRow>();
  for (const r of rows) {
    const week = mondayOf(r._id.date);
    const memberId = String(r._id.memberId);
    const key = `${week}|${memberId}`;
    const cur = acc.get(key) ?? { week, memberId, premiumTokens: 0, totalTokens: 0 };
    cur.totalTokens += r.tokens;
    if (isPremiumModel(String(r._id.model ?? ""))) cur.premiumTokens += r.tokens;
    acc.set(key, cur);
  }
  return [...acc.values()];
}

// 모델 다양성 — 주·멤버별 모델→토큰 맵. 모델 단위 그룹핑이 필요해
// getScorecardWeeklySums(도구 단위)로는 못 만든다. tokens=TOKENS_EXPR(input+output,
// 캐시 제외 — premium/donut과 동일 정의). 엔트로피 계산은 scorecard.ts에서.
export type ModelBreadthWeeklyRow = { week: string; memberId: string; byModel: Record<string, number> };

export async function getModelBreadthWeekly(range: DateRange): Promise<ModelBreadthWeeklyRow[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { date: { $gte: range.from, $lte: range.to }, memberId: { $ne: null } } },
    { $group: { _id: { memberId: "$memberId", date: "$date", model: "$model" }, tokens: { $sum: TOKENS_EXPR } } },
  ]);
  const acc = new Map<string, ModelBreadthWeeklyRow>();
  for (const r of rows) {
    const model = String(r._id.model ?? "");
    if (!model) continue;
    const week = mondayOf(r._id.date);
    const memberId = String(r._id.memberId);
    const key = `${week}|${memberId}`;
    const cur = acc.get(key) ?? { week, memberId, byModel: {} };
    cur.byModel[model] = (cur.byModel[model] ?? 0) + r.tokens;
    acc.set(key, cur);
  }
  return [...acc.values()];
}

// A2 캐시 절감 — (tool,model) 합산에 단가 적용해 saved/spent 가중치 산출.
export async function getCacheSavings(range: DateRange): Promise<{ saved: number; spent: number }> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { date: { $gte: range.from, $lte: range.to } } },
    {
      $group: {
        _id: { tool: "$tool", model: "$model" },
        input: { $sum: { $ifNull: ["$inputTokens", 0] } },
        output: { $sum: { $ifNull: ["$outputTokens", 0] } },
        cacheRead: { $sum: { $ifNull: ["$cacheReadTokens", 0] } },
        cacheCreation: { $sum: { $ifNull: ["$cacheCreationTokens", 0] } },
      },
    },
  ]);
  let saved = 0;
  let spent = 0;
  for (const r of rows) {
    const rate = rateFamily(r._id.model, r._id.tool);
    spent += estimateWeight({
      model: r._id.model, tool: r._id.tool,
      inputTokens: r.input, outputTokens: r.output,
      cacheReadTokens: r.cacheRead, cacheCreationTokens: r.cacheCreation,
    });
    saved += (r.cacheRead / 1_000_000) * (RATES[rate].input - RATES[rate].cacheRead);
  }
  return { saved, spent };
}

// D1 — 최근 등장 모델별 멤버 최초 사용일. sinceDays 안에 전역 최초 등장한 모델만.
export type ModelAdoptionRow = { model: string; globalFirst: string; memberFirstDates: string[] };

// Cursor's mode/tier placeholders — not real model names — so they shouldn't
// count as "신모델 채택" (model adoption). Exact match (case-insensitive),
// not substring: real model families like "composer-1" must stay countable.
const NON_MODEL_NAMES = new Set(["default", "premium", "auto", "unknown", "composer"]);

export async function getModelAdoption(sinceDays = 120): Promise<ModelAdoptionRow[]> {
  await connectDb();
  const since = isoDaysAgo(sinceDays);
  const rows = await UsageDaily.aggregate([
    { $match: { model: { $ne: "" }, memberId: { $ne: null } } },
    { $group: { _id: { model: "$model", memberId: "$memberId" }, first: { $min: "$date" } } },
    { $group: { _id: "$_id.model", globalFirst: { $min: "$first" }, memberFirsts: { $push: "$first" } } },
    { $match: { globalFirst: { $gte: since } } },
    { $sort: { globalFirst: -1 } },
  ]);
  return rows
    .filter((r) => !NON_MODEL_NAMES.has(String(r._id).toLowerCase().trim()))
    .map((r) => ({
      model: r._id as string,
      globalFirst: r.globalFirst as string,
      memberFirstDates: r.memberFirsts as string[],
    }));
}

// D3 — 최근 코호트(온보딩 12주 이내) 멤버별 활동일 목록.
export async function getOnboardingActivity(): Promise<
  Array<{ memberId: string; name: string; onboardedAt: string; activeDates: string[] }>
> {
  await connectDb();
  const cutoff = new Date(Date.now() - 12 * 7 * 86_400_000);
  const members = await Member.find(
    { onboardedAt: { $ne: null, $gte: cutoff } },
    { name: 1, onboardedAt: 1 },
  ).lean();
  const out = [];
  for (const m of members) {
    const onboarded = new Date(m.onboardedAt as Date).toISOString().slice(0, 10);
    const dates = await UsageDaily.distinct("date", {
      memberId: m._id, date: { $gte: onboarded },
    });
    out.push({ memberId: String(m._id), name: m.name, onboardedAt: onboarded, activeDates: dates.sort() });
  }
  return out;
}
