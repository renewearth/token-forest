// Next.js instrumentation hook: starts the in-process schedulers when the
// server boots (dev and standalone/production alike).
export async function register() {
  // Keep Node-only imports inside the runtime branch so the Edge compiler
  // can remove this code, including when schedules are disabled.
  if (process.env.NEXT_RUNTIME === "nodejs") {
  if (process.env.TOKEN_FOREST_DISABLE_CRON === "1") return;

  // Dev hot reload can re-run this module; never double-register the jobs.
  const g = globalThis as { __tokenMeterCron?: boolean };
  if (g.__tokenMeterCron) return;
  g.__tokenMeterCron = true;

  const cron = (await import("node-cron")).default;
  const { runSyncExclusive } = await import("@/scripts/sync");

  // Poll central APIs every hour, on the hour. Incremental with lookback, so
  // each run only re-fetches the last few days. Skips itself if a manual
  // /api/sync run is still in flight.
  cron.schedule("0 * * * *", async () => {
    console.log("[cron] running connector sync");
    await runSyncExclusive().catch((err) =>
      console.error("[cron] sync failed:", err),
    );
  });

  // The weekly Slack report is no longer scheduled (stopped 2026-10-13). The
  // dashboard covers it; `pnpm report` still sends one by hand.

  console.log("[cron] schedulers registered (sync hourly)");
  }
}
