// POST /api/ingest v2 core (collection v2 Task 2): payload schema, v1
// compatibility, sessions + derived rows, legacy diversion (Ruling R1, same
// and separate requests), device label/health, machineId anonymization.
//
// Needs a DISPOSABLE MongoDB:
//   MONGODB_URI=mongodb://127.0.0.1:27391/tf-v2-test ./node_modules/.bin/tsx src/scripts/verify-ingest-v2.ts
// Safety guard: aborts unless the database name is exactly "tf-v2-test".
// Cleans ONLY documents of its own test identities (externalId ending
// "@ingest-v2.test") in the collections it touches. Do not run concurrently
// with verify-sessions.ts (that script wipes the usage collections).
import "./env";
import mongoose, { Types } from "mongoose";
import {
  closeDb,
  connectDb,
  Device,
  Member,
  MemberIdentity,
  UsageDaily,
  UsageDailyLegacy,
  UsageHourly,
  UsageSession,
} from "@/lib/db";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ingest/route";
import { handleIngest } from "@/lib/ingest";
import { anonymizeMachineId } from "@/lib/machine-id";
import { DERIVED_MACHINE_ID } from "@/lib/sessions";
import { ingestPayloadSchema } from "@/lib/types";
import { registerIdentities, upsertHourlyRows, upsertUsageRows } from "@/lib/usage";

const TEST_DB = "tf-v2-test";
const DOMAIN = "@ingest-v2.test";
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

const member = (name: string) => ({ _id: new Types.ObjectId(), email: `${name}${DOMAIN}` });

const parse = (body: unknown) => {
  const r = ingestPayloadSchema.safeParse(body);
  if (!r.success) throw new Error(`fixture payload invalid: ${JSON.stringify(r.error.issues)}`);
  return r.data;
};

const TOOL = "claude_code";
const MODEL = "claude-opus-5";
const D = "2026-09-28";
const Dm1 = "2026-09-27";
const HOST = "calebs-macbook.local"; // a hostname must never be stored
const UUID = "0f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

function v1Row(over: Record<string, unknown> = {}) {
  return {
    date: D,
    tool: TOOL,
    model: MODEL,
    externalId: "someone-else@evil.test",
    machineId: HOST,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requests: 2,
    sessions: 1,
    source: "uploader",
    ...over,
  };
}
function v1Hourly(over: Record<string, unknown> = {}) {
  return {
    hour: `${D}T10`,
    tool: TOOL,
    model: MODEL,
    machineId: HOST,
    inputTokens: 100,
    outputTokens: 10,
    requests: 2,
    source: "uploader",
    ...over,
  };
}
function sess(over: Record<string, unknown> = {}) {
  return {
    tool: TOOL,
    sessionId: "claude_code:S1",
    hour: `${D}T10`,
    model: MODEL,
    inputTokens: 30,
    outputTokens: 20,
    requests: 3,
    parserVersion: 1,
    machineId: UUID,
    ...over,
  };
}
const health = (parser: string, over: Record<string, unknown> = {}) => ({
  parser,
  filesScanned: 10,
  linesUnrecognized: 0,
  sessionsEmitted: 4,
  ...over,
});

// The pre-v2 route body, verbatim in behaviour (src/app/api/ingest/route.ts at
// 301e434), as the reference for "a v1 payload behaves exactly as before".
async function oldIngest(m: { _id: Types.ObjectId; email: string }, body: unknown) {
  const data = parse(body);
  const rows = (data.rows ?? [])
    .filter((row) => row.tool !== "claude_limits")
    .map((row) => ({
      ...row,
      externalId: m.email,
      machineId: anonymizeMachineId(row.machineId ?? ""),
    }));
  if (rows.length === 0) return { ok: true, upserted: 0, skipped: 0 };
  await registerIdentities(
    [...new Set(rows.map((r) => r.tool))].map((tool) => ({
      memberId: String(m._id),
      tool,
      externalId: m.email,
    })),
  );
  const { upserted, skipped } = await upsertUsageRows(rows);
  let hourlyUpserted = 0;
  if (data.hourly?.length) {
    const hourly = data.hourly.map((row) => ({
      ...row,
      externalId: m.email,
      machineId: anonymizeMachineId(row.machineId ?? ""),
    }));
    ({ upserted: hourlyUpserted } = await upsertHourlyRows(hourly));
  }
  return { ok: true, upserted, skipped, hourlyUpserted };
}

