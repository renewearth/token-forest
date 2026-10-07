// compare-sessions-legacy: diff numbers on a seeded scenario.
//   MONGODB_URI=mongodb://127.0.0.1:27391/tf-v2-test ./node_modules/.bin/tsx src/scripts/verify-compare-sessions-legacy.ts
// Guard: aborts unless the database name starts with "tf-v2-test". Only docs
// tied to the unique test email / externalId are created and removed.
import "./env";
import { execFileSync } from "node:child_process";
import mongoose from "mongoose";
import {
  closeDb,
  connectDb,
  Member,
  MemberIdentity,
  UsageDaily,
  UsageDailyLegacy,
  UsageSession,
} from "@/lib/db";
import { compareForMember } from "./compare-sessions-legacy";

let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    fail++;
    console.error(`FAIL: ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const RUN = `${Date.now()}`;
const EMAIL = `cmp-${RUN}@verify.invalid`;
const EXT = `cmp-ext-${RUN}`;
const A = "dev_00000000000a";
const B = "dev_00000000000b";

const sess = (over: Record<string, unknown>) => ({
  externalId: EXT,
  tool: "claude_code",
  model: "m",
  provider: "",
  parserVersion: 2,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests: 0,
  ...over,
});

async function cleanup(memberId?: unknown) {
  await Promise.all([
    UsageSession.deleteMany({ externalId: EXT }),
    UsageDaily.deleteMany({ externalId: EXT }),
    UsageDailyLegacy.deleteMany({ externalId: EXT }),
    memberId ? MemberIdentity.deleteMany({ memberId }) : Promise.resolve(),
    Member.deleteMany({ email: EMAIL }),
  ]);
}

async function main() {
  await connectDb();
  const name = mongoose.connection.name;
  if (!name.startsWith("tf-v2-test")) {
    console.error(`ABORT: database "${name}" does not start with tf-v2-test`);
    await closeDb();
    process.exit(2);
  }
  const member = await Member.create({ name: "cmp", email: EMAIL });
  await MemberIdentity.create({ memberId: member._id, tool: "claude_code", externalId: EXT });
  try {
    await UsageSession.insertMany([
      // duplicated session seen by both machines: counts once in the total
      sess({ sessionId: "claude_code:S1", hour: "2026-09-28T10", date: "2026-09-28", inputTokens: 100, outputTokens: 10, requests: 2, machineIds: [A, B] }),
      // machine A only
      sess({ sessionId: "claude_code:S2", hour: "2026-09-28T11", date: "2026-09-28", inputTokens: 50, cacheReadTokens: 7, requests: 1, machineIds: [A] }),
      // machine B, other day
      sess({ sessionId: "claude_code:S3", hour: "2026-09-29T09", date: "2026-09-29", inputTokens: 30, cacheCreationTokens: 3, requests: 1, machineIds: [B] }),
    ]);
    // legacy (diverted) v1 row for machine A on 09-28
    await UsageDailyLegacy.create({
      date: "2026-09-28", tool: "claude_code", model: "m", externalId: EXT, machineId: A,
      memberId: member._id, inputTokens: 120, outputTokens: 10, cacheReadTokens: 7,
      cacheCreationTokens: null, requests: 3, source: "uploader", divertedAt: new Date(),
    });
    // remaining v1 row, other tool, not covered by sessions
    await UsageDaily.create({
      date: "2026-09-27", tool: "codex", model: "m", externalId: EXT, machineId: "host-x",
      memberId: member._id, inputTokens: 40, outputTokens: 4, source: "uploader",
    });
    // derived row must be ignored
    await UsageDaily.create({
      date: "2026-09-28", tool: "claude_code", model: "m", externalId: EXT, machineId: "sessions",
      memberId: member._id, inputTokens: 999, source: "uploader",
    });

    const c = await compareForMember(EMAIL);
    const get = (tool: string, machine: string, date: string) =>
      c.rows.find((r) => r.tool === tool && r.machine === machine && r.date === date);

    const t28 = get("claude_code", "*", "2026-09-28");
    check("total 09-28 sessions counted once", t28?.sessions.inputTokens === 150 && t28.sessions.requests === 3, t28);
    check("total 09-28 legacy", t28?.legacy.inputTokens === 120 && t28.legacy.requests === 3, t28);
    check("total 09-28 diff", t28?.diff.inputTokens === 30 && t28.diff.outputTokens === 0 && t28.diff.cacheReadTokens === 0 && t28.diff.requests === 0, t28);

    const a28 = get("claude_code", A, "2026-09-28");
    check("machine A 09-28 sessions incl. dup", a28?.sessions.inputTokens === 150, a28);
    check("machine A 09-28 diff", a28?.diff.inputTokens === 30, a28);
    const b28 = get("claude_code", B, "2026-09-28");
    check("machine B 09-28 gets duplicate", b28?.sessions.inputTokens === 100 && b28.legacy.inputTokens === 0, b28);

    const t29 = get("claude_code", "*", "2026-09-29");
    check("09-29 sessions-only", t29?.diff.inputTokens === 30 && t29.diff.cacheCreationTokens === 3, t29);

    const cx = get("codex", "host-x", "2026-09-27");
    check("remaining v1 row is legacy", cx?.legacy.inputTokens === 40 && cx.diff.inputTokens === -40, cx);

    const s = c.summary.find((x) => x.tool === "claude_code");
    check("summary claude_code diff", s?.diff.inputTokens === 60 && s.sessions.inputTokens === 180 && s.legacy.inputTokens === 120, s);
    const sx = c.summary.find((x) => x.tool === "codex");
    check("summary codex diff", sx?.diff.inputTokens === -40, sx);
    check("derived sessions row ignored", !c.rows.some((r) => r.machine === "sessions"), c.rows.map((r) => r.machine));

    let threw = false;
    try {
      await compareForMember(`nobody-${RUN}@verify.invalid`);
    } catch {
      threw = true;
    }
    check("unknown member throws", threw);
    // mixed-case / padded input still finds the member
    const c2 = await compareForMember(`  ${EMAIL.toUpperCase()} `.replace(/^ +/, " ")).catch(() => null);
    check("email normalized (lowercase fallback)", c2 !== null && c2.rows.length === c.rows.length);

    // Read-only: the script must not create collections in an empty DB.
    const emptyName = `tf-v2-test-cmp-${RUN}`;
    const base = (process.env.MONGODB_URI ?? "").replace(/\/[^/?]*(\?.*)?$/, "");
    const conn = await mongoose.createConnection(`${base}/${emptyName}`).asPromise();
    try {
      const before = (await conn.db!.listCollections().toArray()).map((x) => x.name);
      try {
        execFileSync(
          "./node_modules/.bin/tsx",
          ["src/scripts/compare-sessions-legacy.ts", "--member", "nobody@verify.invalid", "--no-wait"],
          { env: { ...process.env, MONGODB_URI: `${base}/${emptyName}` }, stdio: "pipe" },
        );
      } catch {
        // exits 1: no such member — expected
      }
      await new Promise((r) => setTimeout(r, 500));
      const after = (await conn.db!.listCollections().toArray()).map((x) => x.name);
      check("no collections created in empty db", before.length === 0 && after.length === 0, { before, after });
    } finally {
      await conn.dropDatabase();
      await conn.close();
    }
  } finally {
    await cleanup(member._id);
  }
  await closeDb();
  if (fail > 0) {
    console.error(`${fail} FAILED`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
