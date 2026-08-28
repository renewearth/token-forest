import type { Connector } from "./types";
import type { UsageRow } from "@/lib/types";
import { connectDb, Member, MemberIdentity, UsageDaily } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { todayUtc } from "@/lib/date";

// GitHub Copilot premium request usage, for members whose Copilot runs on
// personal GitHub accounts. There is no org-wide endpoint for personal seats,
// so this connector fans out over members: each stores their own encrypted
// GitHub token (Plan: read) and their GitHub username as the "copilot"
// member_identities externalId.
//
// Docs: https://docs.github.com/en/rest/billing/usage
// Endpoint: GET /users/{username}/settings/billing/premium_request/usage
//
// Granularity: the endpoint reports a single aggregate for the requested time
// period (year/month/day), broken down per product/SKU/model in `usageItems` —
// there is no day-by-day breakdown. Emitting the whole month as one row dated
// the 1st would make Copilot invisible to 7-day dashboard windows and the
// weekly Slack report, so instead each sync writes a *delta* row dated today
// (or the month's last day for past months): month-to-date total minus what
// usage_daily already holds for that month. Over daily syncs this converges to
// a daily-resolution series; a backfilled past month lands as one row on its
// last day. Copilot bills premium *requests*, not tokens, so token fields stay
// null and we fill `requests` from grossQuantity (netAmount → costEstimateCents).

const API_VERSION = "2022-11-28";

interface UsageItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  pricePerUnit: number;
  grossQuantity: number;
  grossAmount: number;
  discountQuantity: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}

interface PremiumUsageResponse {
  timePeriod: { year: number; month: number; day?: number };
  user: string;
  product?: string;
  model?: string;
  usageItems?: UsageItem[];
}

interface CopilotMember {
  username: string;
  tokenEnc: string;
}

// Members eligible for the Copilot poller: an encrypted GitHub token plus a
// "copilot" identity whose externalId is their GitHub username. Decryption is
// deferred to the per-member loop so one corrupt/legacy token (which throws)
// cannot abort the sync for everyone else.
// A GitHub username is alphanumeric with single hyphens — never an email. The
// manual-import path keys Copilot token rows on the member's email, which then
// risks re-registering as a "copilot" identity; such an externalId would 404
// every poll. Skip anything that isn't a plausible GitHub login so one stray
// email identity can't fail the whole sync.
function isGithubUsername(externalId: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(externalId);
}

async function eligibleMembers(): Promise<CopilotMember[]> {
  await connectDb();
  const identities = await MemberIdentity.find({ tool: "copilot" }).lean();
  const membersById = new Map(
    (await Member.find({ githubTokenEnc: { $ne: null } }).lean()).map((m) => [
      String(m._id),
      m,
    ]),
  );
  return identities.flatMap((i) => {
    if (!isGithubUsername(i.externalId)) {
      console.warn(
        `[copilot] skipping identity ${i.externalId}: not a GitHub username (Copilot polls by GitHub login, not email)`,
      );
      return [];
    }
    const member = membersById.get(String(i.memberId));
    return member?.githubTokenEnc
      ? [{ username: i.externalId, tokenEnc: member.githubTokenEnc }]
      : [];
  });
}

// Inclusive list of { year, month } from `since` through the current UTC month.
function monthsSince(since: string): Array<{ year: number; month: number }> {
  const start = new Date(`${since}T00:00:00Z`);
  const now = new Date();
  const months: Array<{ year: number; month: number }> = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-based
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m + 1 }); // API months are 1-based
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return months;
}

// Sum of already-recorded requests/cents for a member+model in a month,
// excluding the target date (whose row this sync is about to rewrite).
async function recordedMonthSum(
  username: string,
  model: string,
  monthStart: string,
  monthEnd: string,
  excludeDate: string,
): Promise<{ requests: number; amountCents: number }> {
  const [row] = await UsageDaily.aggregate([
    {
      $match: {
        tool: "copilot",
        externalId: username,
        model,
        date: { $gte: monthStart, $lte: monthEnd, $ne: excludeDate },
      },
    },
    {
      $group: {
        _id: null,
        requests: { $sum: { $ifNull: ["$requests", 0] } },
        amountCents: { $sum: { $ifNull: ["$costEstimateCents", 0] } },
      },
    },
  ]);
  return { requests: row?.requests ?? 0, amountCents: row?.amountCents ?? 0 };
}