// Documents of one member minus identity/volatile fields, order-stable.
async function snapshot(externalId: string) {
  const strip = (d: Record<string, unknown>) => {
    const { _id, updatedAt, externalId: e, memberId, __v, ...rest } = d;
    void _id;
    void updatedAt;
    void e;
    void __v;
    // Key order of a stored document is not semantic — compare sorted keys.
    const out: Record<string, unknown> = { ...rest, linked: memberId != null };
    return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  };
  const daily = (await UsageDaily.find({ externalId }).lean()).map((d) =>
    strip(d as unknown as Record<string, unknown>),
  );
  const hourly = (await UsageHourly.find({ externalId }).lean()).map((d) =>
    strip(d as unknown as Record<string, unknown>),
  );
  const sortKey = (x: Record<string, unknown>) => JSON.stringify(x);
  return JSON.stringify({
    daily: daily.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    hourly: hourly.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  });
}

async function main() {
  const uri = process.env.MONGODB_URI ?? "";
  if (dbNameFromUri(uri) !== TEST_DB) {
    console.error(`ABORT: MONGODB_URI database must be exactly "${TEST_DB}" (got "${dbNameFromUri(uri)}")`);
    process.exit(2);
  }
  await connectDb();
  if (mongoose.connection.name !== TEST_DB) {
    console.error(`ABORT: connected database is "${mongoose.connection.name}", not "${TEST_DB}"`);
    await closeDb();
    process.exit(2);
  }
  await Promise.all([
    UsageSession.deleteMany(OWN),
    UsageDaily.deleteMany(OWN),
    UsageHourly.deleteMany(OWN),
    UsageDailyLegacy.deleteMany(OWN),
    MemberIdentity.deleteMany(OWN),
    Device.deleteMany(OWN),
    Member.deleteMany({ email: OWN.externalId }),
  ]);
  await Promise.all([
    UsageSession.syncIndexes(),
    UsageDailyLegacy.syncIndexes(),
    Device.syncIndexes(),
  ]);

  // ---- (e)(f) schema ------------------------------------------------------
  const ok = (b: unknown) => ingestPayloadSchema.safeParse(b).success;
  check("[e] rows:[] + sessions:[] rejected", !ok({ rows: [], sessions: [] }));
  check("[e] empty object rejected", !ok({}));
  check("[e] rows:[] alone rejected (v1 min 1 kept)", !ok({ rows: [] }));
  check("[R12] device+health without rows/sessions = valid heartbeat", ok({
    device: { machineId: UUID, uploaderVersion: "2.0.0" },
    health: [health("codex")],
  }));
  check("[R12] device alone with rows:[] sessions:[] = valid heartbeat", ok({
    rows: [],
    sessions: [],
    device: { machineId: UUID, uploaderVersion: "2.0.0" },
  }));
  const healthOnly = ingestPayloadSchema.safeParse({ health: [health("codex")] });
  check(
    "[R12] health without device and no rows/sessions rejected at path rows",
    !healthOnly.success && healthOnly.error.issues.some((i) => i.path[0] === "rows"),
    healthOnly.success ? null : healthOnly.error.issues,
  );
  check("[e] v1 payload valid", ok({ rows: [v1Row()], hourly: [v1Hourly()] }));
  check("[e] sessions-only payload valid", ok({ sessions: [sess()] }));
  check("[e] rows:[] + 1 session valid", ok({ rows: [], sessions: [sess()] }));
  // Diagnostics are lossy (fix round 1): never a 400, values clipped/dropped.
  const pd = (b: unknown) => ingestPayloadSchema.safeParse(b);
  const label = (n: number) => ({
    sessions: [sess()],
    device: { machineId: UUID, label: "가".repeat(n), uploaderVersion: "2.0.0" },
  });
  const l40 = pd(label(40));
  check("[f] label 40 chars accepted, clipped to 32", l40.success && l40.data.device?.label === "가".repeat(32), l40.success ? l40.data.device : l40.error.issues);
  const l32 = pd(label(32));
  check("[f] label 32 chars kept", l32.success && l32.data.device?.label === "가".repeat(32));
  const lEmoji = pd({ sessions: [sess()], device: { machineId: UUID, label: "a".repeat(31) + "🌲🌲", uploaderVersion: "2" } });
  check(
    "[f] label clip never splits a surrogate pair",
    lEmoji.success && lEmoji.data.device?.label === "a".repeat(31),
    lEmoji.success ? lEmoji.data.device : null,
  );
  const lNum = pd({ sessions: [sess()], device: { machineId: UUID, label: 42, uploaderVersion: "2" } });
  check("[f] non-string label ignored, device kept", lNum.success && lNum.data.device?.machineId === UUID && lNum.data.device.label === undefined);
  const noVer = pd({ sessions: [sess()], device: { machineId: UUID } });
  check("[f] unusable device (no uploaderVersion) ignored, payload valid", noVer.success && noVer.data.device === undefined);
  check("[f] unusable device alone is not a heartbeat → invalid", !ok({ device: { machineId: UUID } }));
  const e201 = pd({ sessions: [sess()], health: [health("opencode", { error: "x".repeat(201) })] });
  check("[R3] health.error 201 clipped to 200", e201.success && e201.data.health?.[0].error === "x".repeat(200));
  const p41 = pd({ sessions: [sess()], health: [health("p".repeat(41))] });
  check("[R3] health.parser 41 clipped to 40", p41.success && p41.data.health?.[0].parser === "p".repeat(40));
  const bad = pd({
    sessions: [sess()],
    health: [
      health("codex", { linesUnrecognized: -1 }),
      health("gemini", { filesScanned: 1.5 }),
      "not-an-object",
      null,
      health(""),
      health("grok", { error: 7 }),
      health("claude-code"),
    ],
  });
  check(
    "[R3] malformed health items dropped silently, good ones kept (non-string error → field dropped)",
    bad.success &&
      bad.data.health?.map((h) => h.parser).join(",") === "grok,claude-code" &&
      bad.data.health?.[0].error === undefined,
    bad.success ? bad.data.health : bad.error.issues,
  );
  const h60 = pd({ sessions: [sess()], health: Array.from({ length: 60 }, (_, i) => health(`p${i}`)) });
  check(
    "[R3] 60 health items → first 50 kept",
    h60.success && h60.data.health?.length === 50 && h60.data.health[49].parser === "p49",
  );
  const hObj = pd({ sessions: [sess()], health: { parser: "codex" } });
  check("[R3] non-array health → []", hObj.success && hObj.data.health?.length === 0);
  // Usage stays strict.
  check("[strict] bad session row still rejected", !ok({ sessions: [sess({ hour: "2026-09-28 10" })] }));
  check("[R8] 50000 sessions accepted", ok({ sessions: Array.from({ length: 50_000 }, () => sess()) }));
  check("[R8] 50001 sessions rejected", !ok({ sessions: Array.from({ length: 50_001 }, () => sess()) }));
  check("[e] 10001 rows rejected", !ok({ rows: Array.from({ length: 10_001 }, () => v1Row()) }));
  // Old-uploader fallback trigger (Ruling R2) keys on path[0] === "rows": the
  // "nothing to send" refine must point there too.
  const emptyIssues = ingestPayloadSchema.safeParse({ rows: [], sessions: [] });
  check(
    "[e] empty-payload issue path[0] is 'rows'",
    !emptyIssues.success && emptyIssues.error.issues.some((i) => i.path[0] === "rows"),
    emptyIssues.success ? null : emptyIssues.error.issues,
  );

  // ---- (a) v1 payload ≡ pre-v2 route (no session coverage) ---------------
  const v1Payloads: Array<[string, unknown[]]> = [
    [
      "rows+hourly+limits",
      [
        {
          rows: [
            v1Row(),
            v1Row({ model: "claude-sonnet-5", inputTokens: 7 }),
            v1Row({ tool: "claude_limits", model: "five_hour", inputTokens: 55 }),
            v1Row({ date: Dm1, machineId: UUID }),
          ],
          hourly: [v1Hourly(), v1Hourly({ hour: `${Dm1}T09` })],
        },
        // re-send later with bigger totals (daily totals overwrite)
        { rows: [v1Row({ inputTokens: 150 })] },
      ],
    ],
    ["only claude_limits", [{ rows: [v1Row({ tool: "claude_limits" })], hourly: [v1Hourly()] }]],
    [
      "poller owns key → skipped",
      [
        { rows: [v1Row({ source: "poller", machineId: "" })] },
        { rows: [v1Row(), v1Row({ model: "claude-sonnet-5" })], hourly: [v1Hourly()] },
      ],
    ],
  ];
  for (const [name, bodies] of v1Payloads) {
    const mOld = member(`old-${name.replace(/\W+/g, "-")}`);
    const mNew = member(`new-${name.replace(/\W+/g, "-")}`);
    for (const [i, body] of bodies.entries()) {
      const before = await oldIngest(mOld, body);
      const after = await handleIngest(mNew, parse(body));
      check(
        `[a ${name} #${i}] upserted/skipped/hourlyUpserted match pre-v2`,
        after.upserted === before.upserted &&
          after.skipped === before.skipped &&
          after.hourlyUpserted === (before.hourlyUpserted ?? 0),
        { before, after },
      );
      check(
        `[a ${name} #${i}] no session/derived work`,
        after.sessionsUpserted === 0 &&
          after.derived.daily === 0 &&
          after.derived.hourly === 0 &&
          after.derived.divertedLegacy === 0,
        after,
      );
    }
    const [so, sn] = [await snapshot(mOld.email), await snapshot(mNew.email)];
    check(`[a ${name}] usagedailies/usagehourlies identical to pre-v2`, so === sn, { so, sn });
    check(
      `[a ${name}] no backup rows`,
      (await UsageDailyLegacy.countDocuments({ externalId: mNew.email })) === 0,
    );
  }
  const mA = member("a-check");
  await handleIngest(mA, parse({ rows: [v1Row()], hourly: [v1Hourly()] }));
  const aDaily = await UsageDaily.findOne({ externalId: mA.email }).lean();
  check("[a] externalId forced to member", aDaily?.externalId === mA.email, aDaily);
  check(
    "[a] hostname anonymized",
    aDaily?.machineId === anonymizeMachineId(HOST) && aDaily.machineId !== HOST,
    aDaily,
  );

  // ---- (b) v2 sessions only ----------------------------------------------
  const mB = member("b-sessions");
  const rb = await handleIngest(
    mB,
    parse({
      sessions: [
        sess(),
        sess({ hour: `${D}T11`, inputTokens: 5 }),
        sess({ tool: "opencode", sessionId: "opencode:X", model: "gpt-5", provider: "github-copilot", machineId: HOST }),
        sess({ tool: "claude_limits", sessionId: "claude_limits:L" }),
      ],
    }),
  );
  check("[b] sessionsUpserted = 3 (claude_limits dropped)", rb.sessionsUpserted === 3, rb);
  check("[b] no v1 counts", rb.upserted === 0 && rb.skipped === 0 && rb.hourlyUpserted === 0, rb);
  check("[b] derived daily = 2, hourly = 3", rb.derived.daily === 2 && rb.derived.hourly === 3, rb);
  const bSess = await UsageSession.find({ externalId: mB.email }).lean();
  check("[b] 3 session docs, none claude_limits", bSess.length === 3 && bSess.every((s) => s.tool !== "claude_limits"), bSess);
  const bOc = bSess.find((s) => s.tool === "opencode");
  check(
    "[b] session machineIds anonymized (no hostname)",
    bOc?.machineIds.length === 1 && bOc.machineIds[0] === anonymizeMachineId(HOST) &&
      !JSON.stringify(bSess).includes(HOST),
    bOc,
  );
  const bDaily = await UsageDaily.find({ externalId: mB.email }).lean();
  const bCc = bDaily.find((d) => d.tool === TOOL);
  check(
    "[b] derived claude_code daily = 35 input, machineId sessions",
    bDaily.length === 2 && bCc?.inputTokens === 35 && bCc.machineId === DERIVED_MACHINE_ID && bCc.source === "uploader",
    bDaily,
  );
  const bIds = await MemberIdentity.find({ externalId: mB.email }).lean();
  check(
    "[b] identities registered for session tools (claude_code, opencode)",
    bIds.map((i) => i.tool).sort().join(",") === "claude_code,opencode" &&
      bIds.every((i) => String(i.memberId) === String(mB._id)),
    bIds,
  );
  check(
    "[b] session & derived rows linked to member",
    bSess.every((s) => String(s.memberId) === String(mB._id)) &&
      bDaily.every((d) => String(d.memberId) === String(mB._id)),
  );

  // ---- (c) sessions + v1 rows in ONE request -----------------------------
  const mC = member("c-mixed");
  const rc = await handleIngest(
    mC,
    parse({
      rows: [v1Row(), v1Row({ date: Dm1, inputTokens: 900 })],
      hourly: [v1Hourly(), v1Hourly({ hour: `${Dm1}T08`, inputTokens: 900 })],
      sessions: [sess()],
    }),
  );
  const cDaily = await UsageDaily.find({ externalId: mC.email }).lean();
  const cD = cDaily.filter((d) => d.date === D);
  check(
    "[c] date D: only the derived row (input 30)",
    cD.length === 1 && cD[0].machineId === DERIVED_MACHINE_ID && cD[0].inputTokens === 30,
    cD,
  );
  const cDm1 = cDaily.filter((d) => d.date === Dm1);
  check(
    "[c] date D-1 (no coverage): v1 row lands normally",
    cDm1.length === 1 && cDm1[0].machineId === anonymizeMachineId(HOST) && cDm1[0].inputTokens === 900,
    cDm1,
  );
  const cLeg = await UsageDailyLegacy.find({ externalId: mC.email }).lean();
  check(
    "[c] backup holds the covered v1 row",
    cLeg.length === 1 && cLeg[0].date === D && cLeg[0].inputTokens === 100 &&
      cLeg[0].machineId === anonymizeMachineId(HOST) && cLeg[0].divertedAt instanceof Date &&
      String(cLeg[0].memberId) === String(mC._id),
    cLeg,
  );
  const cHourly = await UsageHourly.find({ externalId: mC.email }).lean();
  check(
    "[c] hourly: covered v1 hour dropped, derived + D-1 v1 kept",
    cHourly.length === 2 &&
      cHourly.some((h) => h.hour === `${D}T10` && h.machineId === DERIVED_MACHINE_ID && h.inputTokens === 30) &&
      cHourly.some((h) => h.hour === `${Dm1}T08` && h.machineId === anonymizeMachineId(HOST)),
    cHourly,
  );
  check(
    "[c] counts: upserted 1, skipped 1 (diverted), hourlyUpserted 1, divertedLegacy 1",
    rc.upserted === 1 && rc.skipped === 1 && rc.hourlyUpserted === 1 && rc.derived.divertedLegacy === 1 &&
      rc.sessionsUpserted === 1,
    rc,
  );

  // ---- (c-R1) sessions in request A, v1 rows in a LATER request B ---------
  const mR = member("r1-separate");
  // v1 row of another (old) device already in usagedailies for D before A.
  await handleIngest(mR, parse({ rows: [v1Row({ machineId: "old-desktop", inputTokens: 40 })] }));
  const ra = await handleIngest(mR, parse({ sessions: [sess()] }));
  check("[R1] A: pre-existing v1 row for D diverted by derive", ra.derived.divertedLegacy === 1, ra);
  const rbReq = await handleIngest(
    mR,
    parse({
      rows: [v1Row(), v1Row({ model: "claude-sonnet-5" }), v1Row({ date: Dm1, inputTokens: 900 })],
      hourly: [v1Hourly(), v1Hourly({ hour: `${Dm1}T08` })],
    }),
  );
  const rDaily = await UsageDaily.find({ externalId: mR.email }).lean();
  check(
    "[R1] B: nothing new in usagedailies for D (only derived)",
    rDaily.filter((d) => d.date === D).length === 1 &&
      rDaily.filter((d) => d.date === D)[0].machineId === DERIVED_MACHINE_ID,
    rDaily,
  );
  check(
    "[R1] B: v1 row for D-1 lands normally",
    rDaily.some((d) => d.date === Dm1 && d.inputTokens === 900 && d.machineId === anonymizeMachineId(HOST)),
    rDaily,
  );
  const rLeg = await UsageDailyLegacy.find({ externalId: mR.email }).lean();
  check(
    "[R1] B: backup has both B rows for D + the earlier device's row",
    rLeg.length === 3 &&
      rLeg.filter((l) => l.date === D && l.machineId === anonymizeMachineId(HOST)).length === 2 &&
      rLeg.some((l) => l.machineId === anonymizeMachineId("old-desktop") && l.inputTokens === 40),
    rLeg,
  );
  const rHourly = await UsageHourly.find({ externalId: mR.email }).lean();
  check(
    "[R1] B: covered v1 hourly dropped, D-1 hourly kept",
    !rHourly.some((h) => h.hour.startsWith(D) && h.machineId !== DERIVED_MACHINE_ID) &&
      rHourly.some((h) => h.hour === `${Dm1}T08`),
    rHourly,
  );
  check(
    "[R1] B counts: upserted 1, skipped 2, hourly 1, divertedLegacy 2",
    rbReq.upserted === 1 && rbReq.skipped === 2 && rbReq.hourlyUpserted === 1 &&
      rbReq.derived.divertedLegacy === 2 && rbReq.sessionsUpserted === 0,
    rbReq,
  );
  // Re-sending B is idempotent: backup replaced, not duplicated.
  await handleIngest(mR, parse({ rows: [v1Row({ inputTokens: 120 })] }));
  const rLeg2 = await UsageDailyLegacy.find({ externalId: mR.email, date: D, model: MODEL, machineId: anonymizeMachineId(HOST) }).lean();
  check("[R1] re-sent v1 row replaces its backup (120)", rLeg2.length === 1 && rLeg2[0].inputTokens === 120, rLeg2);
  check(
    "[R1] usagedailies still only derived for D",
    (await UsageDaily.countDocuments({ externalId: mR.email, date: D })) === 1,
  );
  // Manual rows are not uploader legacy: never diverted.
  await handleIngest(mR, parse({ rows: [v1Row({ tool: TOOL, source: "manual", model: "manual-x", machineId: "" })] }));
  check(
    "[R1] manual row for a covered date still lands",
    (await UsageDaily.countDocuments({ externalId: mR.email, date: D, source: "manual" })) === 1,
  );

  // ---- (d) device label + machineId anonymization + health ---------------
  const mD = member("d-device");
  const t0 = new Date("2026-09-20T00:00:00Z");
  await handleIngest(
    mD,
    parse({
      sessions: [sess()],
      device: { machineId: HOST, label: "  맥북  ", uploaderVersion: "2.0.0" },
      health: [health("claude-code"), health("opencode", { error: "SQLITE_BUSY", sessionsEmitted: 0 })],
    }),
    { now: t0 },
  );
  const devs = await Device.find({ externalId: mD.email }).lean();
  check("[d] one device doc", devs.length === 1, devs);
  const dev = devs[0];
  check(
    "[d] machineId anonymized; hostname stored nowhere",
    dev?.machineId === anonymizeMachineId(HOST) && !JSON.stringify(devs).includes(HOST),
    dev,
  );
  check("[d] label trimmed & stored", dev?.label === "맥북", dev?.label);
  check("[d] uploaderVersion + lastSeenAt", dev?.uploaderVersion === "2.0.0" && dev.lastSeenAt?.getTime() === t0.getTime(), dev);
  check(
    "[d] latest health per parser (with error)",
    dev?.health.length === 2 &&
      dev.health.some((h) => h.parser === "opencode" && h.error === "SQLITE_BUSY" && h.at.getTime() === t0.getTime()) &&
      dev.health.some((h) => h.parser === "claude-code" && h.sessionsEmitted === 4 && h.error == null),
    dev?.health,
  );
  check("[d] history starts with one sample per parser", dev?.healthHistory.length === 2, dev?.healthHistory);

  // Hourly uploads for 10 days: latest always updated; history keeps ≤1
  // sample per parser per 12h, only the last 7 days, ≤14 per parser.
  let last = t0;
  for (let h = 1; h <= 240; h++) {
    last = new Date(t0.getTime() + h * 3_600_000);
    await handleIngest(
      mD,
      parse({
        sessions: [sess()],
        device: { machineId: HOST, uploaderVersion: "2.0.1" },
        health: [health("claude-code", { filesScanned: 10 + h })],
      }),
      { now: last },
    );
  }
  const dev2 = await Device.findOne({ externalId: mD.email }).lean();
  const ccLatest = dev2?.health.find((h) => h.parser === "claude-code");
  check("[d] latest claude-code = last upload", ccLatest?.filesScanned === 250 && ccLatest.at.getTime() === last.getTime(), ccLatest);
  check("[d] parser absent from later uploads keeps its latest", dev2?.health.some((h) => h.parser === "opencode") === true);
  check("[d] label cleared when no longer sent", dev2?.label === null, dev2?.label);
  check("[d] uploaderVersion updated, lastSeenAt = last", dev2?.uploaderVersion === "2.0.1" && dev2.lastSeenAt.getTime() === last.getTime());
  const ccHist = dev2?.healthHistory.filter((h) => h.parser === "claude-code") ?? [];
  check("[d] history per parser ≤ 14", ccHist.length <= 14 && ccHist.length >= 13, ccHist.length);
  check(
    "[d] history within the last 7 days",
    ccHist.every((h) => last.getTime() - h.at.getTime() <= 7 * 86_400_000),
    ccHist.map((h) => h.at),
  );
  check(
    "[d] history samples ≥ 12h apart",
    ccHist.every((h, i) => i === 0 || h.at.getTime() - ccHist[i - 1].at.getTime() >= 12 * 3_600_000),
    ccHist.map((h) => h.at),
  );
  check(
    "[d] opencode history pruned after 7 days",
    !dev2?.healthHistory.some((h) => h.parser === "opencode"),
    dev2?.healthHistory.filter((h) => h.parser === "opencode"),
  );
  // Second device of the same member, UUID machineId passes through.
  await handleIngest(mD, parse({ sessions: [sess()], device: { machineId: UUID, uploaderVersion: "2.0.0" } }));
  const devs3 = await Device.find({ externalId: mD.email }).lean();
  check("[d] second device → 2 docs, UUID kept", devs3.length === 2 && devs3.some((x) => x.machineId === UUID), devs3.map((x) => x.machineId));
  // Health without device is ignored (no doc to attach it to), request ok.
  const mNoDev = member("d-nodevice");
  const rNoDev = await handleIngest(mNoDev, parse({ sessions: [sess()], health: [health("codex")] }));
  check(
    "[d] health without device: no Device doc, ingest ok",
    rNoDev.sessionsUpserted === 1 && (await Device.countDocuments({ externalId: mNoDev.email })) === 0,
  );

  // ---- (R12) device-only heartbeat through the real route handler --------
  const token = `tf-v2-test-${new Types.ObjectId().toHexString()}`;
  const mH = await Member.create({ name: "heartbeat", email: `heartbeat${DOMAIN}`, ingestToken: token });
  const post = (body: unknown) =>
    POST(
      new NextRequest("http://localhost/api/ingest", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const hbDevice = { machineId: UUID, label: "맥미니", uploaderVersion: "2.1.0" };
  const res1 = await post({ device: hbDevice, health: [health("codex")] });
  const hb1 = await Device.findOne({ externalId: mH.email, machineId: UUID }).lean();
  check("[R12] heartbeat-only → 200", res1.status === 200, res1.status);
  const body1 = (await res1.json()) as Record<string, unknown>;
  check(
    "[R12] heartbeat response: ok, all counts 0",
    body1.ok === true && body1.upserted === 0 && body1.skipped === 0 && body1.sessionsUpserted === 0,
    body1,
  );
  await new Promise((r) => setTimeout(r, 20));
  const res2 = await post({
    rows: [],
    sessions: [],
    device: { ...hbDevice, uploaderVersion: "2.1.1" },
    health: [health("codex", { filesScanned: 99 })],
  });
  const hb2 = await Device.findOne({ externalId: mH.email, machineId: UUID }).lean();
  check("[R12] second heartbeat → 200", res2.status === 200, res2.status);
  check(
    "[R12] lastSeenAt advanced, version/label/health updated",
    hb1 != null && hb2 != null && hb2.lastSeenAt.getTime() > hb1.lastSeenAt.getTime() &&
      hb2.uploaderVersion === "2.1.1" && hb2.label === "맥미니" &&
      hb2.health.find((h) => h.parser === "codex")?.filesScanned === 99,
    { hb1, hb2 },
  );
  const usageDocs = await Promise.all([
    UsageDaily.countDocuments({ externalId: mH.email }),
    UsageHourly.countDocuments({ externalId: mH.email }),
    UsageSession.countDocuments({ externalId: mH.email }),
    UsageDailyLegacy.countDocuments({ externalId: mH.email }),
    MemberIdentity.countDocuments({ externalId: mH.email }),
  ]);
  check("[R12] heartbeat wrote no usage/identity docs", usageDocs.every((n) => n === 0), usageDocs);
  const res3 = await post({ rows: [], sessions: [], health: [health("codex")] });
  const body3 = (await res3.json()) as { issues?: Array<{ path: unknown[] }> };
  check(
    "[R12] empty payload without device → 400, issue path rows",
    res3.status === 400 && (body3.issues ?? []).some((i) => i.path[0] === "rows"),
    { status: res3.status, body3 },
  );
  const res4 = await post({});
  check("[R12] {} → 400", res4.status === 400, res4.status);
  const res5 = await post({ rows: [v1Row()] });
  check("[R12] v1 payload through route → 200, upserted 1", res5.status === 200 && ((await res5.json()) as { upserted: number }).upserted === 1);

  // The public route strips caller-supplied raw content before it reaches the
  // usage writer. The writer also never stores raw on newly created dailies.
  const privateMarker = `synthetic-private-${new Types.ObjectId().toHexString()}`;
  const privatePayload = { rows: [v1Row({ tool: "privacy_fixture", raw: { prompt: privateMarker, code: privateMarker } })] };
  const parsedPrivate = parse(privatePayload);
  check("[privacy] public usage schema strips raw", !Object.hasOwn(parsedPrivate.rows?.[0] ?? {}, "raw"));
  const privateResponse = await post(privatePayload);
  const privateDoc = await UsageDaily.findOne({ externalId: mH.email, tool: "privacy_fixture", date: D }).lean();
  check("[privacy] ingest route accepts numeric usage", privateResponse.status === 200);
  check("[privacy] new daily stores no raw body", privateDoc != null && privateDoc.raw == null && !JSON.stringify(privateDoc).includes(privateMarker));
  if (privateDoc) {
    await UsageDaily.updateOne({ _id: privateDoc._id }, { $set: { raw: { legacy: true } } });
    await post({ rows: [v1Row({ tool: "privacy_fixture", inputTokens: 110, raw: { prompt: privateMarker } })] });
    const historical = await UsageDaily.findById(privateDoc._id).lean();
    check("[privacy] repeat upload preserves existing historical raw", historical?.inputTokens === 110 &&
      (historical.raw as { legacy?: boolean } | null)?.legacy === true && !JSON.stringify(historical).includes(privateMarker));
  }

  // ---- fix round 1: bad diagnostics through the route → 200, usage kept ----
  const res6 = await post({
    sessions: [sess({ sessionId: "claude_code:LOSSY" })],
    device: { ...hbDevice, label: "   " + "L".repeat(40) + "  " },
    health: [
      health("opencode", { error: "E".repeat(500) }),
      ...Array.from({ length: 59 }, (_, i) => health(`parser-${String(i).padStart(2, "0")}`)),
    ],
  });
  check("[lossy] long error + 60 health + 40-char label → 200", res6.status === 200, res6.status);
  check(
    "[lossy] usage written",
    (await UsageSession.countDocuments({ externalId: mH.email, sessionId: "claude_code:LOSSY" })) === 1 &&
      (await UsageDaily.countDocuments({ externalId: mH.email, machineId: DERIVED_MACHINE_ID })) >= 1,
  );
  const hb6 = await Device.findOne({ externalId: mH.email, machineId: UUID }).lean();
  check("[lossy] stored label clipped to 32", hb6?.label === "L".repeat(32), hb6?.label);
  check(
    "[lossy] stored error clipped to 200",
    hb6?.health.find((h) => h.parser === "opencode")?.error === "E".repeat(200),
  );
  check(
    "[lossy] latest health capped at 20 parsers",
    hb6?.health.length === 20,
    hb6?.health.length,
  );

  // ---- fix round 1: latest health pruned at 30 days, ≤20 parsers ----------
  const mP = member("p-prune");
  const pDev = { machineId: UUID, uploaderVersion: "2.0.0" };
  const tp = new Date("2026-08-01T00:00:00Z");
  await handleIngest(mP, parse({ device: pDev, health: [health("old-parser")] }), { now: tp });
  for (let i = 0; i < 25; i++) {
    await handleIngest(
      mP,
      parse({ device: pDev, health: [health(`p${String(i).padStart(2, "0")}`)] }),
      { now: new Date(tp.getTime() + (31 * 86_400_000) + i * 60_000) },
    );
  }
  const pd1 = await Device.findOne({ externalId: mP.email }).lean();
  const pNames = (pd1?.health ?? []).map((h) => h.parser);
  check("[prune] reading older than 30 days dropped", !pNames.includes("old-parser"), pNames);
  check(
    "[prune] ≤20 parsers, most recent kept (p05..p24)",
    pNames.length === 20 && pNames[0] === "p05" && pNames[19] === "p24",
    pNames,
  );
  check(
    "[prune] history only for kept parsers",
    (pd1?.healthHistory ?? []).every((h) => pNames.includes(h.parser)) &&
      (pd1?.healthHistory.length ?? 0) === 20,
    pd1?.healthHistory.map((h) => h.parser),
  );

  // ---- fix round 1: device recorded only after usage writes succeed -------
  const mF = member("f-failure");
  const fDev = { machineId: UUID, uploaderVersion: "2.0.0" };
  const t1 = new Date("2026-09-25T00:00:00Z");
  await handleIngest(mF, parse({ device: fDev }), { now: t1 }); // heartbeat
  const realBulkWrite = UsageDaily.bulkWrite.bind(UsageDaily);
  (UsageDaily as unknown as { bulkWrite: unknown }).bulkWrite = async () => {
    throw new Error("forced usage write failure");
  };
  let threw = false;
  try {
    await handleIngest(mF, parse({ rows: [v1Row()], device: fDev }), {
      now: new Date(t1.getTime() + 3_600_000),
    });
  } catch {
    threw = true;
  } finally {
    (UsageDaily as unknown as { bulkWrite: unknown }).bulkWrite = realBulkWrite;
  }
  const fd = await Device.findOne({ externalId: mF.email }).lean();
  check("[order] failing usage write throws", threw);
  check(
    "[order] failed upload did not advance lastSeenAt",
    fd?.lastSeenAt.getTime() === t1.getTime(),
    fd?.lastSeenAt,
  );
  await handleIngest(mF, parse({ rows: [v1Row()], device: fDev }), {
    now: new Date(t1.getTime() + 7_200_000),
  });
  const fd2 = await Device.findOne({ externalId: mF.email }).lean();
  check(
    "[order] successful upload advances lastSeenAt",
    fd2?.lastSeenAt.getTime() === t1.getTime() + 7_200_000,
    fd2?.lastSeenAt,
  );

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
