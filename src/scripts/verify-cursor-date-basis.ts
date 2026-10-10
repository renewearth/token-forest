import assert from "node:assert/strict";
import { cursorConnector } from "@/connectors/cursor";
import { activityDate } from "@/lib/activity-calendar";

async function main() {
  const previousFetch = globalThis.fetch, previousNow = Date.now;
  const previousKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "synthetic-fixture";
  Date.now = () => Date.parse("2026-10-09T01:00:00Z");
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/teams/daily-usage-data")) return Response.json({ data: [{ day: "2026-10-08", email: "fixture@example.test", agentRequests: 1, isActive: true }] });
    if (url.endsWith("/teams/filtered-usage-events")) return Response.json({ usageEvents: [{ timestamp: String(Date.parse("2026-10-08T16:00:00Z")), userEmail: "fixture@example.test", model: "fixture", isTokenBasedCall: true, tokenUsage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 2, totalCents: 23 } }], pagination: { hasNextPage: false } });
    throw Error("Unexpected external call in fixture");
  };
  try {
    const daily = await cursorConnector.fetchDaily("2026-10-08");
    assert.equal(daily.length, 2); assert(daily.every(r => r.dateBasis === "UTC"));
    assert.equal(daily.find(r => !r.model)?.requests, 1); assert.equal(daily.find(r => r.model)?.inputTokens, 4);
    console.log("PASS actual Cursor daily connector declares UTC and preserves amounts");
    const hourly = await cursorConnector.fetchHourly!("2026-10-08");
    assert.equal(hourly.length, 1); assert.equal(hourly[0].dateBasis, "UTC"); assert.equal(hourly[0].hour, "2026-10-08T16");
    assert.equal(activityDate({ memberId: "fixture", date: "2026-10-08", ...hourly[0], dateBasis: "UTC", positive: true }), "2026-10-09");
    console.log("PASS actual Cursor hourly connector resolves Korean activity date");
    console.log("2 Cursor date contract checks passed");
  } finally {
    globalThis.fetch = previousFetch; Date.now = previousNow;
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previousKey;
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