async function fetchMemberMonth(
  member: CopilotMember,
  token: string,
  year: number,
  month: number,
): Promise<UsageRow[]> {
  const url =
    `https://api.github.com/users/${encodeURIComponent(member.username)}` +
    `/settings/billing/premium_request/usage?year=${year}&month=${month}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "token-forest",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const json = (await res.json()) as PremiumUsageResponse;
  const mm = String(month).padStart(2, "0");
  const monthStart = `${year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  const today = todayUtc();
  // Delta rows land on today while the month is open, or on the month's last
  // day once it has closed.
  const targetDate = monthEnd < today ? monthEnd : today;

  // Our row key is (date, tool, model, externalId): collapse SKUs that share a
  // model so distinct SKUs of one model don't collide on upsert.
  const byModel = new Map<string, { requests: number; amountCents: number }>();
  for (const item of json.usageItems ?? []) {
    const key = item.model ?? "";
    const acc = byModel.get(key) ?? { requests: 0, amountCents: 0 };
    acc.requests += item.grossQuantity ?? 0;
    acc.amountCents += Math.round((item.netAmount ?? 0) * 100);
    byModel.set(key, acc);
  }

  const rows: UsageRow[] = [];
  for (const [model, monthTotal] of byModel) {
    const recorded = await recordedMonthSum(
      member.username,
      model,
      monthStart,
      monthEnd,
      targetDate,
    );
    const requests = Math.max(0, monthTotal.requests - recorded.requests);
    const amountCents = Math.max(
      0,
      monthTotal.amountCents - recorded.amountCents,
    );
    // Nothing new since the last recorded day — don't write an empty row.
    if (requests === 0 && amountCents === 0) continue;
    rows.push({
      date: targetDate,
      tool: "copilot",
      model,
      externalId: member.username,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      requests,
      costEstimateCents: amountCents,
      source: "poller",
      raw: json,
    });
  }
  return rows;
}

async function fetchDaily(since: string): Promise<UsageRow[]> {
  const eligible = await eligibleMembers();
  // No configured members is a valid empty state, not an error.
  if (eligible.length === 0) return [];

  const months = monthsSince(since);
  const rows: UsageRow[] = [];
  const failed: string[] = [];

  for (const member of eligible) {
    let hadError = false;
    let hadSuccess = false;
    let token: string;
    try {
      token = decryptSecret(member.tokenEnc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[copilot] ${member.username}: token decrypt failed — ${msg}`);
      failed.push(member.username);
      continue;
    }
    for (const { year, month } of months) {
      try {
        rows.push(...(await fetchMemberMonth(member, token, year, month)));
        hadSuccess = true;
      } catch (err) {
        hadError = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[copilot] ${member.username} ${year}-${String(month).padStart(2, "0")}: ${msg}`,
        );
      }
    }
    // Counts as failed only if every month errored (e.g. revoked token / 404),
    // not for a transient single-month blip alongside successful months.
    if (hadError && !hadSuccess) failed.push(member.username);
  }

  // One member failing must not abort the rest; only surface a hard error when
  // every eligible member failed entirely.
  if (failed.length === eligible.length) {
    throw new Error(
      `Copilot usage sync failed for all ${eligible.length} member(s): ${failed.join(", ")}`,
    );
  }

  return rows;
}

export const copilotConnector: Connector = {
  tool: "copilot",
  // GitHub's premium-request reporting lags a couple of days; monthly buckets
  // are re-fetched month-to-date, so a small lookback is enough.
  lookbackDays: 3,
  fetchDaily,
};
