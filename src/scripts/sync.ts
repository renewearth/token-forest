import "@/scripts/env";
import { basename } from "node:path";
// Run server-side poller connectors.
//
//   pnpm sync                        # all connectors, incremental (with lookback)
//   pnpm sync --tool cursor          # one connector
//   pnpm sync --since 2026-07-01     # backfill from a date
import { allConnectors, connectorFor } from "@/connectors";
import { addDays, isoDaysAgo } from "@/lib/date";
import { upsertUsageReports, upsertUsageReportSnapshots } from "@/lib/usage-reports";
import {
  autoClaimEmailIdentities,
  lastSyncedDate,
  lastRetrySince,
  recordSyncRun,
  upsertHourlyRows,
  upsertUsageRows,
} from "@/lib/usage";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function runSync(opts: { tool?: string; since?: string } = {}) {
  const targets = opts.tool
    ? [connectorFor(opts.tool) ?? fail(`unknown tool: ${opts.tool}`)]
    : allConnectors();
  if (targets.length === 0) {
    console.log("no connectors registered");
    return;
  }
  for (const connector of targets) {
    const lookback = connector.lookbackDays ?? 3;
    // Resume from the stored cursor minus `lookback` days (re-fetching recent
    // days absorbs late-arriving data). Resuming from the cursor — not from
    // a fixed lookback window — means an outage longer than the lookback
    // still backfills instead of leaving a gap. A connector's FIRST run
    // backfills from TOKEN_FOREST_BACKFILL_START (team-wide tracking epoch,
    // e.g. 2026-06-01) or 30 days when unset.
    const cursorKey = connector.cursorKey?.() ?? connector.tool;
    const [cursor, retrySince] = await Promise.all([lastSyncedDate(cursorKey), lastRetrySince(cursorKey)]);
    const firstRunSince =
      process.env.TOKEN_FOREST_BACKFILL_START ?? isoDaysAgo(30);
    const since =
      opts.since ?? retrySince ?? (connector.fullReportWindow ? firstRunSince : cursor ? addDays(cursor, -lookback) : firstRunSince);
    try {
      const rows = await connector.fetchDaily(since);
      if (rows.length === 0 && !connector.fetchReports && !connector.fetchReportSnapshots) {
        throw new Error("No usage rows returned; usage and freshness remain unknown");
      }
      await upsertUsageRows(rows);
      // Account billing reports are a separate store. In particular, Copilot
      // credits and premium requests must not enter UsageDaily.requests.
      let reportNote = "";
      let reportMaxDate = "";
      let reportCheckedDate = "";
      let emptyScopeCount = 0;
      if (connector.fetchReports || connector.fetchReportSnapshots) {
        const snapshots = connector.fetchReportSnapshots ? await connector.fetchReportSnapshots(since) : null;
        const reports = snapshots ? snapshots.flatMap(snapshot => snapshot.rows) : await connector.fetchReports!(since);
        if (snapshots) await upsertUsageReportSnapshots(snapshots);
        else await upsertUsageReports(reports);
        emptyScopeCount = snapshots?.filter(snapshot => snapshot.rows.length === 0).length ?? 0;
        reportCheckedDate = snapshots?.reduce((max, snapshot) => snapshot.periodEnd > max ? snapshot.periodEnd : max, "") ?? "";
        if (reports.length === 0) {
          await recordSyncRun(cursorKey, "empty", { connectorTool: connector.tool, emptyScopeCount, lastCheckedDate: reportCheckedDate || undefined,
            message: "No usage measurements returned; no zero usage or complete coverage inferred" });
          console.log(`${connector.tool}: checked report window; no measurements (${emptyScopeCount} empty scopes)`);
          continue;
        }
        reportMaxDate = reports.reduce(
          (acc, report) => report.periodEnd > acc ? report.periodEnd : acc, "",
        );
        reportNote = `, ${reports.length} report rows`;
      }
      // Hour-grained mirror, if this connector can attribute usage to an hour.
      // It feeds the additive usage_hourly collection only; the incremental
      // cursor stays driven by the daily rows below. A failure here must not
      // fail the run — the daily rows above already landed, and hourly data is
      // supplementary (heatmap only).
      let hourlyNote = "";
      if (connector.fetchHourly) {
        try {
          const hourlyRows = await connector.fetchHourly(since);
          const { upserted } = await upsertHourlyRows(hourlyRows);
          hourlyNote = `, ${hourlyRows.length} hourly rows (${upserted} written)`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`${connector.tool}: hourly mirror failed (daily OK) — ${msg}`);
          hourlyNote = ", hourly mirror failed (see warning)";
        }
      }
      // Advance the cursor only to the newest day the connector actually
      // returned — central APIs lag, and stamping "today" would misreport
      // freshness and skip the lagged days on the next incremental run.
      const maxDate = rows.reduce(
        (acc, r) => (r.date > acc ? r.date : acc),
        "",
      );
      const synced = [maxDate, reportMaxDate, cursor ?? ""].sort().at(-1) ?? "";
      await recordSyncRun(cursorKey, emptyScopeCount ? "partial" : "ok", { connectorTool: connector.tool, lastSyncedDate: synced || undefined,
        lastCheckedDate: reportCheckedDate || undefined, emptyScopeCount,
        ...(emptyScopeCount ? { message: "Some source scopes returned no measurements; no zero usage inferred" } : {}) });
      console.log(
        `${connector.tool}: upserted ${rows.length} rows${reportNote}${hourlyNote} (since ${since}, through ${synced || "no reported day"})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordSyncRun(cursorKey, "error", { connectorTool: connector.tool, message, retrySince: since });
      console.error(`${connector.tool}: FAILED — ${message}`);
      process.exitCode = 1;
    }
  }
  // New rows may belong to a registered email that had no usage before.
  try {
    const claimed = await autoClaimEmailIdentities();
    if (claimed > 0) console.log(`auto-claimed ${claimed} email-matching identit(y/ies)`);
  } catch (err) {
    console.warn("auto-claim failed (sync itself OK):", err);
  }
}

// Single-flight guard shared by the in-process cron and POST /api/sync (both
// live in the same server process). A second caller while a sync is running
// gets {started:false} instead of a concurrent run hammering the vendor APIs.
let syncing: Promise<void> | null = null;

export function isSyncing(): boolean {
  return syncing !== null;
}

export async function runSyncExclusive(): Promise<{ started: boolean }> {
  if (syncing) return { started: false };
  syncing = runSync().finally(() => {
    syncing = null;
  });
  await syncing;
  return { started: true };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Only run when invoked directly (pnpm sync), not when imported by the cron worker.
if (process.argv[1] && basename(process.argv[1]) === "sync.ts") {
  import("@/lib/db").then(({ closeDb }) =>
    runSync({ tool: arg("tool"), since: arg("since") }).finally(() => closeDb()),
  );
}
