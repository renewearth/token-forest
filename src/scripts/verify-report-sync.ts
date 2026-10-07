import assert from "node:assert/strict";
import { getSyncFreshness } from "@/lib/queries";
import { copilotConnector } from "@/connectors/copilot";
import { runSync } from "./sync";
import { connectDb, closeDb, SyncRun } from "@/lib/db";
import { UsageReport } from "@/lib/db/usage-report";
import { lastRetrySince, lastSyncedDate } from "@/lib/usage";
import type { UsageReportRow, UsageReportSnapshot } from "@/lib/usage-report-types";

async function main() {
  if (!["mongodb://127.0.0.1:27397/tf-v2-test", "mongodb://127.0.0.1:27398/tf-v2-test"].includes(process.env.MONGODB_URI ?? "")) throw new Error("Synthetic collection test database only");
  const key = "synthetic-report-sync";
  const scope = (date: string, rows: UsageReportRow[] = []): UsageReportSnapshot => ({ sourceId: "github-copilot-billing", accountId: "synthetic-sync", periodStart: date, periodEnd: date, timeZone: "UTC", granularity: "day", coverage: "full", partition: "AI credits", rows });
  const row = (day: string): UsageReportRow => ({ sourceId: "github-copilot-billing", accountId: "synthetic-sync", periodStart: day, periodEnd: day, timeZone: "UTC", granularity: "day", coverage: "full", product: "AI credits", model: "synthetic", externalId: "synthetic", metrics: { ai_credits: 2.75 } });
  const original = { ...copilotConnector }; const backfill = process.env.TOKEN_FOREST_BACKFILL_START; let receivedSince = "";
  await connectDb(); await SyncRun.deleteMany({ tool: key }); await UsageReport.deleteMany({ accountId: "synthetic-sync" });
  try {
    process.env.TOKEN_FOREST_BACKFILL_START = "2026-10-01";
    copilotConnector.cursorKey = () => key;
    copilotConnector.fetchDaily = async () => [];
    copilotConnector.fetchReportSnapshots = async since => { receivedSince = since; return [scope("2026-10-01"), scope("2026-10-07", [row("2026-10-07")])]; };
    await runSync({ tool: "copilot", since: "2026-10-01" }); process.exitCode = 0;
    assert.equal(await lastSyncedDate(key), "2026-10-07");
    assert.equal(await lastRetrySince(key), null);
    assert.equal((await SyncRun.findOne({ tool: key }).sort({ _id: -1 }).lean())?.status, "partial");
    assert.equal(await UsageReport.countDocuments({ accountId: "synthetic-sync" }), 2);
    copilotConnector.fetchReportSnapshots = async since => { receivedSince = since; return [scope("2026-10-01", [row("2026-10-01")]), scope("2026-10-07", [row("2026-10-07")])]; };
    await runSync({ tool: "copilot" });
    assert.equal(receivedSince, "2026-10-01");
    assert.equal(await lastSyncedDate(key), "2026-10-07");
    assert.equal(await lastRetrySince(key), null);
    assert.equal((await UsageReport.findOne({ accountId: "synthetic-sync", periodStart: "2026-10-01" }).lean())?.rows.length, 1);
    copilotConnector.fetchReportSnapshots = async since => { receivedSince = since; return [scope("2026-10-01")]; };
    await runSync({ tool: "copilot" });
    assert.equal(receivedSince, "2026-10-01");
    assert.equal((await SyncRun.findOne({ tool: key }).sort({ _id: -1 }).lean())?.status, "empty");
    assert.equal(await lastRetrySince(key), null);
    copilotConnector.fetchReportSnapshots = async () => { throw new Error("synthetic upstream unavailable"); };
    await runSync({ tool: "copilot", since: "2026-09-15" }); process.exitCode = 0;
    assert.equal(await lastRetrySince(key), "2026-09-15");
    const freshness = await getSyncFreshness();
    assert.equal(freshness.some(row => row.tool === key), false);
    assert.ok(freshness.some(row => row.tool === "copilot"));
    console.log("report sync: 14 assertions passed; no vendor requests");
  } finally {
    Object.assign(copilotConnector, original);
    if (backfill === undefined) delete process.env.TOKEN_FOREST_BACKFILL_START; else process.env.TOKEN_FOREST_BACKFILL_START = backfill;
    await SyncRun.deleteMany({ tool: key }); await UsageReport.deleteMany({ accountId: "synthetic-sync" });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeDb);
