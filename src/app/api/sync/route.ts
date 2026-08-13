import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { isSyncing, runSyncExclusive } from "@/scripts/sync";

// Manual "sync now" for the poller connectors (cursor/copilot),
// triggered by the dashboard button. Claude Code usage and plan limits can
// NOT be refreshed here — that data lives on member machines and is pushed
// by their uploader (hourly cron + SessionEnd hook).
//
// Any member may trigger it: the sync is an idempotent upsert, and the
// single-flight lock plus cooldown below keep vendor APIs from being
// hammered. No admin role exists in this app.

const COOLDOWN_MS = 5 * 60 * 1000;
let lastFinishedAt = 0;

export async function POST() {
  const viewer = await getViewer();
  if (viewer.status !== "member") {
    return NextResponse.json({ error: "member only" }, { status: 401 });
  }
  if (isSyncing()) {
    return NextResponse.json({ error: "sync already running" }, { status: 409 });
  }
  const elapsed = Date.now() - lastFinishedAt;
  if (elapsed < COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return NextResponse.json(
      { error: "cooldown", retryAfterSec },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
    );
  }
  const { started } = await runSyncExclusive();
  if (started) lastFinishedAt = Date.now();
  // started=false: the cron beat us to it between the check and the call —
  // its run covers this request, so report success either way.
  return NextResponse.json({ ok: true });
}
