// Daily Claude spend-report rows as display facts, so the dashboard counts
// people who use Claude outside Claude Code (Chat, Cowork, ...).
//
// Same combination rules as the growth engine (src/lib/growth-days.ts):
//   - Report products other than "Claude Code" are ADDED as their own tools.
//   - "Claude Code" exists on both sides (the uploader sees local sessions of
//     any account, the report sees the company organization incl. cloud runs),
//     so each person-day keeps the LARGER side — never both.
//   - The report's UTC date is taken as the activity date as-is.
// Unlike growth, rows that map to no member are kept (memberId "") so they land
// in the same unlinked bucket as any other unmapped usage.
import { connectDb, Member, MemberIdentity } from "@/lib/db";
import { UsageReport } from "@/lib/db/usage-report";
import { matchesFact, supportsCutoverMatch } from "@/lib/collection-cutover";
import { CLAUDE_REPORT_SOURCE, reportProductTool } from "@/lib/growth-days";
import { observeField, type FieldStatus, type ObservationField } from "@/lib/observation";
import type { UsageFact } from "@/lib/usage-display";

const CLAUDE_CODE_TOOL = "claude_code";

export type ReportSnapshotLike = {
  accountId: string; periodStart: string; periodEnd: string; collectedAt: Date | string;
  rows?: Array<{ product: string; model?: string; externalId?: string; metrics?: Record<string, number | undefined> }>;
};

// Report filters this module can evaluate in memory. A match on anything else
// (device, source, tool, hour) asks for uploader-specific rows: no report rows.
export function supportsReportMatch(match: Record<string, unknown>): boolean {
  return supportsCutoverMatch(match) && !("tool" in match) && !("hour" in match);
}

// Single-day snapshots → facts. When a day was imported more than once for an
// account, only the most recently collected snapshot is used.
export function reportFacts(snapshots: ReportSnapshotLike[], memberByEmail: Map<string, string>): UsageFact[] {
  const latest = new Map<string, ReportSnapshotLike>();
  for (const snapshot of snapshots) {
    if (snapshot.periodStart !== snapshot.periodEnd) continue;
    const key = `${snapshot.accountId}|${snapshot.periodStart}`;
    const prior = latest.get(key);
    if (!prior || new Date(snapshot.collectedAt).getTime() > new Date(prior.collectedAt).getTime()) latest.set(key, snapshot);
  }
  const facts: UsageFact[] = [];
  for (const snapshot of latest.values()) {
    for (const row of snapshot.rows ?? []) {
      const m = row.metrics ?? {};
      // prompt_tokens is the report's whole input side; the breakdown columns
      // (newer exports) split it. Use the split when present, never both.
      const hasBreakdown = m.uncached_input_tokens !== undefined || m.cache_read_tokens !== undefined || m.cache_write_tokens !== undefined;
      const values: Partial<Record<ObservationField, number | undefined>> = {
        inputTokens: hasBreakdown ? m.uncached_input_tokens : m.prompt_tokens,
        outputTokens: m.completion_tokens,
        cacheReadTokens: m.cache_read_tokens,
        cacheCreationTokens: m.cache_write_tokens,
        requests: m.reported_requests,
      };
      // A column the report carries is a measurement (0 included); a column it
      // lacks stays null and reads as 미확인. The report has no session count.
      const fieldEvidence: Partial<Record<ObservationField, FieldStatus>> = { sessions: "unsupported" };
      const fact: UsageFact = {
        date: snapshot.periodStart, tool: reportProductTool(row.product), model: row.model ?? "",
        memberId: "", externalId: String(row.externalId ?? "").trim().toLowerCase(), machineId: "", hour: "",
        source: CLAUDE_REPORT_SOURCE, dateBasis: "UTC", updatedAt: snapshot.collectedAt, fieldEvidence,
      };
      let positive = false;
      for (const [field, value] of Object.entries(values) as Array<[ObservationField, number | undefined]>) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
        (fact as Record<string, unknown>)[field] = value;
        fieldEvidence[field] = "known";
        positive ||= value > 0;
      }
      if (!positive) continue;
      fact.memberId = memberByEmail.get(fact.externalId) ?? "";
      facts.push(fact);
    }
  }
  return facts;
}

