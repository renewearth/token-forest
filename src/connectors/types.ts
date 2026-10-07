import type { UsageHourlyRow, UsageRow } from "@/lib/types";
import type { UsageReportRow, UsageReportSnapshot } from "@/lib/usage-report-types";

// Contract for server-side pollers. One connector per tool with a central API.
// fetchDaily returns daily totals per user (and model where available) for
// every day from `since` (YYYY-MM-DD, inclusive) up to today. Rows are
// upserted, so returning already-synced days again is safe.
export interface Connector {
  tool: string;
  cursorKey?(): string;
  // Reference reports re-read the configured window: newly linked accounts and
  // corrected/late records must not inherit another account's incremental cursor.
  fullReportWindow?: boolean;
  // Days to re-fetch on incremental syncs, to pick up late-arriving data
  // (e.g. Copilot reports lag ~2 days). Default 3.
  lookbackDays?: number;
  fetchDaily(since: string): Promise<UsageRow[]>;
  // Optional hour-grained mirror of fetchDaily, for connectors whose source API
  // can attribute usage to a UTC hour ("YYYY-MM-DDTHH"). sync.ts feeds the
  // result to the additive usage_hourly collection (heatmap only), independent
  // of fetchDaily. Same `since` (YYYY-MM-DD, inclusive) as fetchDaily.
  fetchHourly?(since: string): Promise<UsageHourlyRow[]>;
  // Billing reports remain separate from model-call daily totals.
  fetchReports?(since: string): Promise<UsageReportRow[]>;
  // Complete scope snapshots allow corrections to remove absent rows, including
  // an empty successful day, without inventing zero measurements.
  fetchReportSnapshots?(since: string): Promise<UsageReportSnapshot[]>;
}
