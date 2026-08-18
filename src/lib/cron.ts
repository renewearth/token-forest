import { connectDb, CronMarker } from "@/lib/db";

// Cross-instance once-only guard for in-process cron jobs.
//
// instrumentation.ts registers the schedulers in every server process, and the
// `globalThis` guard there only dedups within a single process (dev hot
// reload). When several instances run — Coolify replicas, a blue/green deploy
// overlap, or a leftover container — each fires the same schedule, so a job
// with side effects runs N times. That is exactly how the weekly Slack report
// went out 3x.
//
// claimOnce inserts a marker row; the unique index on `key` means exactly one
// caller inserts (returns true) and the rest hit a duplicate-key error (return
// false). Await the model's index build first so the guarantee holds even on
// the brand-new collection's first-ever claims.
export async function claimOnce(key: string): Promise<boolean> {
  await connectDb();
  await CronMarker.init(); // ensure the unique index exists before we race on it
  try {
    await CronMarker.create({ key });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false; // already claimed
    throw err;
  }
}

// Release a claim so a job that failed after claiming can be retried later.
export async function releaseClaim(key: string): Promise<void> {
  await connectDb();
  await CronMarker.deleteOne({ key });
}
