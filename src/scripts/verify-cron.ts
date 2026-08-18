// Live assertions for the cross-instance once-only guard (src/lib/cron.ts).
// Needs a MongoDB: MONGODB_URI=mongodb://127.0.0.1:27201/token-meter pnpm verify-cron
// Uses a throwaway key and cleans it up; safe to run against any environment.
import { closeDb } from "@/lib/db";
import { claimOnce, releaseClaim } from "@/lib/cron";

let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failed++;
    console.error(`FAIL ${label}`);
  }
}

async function main(): Promise<void> {
  const key = `__verify_claimOnce__:${Date.now()}`;
  try {
    // First claim wins.
    assert((await claimOnce(key)) === true, "first claim returns true");
    // Second claim on the same key is refused (duplicate key), not thrown.
    assert((await claimOnce(key)) === false, "second claim returns false (deduped)");
    // Concurrent race: many simultaneous claims on a fresh key => exactly one true.
    const raceKey = `${key}:race`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimOnce(raceKey)),
    );
    assert(results.filter(Boolean).length === 1, "concurrent race yields exactly one winner");
    // Release lets the key be claimed again (failed-send retry path).
    await releaseClaim(key);
    assert((await claimOnce(key)) === true, "claim succeeds again after release");

    // Cleanup.
    await releaseClaim(key);
    await releaseClaim(raceKey);
  } finally {
    await closeDb();
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall cron guard assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
