import { z } from "zod";
import type { Connector } from "./types";
import { reportDateSchema, usageReportRowSchema, type UsageReportRow, type UsageReportSnapshot } from "@/lib/usage-report-types";
import { addDays } from "@/lib/date";

const activitySchema = z.object({
  id: z.object({ time: z.string().datetime({ offset: true }), uniqueQualifier: z.string().min(1), applicationName: z.literal("gemini_in_workspace_apps"), customerId: z.string().min(1) }),
  actor: z.object({ email: z.string().optional(), profileId: z.string().optional() }),
  events: z.array(z.object({ name: z.string(), type: z.string().optional(), parameters: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional() })).optional(),
});
const responseSchema = z.object({ items: z.array(activitySchema).optional(), nextPageToken: z.string().optional() });
type Activity = z.infer<typeof activitySchema>;
const ACTIVE = new Set(["active_conversations", "active_generate", "active_summarize", "active_unspecified"]);

export function geminiActivityReports(activities: Activity[], accountId: string, since: string, through: string): UsageReportRow[] {
  const seen = new Set<string>(); const rows = new Map<string, UsageReportRow>();
  for (const raw of activities) {
    const activity = activitySchema.parse(raw);
    if (activity.id.customerId !== accountId) throw new Error("Gemini 보고서 계정 범위 불일치");
    const date = new Date(activity.id.time).toISOString().slice(0, 10);
    if (date < since || date > through) throw new Error("Gemini 보고서 일자 범위 불일치");
    const id = JSON.stringify([activity.id.customerId, activity.id.applicationName, activity.id.time, activity.id.uniqueQualifier]);
    if (seen.has(id)) continue;
    seen.add(id);
    const externalId = activity.actor.email?.toLowerCase() || activity.actor.profileId;
    if (!externalId) throw new Error("Gemini 보고서 사용자 식별자 누락");
    for (const event of activity.events ?? []) {
      if (event.name !== "feature_utilization" || event.type !== "ai_usage_event") continue;
      const params = new Map((event.parameters ?? []).map(p => [p.name, p.value]));
      if (!ACTIVE.has(params.get("event_category") ?? "")) continue;
      const app = params.get("app_name");
      if (!app) throw new Error("Gemini 보고서 앱 구분 누락");
      const product = `gemini_workspace:${app}`;
      const key = JSON.stringify([externalId, date, product]);
      const row = rows.get(key) ?? usageReportRowSchema.parse({ sourceId: "gemini-workspace-activity", accountId, product, externalId, model: "",
        periodStart: date, periodEnd: date, timeZone: "UTC", granularity: "day", coverage: "unknown", metrics: { active_uses: 0 } });
      row.metrics.active_uses! += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

export async function fetchGeminiWorkspaceReports(since: string, options: {
  accountId: string; token: string; fetcher?: typeof fetch; now?: Date;
}): Promise<UsageReportRow[]> {
  reportDateSchema.parse(since);
  if (!options.accountId || !options.token) throw new Error("Gemini Workspace 관리자 연결이 필요합니다");
  const now = options.now ?? new Date();
  const through = now.toISOString().slice(0, 10);
  if (since > through) return [];
  const activities: Activity[] = []; const tokens = new Set<string>(); let pageToken: string | undefined;
  do {
    const url = new URL("https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/gemini_in_workspace_apps");
    url.searchParams.set("customerId", options.accountId);
    url.searchParams.set("startTime", `${since}T00:00:00Z`); url.searchParams.set("endTime", now.toISOString());
    url.searchParams.set("eventName", "feature_utilization"); url.searchParams.set("maxResults", "1000");
    // Select usage metadata only; do not ask for content or IP/network details.
    url.searchParams.set("fields", "nextPageToken,items(id,actor(email,profileId),events(name,type,parameters(name,value)))");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await (options.fetcher ?? fetch)(url, { headers: { Authorization: `Bearer ${options.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Gemini Workspace 보고서 요청 실패 (HTTP ${response.status})`);
    const data = responseSchema.parse(await response.json());
    activities.push(...data.items ?? []);
    if (activities.length > 200_000) throw new Error("Gemini 보고서가 큽니다. 더 짧은 기간으로 조회하세요");
    pageToken = data.nextPageToken;
    if (pageToken) { if (tokens.has(pageToken)) throw new Error("Gemini 페이지 토큰 반복"); tokens.add(pageToken); }
  } while (pageToken);
  return geminiActivityReports(activities, options.accountId, since, through);
}

export const geminiWorkspaceConnector: Connector = {
  tool: "gemini_workspace", lookbackDays: 7,
  fullReportWindow: true,
  cursorKey: () => `gemini_workspace:${process.env.GEMINI_WORKSPACE_CUSTOMER_ID ?? "unset"}`,
  async fetchDaily() { return []; },
  async fetchReports(since) {
    return fetchGeminiWorkspaceReports(since, { accountId: process.env.GEMINI_WORKSPACE_CUSTOMER_ID ?? "", token: process.env.GEMINI_WORKSPACE_ACCESS_TOKEN ?? "" });
  },
  async fetchReportSnapshots(since) {
    const accountId = process.env.GEMINI_WORKSPACE_CUSTOMER_ID ?? "";
    const now = new Date(); const through = now.toISOString().slice(0, 10);
    const rows = await fetchGeminiWorkspaceReports(since, { accountId, token: process.env.GEMINI_WORKSPACE_ACCESS_TOKEN ?? "", now });
    const snapshots: UsageReportSnapshot[] = [];
    for (let day = since; day <= through; day = addDays(day, 1)) snapshots.push({ sourceId: "gemini-workspace-activity", accountId,
      periodStart: day, periodEnd: day, timeZone: "UTC", granularity: "day", coverage: "unknown", partition: "", rows: rows.filter(row => row.periodStart === day) });
    return snapshots;
  },
};
