import type { Connector } from "./types";
import type { UsageRow } from "@/lib/types";
import type { UsageReportRow, UsageReportSnapshot } from "@/lib/usage-report-types";
import { reportDateSchema, usageReportRowSchema } from "@/lib/usage-report-types";
import { connectDb, Member, MemberIdentity } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { addDays, todayUtc } from "@/lib/date";

// Billing is attributed to the account in the URL. Organization seats do not
// appear in personal billing reports, so exactly one scope is selected.
// https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10
const API_VERSION = "2026-03-10";
export type CopilotBillingMode = "ai_credits" | "premium_requests";
export type CopilotBillingScope = "personal" | "organization";
export type CopilotBillingAccount = { kind: "user" | "organization"; name: string; token: string };
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function copilotBillingMode(value: string | undefined): CopilotBillingMode {
  if (value === "ai_credits" || value === "premium_requests") return value;
  throw new Error("COPILOT_BILLING_MODE must be ai_credits or premium_requests");
}

export function copilotBillingScope(value: string | undefined): CopilotBillingScope {
  if (value === "personal" || value === "organization") return value;
  throw new Error("COPILOT_BILLING_SCOPE must be personal or organization");
}

export function selectCopilotBillingAccounts(
  scope: CopilotBillingScope,
  personal: CopilotBillingAccount[],
  organization?: CopilotBillingAccount,
): CopilotBillingAccount[] {
  const selected = scope === "personal" ? personal : organization ? [organization] : [];
  const kind = scope === "personal" ? "user" : "organization";
  if (selected.some(account => account.kind !== kind)) {
    throw new Error("Copilot billing account does not match selected scope");
  }
  if (!selected.length) throw new Error(`Copilot billing has no configured ${scope} account`);
  const seen = new Set<string>();
  return selected.filter(account => {
    const key = account.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function copilotReportDays(since: string, through = todayUtc()): string[] {
  if (!reportDateSchema.safeParse(since).success || !reportDateSchema.safeParse(through).success) {
    throw new Error("Copilot billing dates must be YYYY-MM-DD UTC dates");
  }
  if (since > through) return [];
  const days: string[] = [];
  for (let day = since; day <= through; day = addDays(day, 1)) days.push(day);
  return days;
}

export function copilotBillingUrl(account: Pick<CopilotBillingAccount, "kind" | "name">, day: string, mode: CopilotBillingMode): string {
  if (!GITHUB_LOGIN.test(account.name) || !reportDateSchema.safeParse(day).success) {
    throw new Error("Invalid Copilot billing account or date");
  }
  const scope = account.kind === "organization" ? `organizations/${account.name}` : `users/${account.name}`;
  const unit = mode === "ai_credits" ? "ai_credit" : "premium_request";
  const params = new URLSearchParams({ year: day.slice(0, 4), month: String(Number(day.slice(5, 7))), day: String(Number(day.slice(8, 10))) });
  return `https://api.github.com/${scope}/settings/billing/${unit}/usage?${params}`;
}

type BillingItem = {
  product?: unknown; sku?: unknown; model?: unknown; unitType?: unknown;
  grossQuantity?: unknown; netAmount?: unknown;
};

// The endpoint's day filter supplies the day for its aggregate items. Credits
// and legacy premium requests are billing units, never model-call counts.
export function copilotRowsForDay(
  payload: unknown,
  account: Pick<CopilotBillingAccount, "kind" | "name">,
  day: string,
  mode: CopilotBillingMode,
): UsageReportRow[] {
  if (!reportDateSchema.safeParse(day).success || typeof payload !== "object" || payload === null) {
    throw new Error("Invalid Copilot billing response");
  }
  const report = payload as { timePeriod?: { year?: unknown; month?: unknown; day?: unknown }; usageItems?: unknown };
  if (!Array.isArray(report.usageItems)) throw new Error("Invalid Copilot billing response");
  const period = report.timePeriod;
  if (period && ((period.year !== undefined && period.year !== Number(day.slice(0, 4))) ||
    (period.month !== undefined && period.month !== Number(day.slice(5, 7))) ||
    (period.day !== undefined && period.day !== Number(day.slice(8, 10))))) {
    throw new Error("Copilot billing response period differs from requested day");
  }
  const allowedUnits = mode === "ai_credits" ? ["credits", "ai-credits"] : ["requests"];
  const grouped = new Map<string, { quantity: number; cost: number }>();
  for (const raw of report.usageItems as BillingItem[]) {
    if (typeof raw !== "object" || raw === null ||
      typeof raw.product !== "string" || typeof raw.sku !== "string" ||
      (!/copilot/i.test(`${raw.product} ${raw.sku}`) && !(mode === "ai_credits" && raw.sku === "AI Credit")) ||
      !allowedUnits.includes(String(raw.unitType)) ||
      typeof raw.grossQuantity !== "number" || !Number.isFinite(raw.grossQuantity) || raw.grossQuantity < 0 ||
      typeof raw.netAmount !== "number" || !Number.isFinite(raw.netAmount) || raw.netAmount < 0 ||
      (raw.model !== undefined && typeof raw.model !== "string")) {
      throw new Error("Invalid Copilot billing item or billing unit");
    }
    const model = typeof raw.model === "string" ? raw.model : "";
    const current = grouped.get(model) ?? { quantity: 0, cost: 0 };
    current.quantity += raw.grossQuantity;
    current.cost += raw.netAmount;
    grouped.set(model, current);
  }
  const product = mode === "ai_credits" ? "GitHub Copilot AI credits" : "GitHub Copilot premium requests";
  const accountId = `github:${account.kind}:${account.name.toLowerCase()}`;
  const externalId = account.kind === "organization" ? `org:${account.name}` : account.name;
  return [...grouped].map(([model, values]) => usageReportRowSchema.parse({
    sourceId: "github-copilot-billing", accountId, product, externalId, model,
    periodStart: day, periodEnd: day, timeZone: "UTC", granularity: "day", coverage: "full",
    metrics: mode === "ai_credits"
      ? { ai_credits: values.quantity, net_cost_usd: values.cost }
      : { premium_requests: values.quantity, net_cost_usd: values.cost },
  }));
}

export async function collectCopilotReportSnapshots(
  accounts: CopilotBillingAccount[],
  days: string[],
  mode: CopilotBillingMode,
  request: typeof fetch = fetch,
): Promise<UsageReportSnapshot[]> {
  const snapshots: UsageReportSnapshot[] = [];
  let failures = 0;
  for (const account of accounts) {
    for (const day of days) {
      try {
        const response = await request(copilotBillingUrl(account, day, mode), {
          headers: {
            Authorization: `Bearer ${account.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "token-forest",
          },
          signal: AbortSignal.timeout(20_000),
        });
        // Never read error bodies: upstream responses can contain sensitive data.
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rows = copilotRowsForDay(await response.json(), account, day, mode);
        snapshots.push({ sourceId: "github-copilot-billing", accountId: `github:${account.kind}:${account.name.toLowerCase()}`,
          periodStart: day, periodEnd: day, timeZone: "UTC", granularity: "day", coverage: "full",
          partition: mode === "ai_credits" ? "GitHub Copilot AI credits" : "GitHub Copilot premium requests", rows });
      } catch {
        failures++;
      }
    }
  }
  // Do not return partial rows. A later run retries the entire window safely.
  if (failures) throw new Error(`Copilot billing fetch failed for ${failures} account/day request(s); retry after checking credentials and GitHub availability`);
  return snapshots;
}

export async function collectCopilotReports(accounts: CopilotBillingAccount[], days: string[], mode: CopilotBillingMode, request: typeof fetch = fetch): Promise<UsageReportRow[]> {
  return (await collectCopilotReportSnapshots(accounts, days, mode, request)).flatMap(snapshot => snapshot.rows);
}

async function configuredAccounts(scope: CopilotBillingScope): Promise<CopilotBillingAccount[]> {
  if (scope === "organization") {
    const org = process.env.COPILOT_BILLING_ORG;
    const token = process.env.COPILOT_BILLING_ORG_TOKEN;
    if (!org || !token || !GITHUB_LOGIN.test(org)) {
      throw new Error("Set COPILOT_BILLING_ORG and COPILOT_BILLING_ORG_TOKEN for organization billing");
    }
    // No member lookup or personal PAT decryption in organization mode.
    return selectCopilotBillingAccounts(scope, [], { kind: "organization", name: org, token });
  }
  await connectDb();
  const identities = await MemberIdentity.find({ tool: "copilot" }).lean();
  const members = new Map((await Member.find({ githubTokenEnc: { $ne: null } }).lean())
    .map(member => [String(member._id), member]));
  const accounts: CopilotBillingAccount[] = [];
  for (const identity of identities) {
    if (!GITHUB_LOGIN.test(identity.externalId)) continue;
    const encrypted = members.get(String(identity.memberId))?.githubTokenEnc;
    if (!encrypted) continue;
    try {
      accounts.push({ kind: "user", name: identity.externalId, token: decryptSecret(encrypted) });
    } catch {
      throw new Error("Copilot billing token could not be decrypted; check member credentials");
    }
  }
  // Organization env credentials are ignored in personal mode.
  return selectCopilotBillingAccounts(scope, accounts);
}

async function fetchReports(since: string): Promise<UsageReportRow[]> {
  const mode = copilotBillingMode(process.env.COPILOT_BILLING_MODE);
  const scope = copilotBillingScope(process.env.COPILOT_BILLING_SCOPE);
  const days = copilotReportDays(since);
  if (!days.length) return [];
  return collectCopilotReports(await configuredAccounts(scope), days, mode);
}

async function fetchReportSnapshots(since: string): Promise<UsageReportSnapshot[]> {
  const mode = copilotBillingMode(process.env.COPILOT_BILLING_MODE);
  const scope = copilotBillingScope(process.env.COPILOT_BILLING_SCOPE);
  const days = copilotReportDays(since);
  if (!days.length) return [];
  return collectCopilotReportSnapshots(await configuredAccounts(scope), days, mode);
}

export const copilotConnector: Connector = {
  tool: "copilot",
  fullReportWindow: true,
  cursorKey: () => `copilot:${process.env.COPILOT_BILLING_SCOPE ?? "unset"}:${process.env.COPILOT_BILLING_MODE ?? "unset"}:${process.env.COPILOT_BILLING_SCOPE === "organization" ? process.env.COPILOT_BILLING_ORG ?? "unset" : "members"}`,
  lookbackDays: 7,
  fetchDaily: async (): Promise<UsageRow[]> => [],
  fetchReports,
  fetchReportSnapshots,
};