const personDay = (fact: UsageFact) => `${fact.memberId ? `m${fact.memberId}` : `x${fact.externalId.toLowerCase()}`}|${fact.date}`;

// Claude Code size of one side of a person-day. Tokens exclude cache reads —
// the growth engine's measure without its price conversion, so the choice does
// not move when a price table changes. Requests break a token tie.
function size(facts: UsageFact[]): [number, number] {
  let tokens = 0, requests = 0;
  for (const fact of facts) {
    for (const field of ["inputTokens", "outputTokens", "cacheCreationTokens"] as const) tokens += observeField(fact, field).value ?? 0;
    requests += observeField(fact, "requests").value ?? 0;
  }
  return [tokens, requests];
}

// Combine collected facts with report facts. Other products are appended; for
// Claude Code each person-day keeps whichever side is larger (ties keep the
// collected rows, which carry device and hour detail).
export function mergeReportFacts(collected: UsageFact[], reports: UsageFact[]): UsageFact[] {
  const local = new Map<string, UsageFact[]>();
  for (const fact of collected) if (fact.tool === CLAUDE_CODE_TOOL) local.set(personDay(fact), [...(local.get(personDay(fact)) ?? []), fact]);
  const remote = new Map<string, UsageFact[]>();
  const added: UsageFact[] = [];
  for (const fact of reports) {
    if (fact.tool !== CLAUDE_CODE_TOOL) added.push(fact);
    else remote.set(personDay(fact), [...(remote.get(personDay(fact)) ?? []), fact]);
  }
  const replaced = new Set<string>();
  for (const [key, facts] of remote) {
    const [reportTokens, reportRequests] = size(facts);
    const [localTokens, localRequests] = size(local.get(key) ?? []);
    if (reportTokens > localTokens || (reportTokens === localTokens && reportRequests > localRequests)) {
      replaced.add(key);
      added.push(...facts);
    }
  }
  const kept = replaced.size ? collected.filter((fact) => fact.tool !== CLAUDE_CODE_TOOL || !replaced.has(personDay(fact))) : collected;
  return [...kept, ...added].sort((a, b) => a.date.localeCompare(b.date));
}

// Emails a member is known by: the account email plus any identity that is an
// email (e.g. an older address). First registration wins on a clash.
async function memberEmailIndex(): Promise<Map<string, string>> {
  const [members, identities] = await Promise.all([
    Member.find({}, { email: 1 }).lean(),
    MemberIdentity.find({}, { memberId: 1, externalId: 1 }).lean(),
  ]);
  const index = new Map<string, string>();
  for (const member of members) index.set(String(member.email ?? "").trim().toLowerCase(), String(member._id));
  for (const identity of identities) {
    const email = String(identity.externalId ?? "").trim().toLowerCase();
    if (email.includes("@") && !index.has(email)) index.set(email, String(identity.memberId));
  }
  index.delete("");
  return index;
}

// Report facts that satisfy a daily usage match, or [] when the match cannot
// be evaluated against report rows.
export async function loadReportFacts(match: Record<string, unknown>): Promise<UsageFact[]> {
  if (!supportsReportMatch(match)) return [];
  await connectDb();
  const date = match.date;
  const [snapshots, index] = await Promise.all([
    UsageReport.find(
      { sourceId: CLAUDE_REPORT_SOURCE, $expr: { $eq: ["$periodStart", "$periodEnd"] }, ...(date === undefined ? {} : { periodStart: date }) },
      { accountId: 1, periodStart: 1, periodEnd: 1, collectedAt: 1, rows: 1 },
    ).lean(),
    memberEmailIndex(),
  ]);
  return reportFacts(snapshots as ReportSnapshotLike[], index).filter((fact) => matchesFact(fact, match));
}
