// getMyMachines v2 (collection v2 Task 6): v2 Device docs + legacy uploader
// machines, freshness, labels, parser warnings, per-device session tokens.
//
// Needs a DISPOSABLE MongoDB:
//   MONGODB_URI=mongodb://127.0.0.1:27391/tf-v2-test ./node_modules/.bin/tsx src/scripts/verify-machines.ts
// Safety guard: aborts unless the database name starts with "tf-v2-test".
// Cleans ONLY documents of its own test identities (externalId ending
// "@machines.test"). Do not run concurrently with verify-sessions.ts (that
// script wipes the usage collections).
import "./env";
import mongoose from "mongoose";
import {
  closeDb,
  connectDb,
  Device,
  UsageDaily,
  UsageDailyLegacy,
  UsageSession,
  type DeviceHealthEntry,
} from "@/lib/db";
import { toolLabel } from "@/app/_lib/ui";
import { addDays, kstDate } from "@/lib/date";
import { parserWarningText } from "@/lib/device-health";
import { getMyMachines, type MachineStatus } from "@/lib/queries";
import { DERIVED_MACHINE_ID } from "@/lib/sessions";

const DOMAIN = "@machines.test";
const OWN = { externalId: { $regex: `${DOMAIN.replace(/[.]/g, "\\.")}$` } };

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

function dbNameFromUri(uri: string): string {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  return m ? decodeURIComponent(m[1]) : "";
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-09-30 01:30 KST — early KST morning, so KST and UTC dates differ.
const NOW = new Date("2026-09-29T16:30:00Z");
const TODAY = kstDate(NOW.getTime()); // 2026-09-30
const YESTERDAY = addDays(TODAY, -1);
const SINCE = kstDate(NOW.getTime() - 14 * DAY); // first date counted as "recent"

const A = "0a0a0a0a-0000-4000-8000-00000000000a"; // v2, fresh, labelled
const B = "0b0b0b0b-0000-4000-8000-00000000000b"; // v2, 25h ago, unlabelled
const C = "dev_cccccccccccc"; // legacy uploader machine

function health(
  parser: string,
  filesScanned: number,
  linesUnrecognized: number,
  sessionsEmitted: number,
  at: Date,
  error: string | null = null,
): DeviceHealthEntry {
  return { parser, filesScanned, linesUnrecognized, sessionsEmitted, error, at };
}

function session(
  externalId: string,
  sessionId: string,
  date: string,
  machineIds: string[],
  tokens: { input: number; output: number; cache?: number; requests?: number },
  tool = "claude_code",
) {
  return {
    externalId,
    memberId: null,
    tool,
    sessionId,
    hour: `${date}T10`,
    date,
    model: "claude-opus-5",
    provider: "",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cache ?? 0,
    cacheCreationTokens: 0,
    requests: tokens.requests ?? 0,
    parserVersion: 1,
    machineIds,
  };
}

function daily(
  externalId: string,
  machineId: string,
  date: string,
  over: Record<string, unknown> = {},
) {
  return {
    date,
    tool: "claude_code",
    model: "claude-opus-5",
    externalId,
    machineId,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 999_999,
    cacheCreationTokens: 0,
    requests: 3,
    sessions: 1,
    source: "uploader",
    ...over,
  };
}

async function cleanup() {
  await Promise.all([
    Device.deleteMany(OWN),
    UsageSession.deleteMany(OWN),
    UsageDaily.deleteMany(OWN),
    UsageDailyLegacy.deleteMany(OWN),
  ]);
}

const byId = (list: MachineStatus[], id: string) => list.find((m) => m.machineId === id);

async function main() {
  const uri = process.env.MONGODB_URI ?? "";
  const dbName = dbNameFromUri(uri);
  if (!dbName.startsWith("tf-v2-test")) {
    console.error(`refusing to run: database "${dbName}" is not a tf-v2-test* database`);
    process.exit(2);
  }
  await connectDb();
  if (!mongoose.connection.name.startsWith("tf-v2-test")) {
    console.error(`refusing to run: connected to "${mongoose.connection.name}"`);
    process.exit(2);
  }
  await cleanup();
  await Promise.all([
    UsageDaily.syncIndexes(),
    UsageDailyLegacy.syncIndexes(),
    UsageSession.syncIndexes(),
  ]);

  // ---------------------------------------------------------------------------
  // Scenario 1 (brief step 1): 2 Devices (one 25h ago) + 1 legacy machine.
  const m1 = `one${DOMAIN}`;
  await Device.create([
    {
      externalId: m1,
      machineId: A,
      label: "맥북",
      uploaderVersion: "2.0.0",
      lastSeenAt: new Date(NOW.getTime() - HOUR),
      // codex: files at baseline but 0 sessions → rule 1 warning;
      // opencode: skipped with an error → secondary line.
      health: [
        health("claude_code", 40, 0, 6, new Date(NOW.getTime() - HOUR)),
        health("codex", 10, 0, 0, new Date(NOW.getTime() - HOUR)),
        health("opencode", 0, 0, 0, new Date(NOW.getTime() - HOUR), "database is locked"),
      ],
      healthHistory: [
        health("claude_code", 40, 0, 6, new Date(NOW.getTime() - 25 * HOUR)),
        health("codex", 10, 0, 5, new Date(NOW.getTime() - 25 * HOUR)),
        health("codex", 10, 0, 0, new Date(NOW.getTime() - HOUR)),
      ],
    },
    {
      externalId: m1,
      machineId: B,
      label: null,
      uploaderVersion: "2.0.0",
      lastSeenAt: new Date(NOW.getTime() - 25 * HOUR),
      // gemini: unrecognized lines 2 → 10 (rule 2 warning).
      health: [health("gemini", 5, 10, 3, new Date(NOW.getTime() - 25 * HOUR))],
      healthHistory: [health("gemini", 5, 2, 3, new Date(NOW.getTime() - 40 * HOUR))],
    },
  ]);
  await UsageSession.create([
    // Only A saw it.
    session(m1, "s-a", TODAY, [A], { input: 1000, output: 100, cache: 50_000, requests: 4 }),
    // Replicated session seen by both → shown on both devices.
    session(m1, "s-ab", YESTERDAY, [A, B], { input: 300, output: 30, requests: 2 }),
    // First "recent" date counts; the day before does not.
    session(m1, "s-b-edge", SINCE, [B], { input: 7, output: 3, requests: 1 }),
    session(m1, "s-b-old", addDays(SINCE, -1), [B], { input: 5000, output: 500, requests: 9 }),
    // Another tool counts too.
    session(m1, "s-a-codex", TODAY, [A], { input: 11, output: 1, requests: 1 }, "codex"),
    // Another member's session on the same machineId never counts.
    session(`other${DOMAIN}`, "s-x", TODAY, [A], { input: 9e6, output: 9e6, requests: 99 }),
  ]);
  await UsageDaily.create([
    // Legacy machine C: last row 2 days ago (older than yesterday) → stale.
    daily(m1, C, addDays(TODAY, -2)),
    daily(m1, C, addDays(TODAY, -3), { tool: "codex", model: "gpt-5" }),
    // Derived rows are not a device.
    daily(m1, DERIVED_MACHINE_ID, TODAY, { inputTokens: 1300 }),
    // Poller rows are not an uploader device.
    daily(m1, "", TODAY, { source: "poller" }),
  ]);

  const one = await getMyMachines(m1, NOW);
  check("scenario 1: 3 machines", one.length === 3, one);
  check(
    "derived 'sessions' row excluded",
    !one.some((m) => m.machineId === DERIVED_MACHINE_ID),
    one,
  );
  check("poller '' row excluded", !one.some((m) => m.machineId === ""), one);

  const a = byId(one, A);
  const b = byId(one, B);
  const c = byId(one, C);
  check("A: v2", a?.format === "v2", a);
  check("A: label shown", a?.label === "맥북", a);
  check(
    "A: lastSeenAt ISO",
    a?.lastSeenAt === new Date(NOW.getTime() - HOUR).toISOString(),
    a,
  );
  check("A: not stale (1h)", a?.stale === false, a);
  check("A: tokens = own + shared session, input+output only", a?.recentTokens === 1100 + 330 + 12, a);
  check("A: requests", a?.recentRequests === 4 + 2 + 1, a);
  check("A: lastDate = latest session date (KST)", a?.lastDate === TODAY, a);
  check("A: codex warning", JSON.stringify(a?.parserWarnings) === JSON.stringify([parserWarningText("Codex")]), a);
  check("A: opencode error line", JSON.stringify(a?.parserErrors) === JSON.stringify([`${toolLabel("opencode")}: database is locked`]), a);

  check("B: v2", b?.format === "v2", b);
  check("B: no label → null", b?.label === null, b);
  check("B: stale (25h)", b?.stale === true, b);
  check("B: tokens = shared + edge date, not the pre-window one", b?.recentTokens === 330 + 10, b);
  check("B: requests", b?.recentRequests === 2 + 1, b);
  check("B: lastDate", b?.lastDate === YESTERDAY, b);
  check("B: gemini warning", JSON.stringify(b?.parserWarnings) === JSON.stringify([parserWarningText("Gemini")]), b);
  check("B: no errors", JSON.stringify(b?.parserErrors) === "[]", b);

  check("C: legacy", c?.format === "legacy", c);
  check("C: no label, no lastSeenAt", c?.label === null && c?.lastSeenAt === null, c);
  check("C: lastDate = latest uploader row (any tool)", c?.lastDate === addDays(TODAY, -2), c);
  check("C: stale (older than yesterday)", c?.stale === true, c);
  check("C: tokens from uploader rows, any tool", c?.recentTokens === 240, c);
  check("C: requests", c?.recentRequests === 6, c);
  check("C: no warnings", JSON.stringify(c?.parserWarnings) === "[]" && JSON.stringify(c?.parserErrors) === "[]", c);

  // Order: most recent first; v2 A (today) before legacy C.
  check("order: A first", one[0]?.machineId === A, one.map((m) => m.machineId));

  // ---------------------------------------------------------------------------
  // Scenario 2: dedupe + legacy freshness sources.
  const m2 = `two${DOMAIN}`;
  const D = "dev_dddddddddddd"; // upgraded: legacy rows AND a Device
  const E = "dev_eeeeeeeeeeee"; // legacy, yesterday → fresh
  const F = "dev_ffffffffffff"; // legacy, rows only in usagedailylegacies (diverted)
  const G = "0f0f0f0f-0000-4000-8000-00000000000f"; // v2, heartbeat only (no sessions)
  await Device.create([
    {
      externalId: m2,
      machineId: D,
      label: "데스크탑",
      uploaderVersion: "2.0.0",
      lastSeenAt: new Date(NOW.getTime() - 2 * HOUR),
    },
    {
      externalId: m2,
      machineId: G,
      label: null,
      uploaderVersion: "2.0.0",
      lastSeenAt: new Date(NOW.getTime() - 3 * HOUR),
    },
  ]);
  await UsageDaily.create([
    daily(m2, D, addDays(TODAY, -5)),
    daily(m2, E, YESTERDAY),
  ]);
  await UsageDailyLegacy.create([
    { ...daily(m2, F, TODAY), divertedAt: NOW },
  ]);
  const two = await getMyMachines(m2, NOW);
  check("scenario 2: D, E, F, G once each", two.length === 4, two);
  const d = byId(two, D);
  check("D: both v2 and legacy → shown once as v2", d?.format === "v2" && d?.label === "데스크탑", d);
  check("D: v2 fresh", d?.stale === false, d);
  const e = byId(two, E);
  check("E: legacy yesterday → not stale", e?.format === "legacy" && e?.stale === false, e);
  const f = byId(two, F);
  check(
    "F: diverted legacy rows still count for freshness",
    f?.format === "legacy" && f?.lastDate === TODAY && f?.stale === false,
    f,
  );
  const g = byId(two, G);
  check(
    "G: heartbeat-only device listed, 0 tokens, lastDate = KST upload date",
    g?.format === "v2" && g?.recentTokens === 0 && g?.lastDate === kstDate(NOW.getTime() - 3 * HOUR),
    g,
  );

  // A device whose sessions are all outside the 14-day window: 0 tokens and
  // lastDate falls back to the KST upload date (the aggregate is bounded).
  {
    const I = "01010101-0000-4000-8000-000000000001";
    const m3 = `three${DOMAIN}`;
    await Device.create({
      externalId: m3,
      machineId: I,
      label: null,
      uploaderVersion: "2.0.0",
      lastSeenAt: new Date(NOW.getTime() - 30 * HOUR),
    });
    await UsageSession.create(
      session(m3, "s-i-old", addDays(SINCE, -3), [I], { input: 50, output: 5, requests: 1 }),
    );
    const [i] = await getMyMachines(m3, NOW);
    check(
      "I: only pre-window sessions → 0 tokens, lastDate = KST upload date",
      i?.recentTokens === 0 &&
        i?.recentRequests === 0 &&
        i?.lastDate === kstDate(NOW.getTime() - 30 * HOUR) &&
        i?.stale === true,
      i,
    );
  }

  // Index use: the per-member machine queries must not COLLSCAN.
  {
    type Plan = { queryPlanner?: { winningPlan?: unknown } };
    const planOf = async (p: Promise<unknown>) =>
      JSON.stringify(((await p) as Plan).queryPlanner?.winningPlan ?? {});
    const legacyMatch = {
      externalId: m1,
      source: "uploader",
      machineId: { $nin: [DERIVED_MACHINE_ID, A, B] },
    };
    const daily = await planOf(UsageDaily.find(legacyMatch).explain("queryPlanner"));
    check(
      "usagedailies legacy query uses externalId_1_source_1_machineId_1_date_1",
      daily.includes("externalId_1_source_1_machineId_1_date_1") && !daily.includes("COLLSCAN"),
      daily,
    );
    const legacy = await planOf(UsageDailyLegacy.find(legacyMatch).explain("queryPlanner"));
    check(
      "usagedailylegacies legacy query uses externalId_1_source_1_machineId_1_date_1",
      legacy.includes("externalId_1_source_1_machineId_1_date_1") && !legacy.includes("COLLSCAN"),
      legacy,
    );
    const sess = await planOf(
      UsageSession.find({
        externalId: m1,
        machineIds: { $in: [A, B] },
        date: { $gte: SINCE },
      }).explain("queryPlanner"),
    );
    // The planner may pick either externalId-leading index on tiny test data;
    // what matters is an index scan (no COLLSCAN) and that the multikey index
    // exists for the planner to choose on real data.
    check(
      "usagesessions device query is an index scan",
      sess.includes("IXSCAN") && !sess.includes("COLLSCAN"),
      sess,
    );
    const sessIdx = (await UsageSession.listIndexes()).map((x) => x.name);
    check(
      "usagesessions has externalId_1_machineIds_1_date_1",
      sessIdx.includes("externalId_1_machineIds_1_date_1"),
      sessIdx,
    );
  }

  // Wizard install detection: a new Device doc (first v2 upload/heartbeat)
  // surfaces as a machineId not in the previous list.
  {
    const baseline = new Set(two.map((m) => m.machineId));
    const H = "0e0e0e0e-0000-4000-8000-00000000000e";
    await Device.create({
      externalId: m2,
      machineId: H,
      label: "맥미니",
      uploaderVersion: "2.0.0",
      lastSeenAt: NOW,
    });
    const fresh = (await getMyMachines(m2, NOW)).find((m) => !baseline.has(m.machineId));
    check("wizard: new v2 device detected", fresh?.machineId === H && fresh?.label === "맥미니", fresh);
  }

  // Unknown member → empty.
  check("unknown member → []", (await getMyMachines(`nobody${DOMAIN}`, NOW)).length === 0);

  await cleanup();
  await closeDb();
  console.log(`PASS=${pass} FAIL=${fail}`);
  if (fail === 0) console.log("ALL PASS");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
