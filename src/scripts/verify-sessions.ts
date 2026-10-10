// Session-grained ingest core (collection v2): max-merge, parserVersion
// override, derived daily/hourly uploader rows, legacy diversion, poller
// priority, sessionCoverage.
//
// Needs a DISPOSABLE MongoDB and WIPES its usage collections on every run:
//   MONGODB_URI=mongodb://127.0.0.1:27391/tf-v2-test ./node_modules/.bin/tsx src/scripts/verify-sessions.ts
// Safety guard: aborts unless the database name is exactly "tf-v2-test".
import "./env";
import mongoose from "mongoose";
import {
  closeDb,
  connectDb,
  UsageDaily,
  UsageDailyLegacy,
  UsageHourly,
  UsageSession,
} from "@/lib/db";
import {
  DERIVED_MACHINE_ID,
  deriveUploaderRows,
  divertLegacyRows,
  sessionCoverage,
  upsertSessionRows,
} from "@/lib/sessions";
import { upsertHourlyRows, upsertUsageRows } from "@/lib/usage";
import { usageSessionRowSchema, type UsageSessionRow } from "@/lib/types";

const TEST_DB = "tf-v2-test";

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
  // mongodb://host:port/<db>?opts
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  return m ? decodeURIComponent(m[1]) : "";
}

const A = "dev_00000000000a";
const B = "dev_00000000000b";
const TOOL = "claude_code";
const MODEL = "claude-opus-5";

function row(over: Partial<UsageSessionRow> = {}): UsageSessionRow {
  return usageSessionRowSchema.parse({
    tool: TOOL,
    sessionId: "claude_code:S1",
    hour: "2026-09-28T10",
    model: MODEL,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requests: 0,
    parserVersion: 2,
    ...over,
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
    UsageSession.deleteMany({}),
    UsageDaily.deleteMany({}),
    UsageHourly.deleteMany({}),
    UsageDailyLegacy.deleteMany({}),
  ]);
  await UsageSession.syncIndexes();
  await UsageDailyLegacy.syncIndexes();

  // Schema sanity: externalId is never part of the row (server enforces it);
  // unknown hour shapes are rejected.
  check(
    "schema rejects bad hour",
    !usageSessionRowSchema.safeParse({ ...row(), hour: "2026-09-28 10" }).success,
  );
  check("DERIVED_MACHINE_ID is 'sessions'", DERIVED_MACHINE_ID === "sessions");

  // A partial observation keeps its numeric sum but records incomplete
  // evidence; the parser upgrade can later replace it with a lower true zero.
  await upsertSessionRows("ext-null", [row({
    inputTokens: null, outputTokens: 0, cacheReadTokens: null,
    cacheCreationTokens: null, requests: 1, parserVersion: 3,
    fieldEvidence: { inputTokens: "unknown", outputTokens: "known", cacheReadTokens: "unsupported", cacheCreationTokens: "unsupported", requests: "known", sessions: "known" },
    dateBasis: "KST",
  })]);
  await deriveUploaderRows("ext-null", [{ tool: TOOL, date: "2026-09-28" }]);
  const nullDaily = await UsageDaily.findOne({ externalId: "ext-null" }).lean();
  const nullHourly = await UsageHourly.findOne({ externalId: "ext-null" }).lean();
  check("[null] daily absent input stays null", nullDaily?.inputTokens === null && nullDaily.fieldEvidence?.inputTokens === "unknown", nullDaily);
  check("[null] hourly absent input stays null", nullHourly?.inputTokens === null && nullHourly.fieldEvidence?.inputTokens === "unknown", nullHourly);
  check("[null] explicit zero remains known", nullDaily?.outputTokens === 0 && nullDaily.fieldEvidence?.outputTokens === "known", nullDaily);
  await upsertSessionRows("ext-null", [row({ inputTokens: 7, outputTokens: 0, requests: 1, parserVersion: 3, fieldEvidence: { inputTokens: "unknown" } })]);
  await deriveUploaderRows("ext-null", [{ tool: TOOL, date: "2026-09-28" }]);
  const partial = await UsageDaily.findOne({ externalId: "ext-null" }).lean();
  check("[null] partial count carries incomplete evidence", partial?.inputTokens === 7 && partial.fieldEvidence?.inputTokens === "unknown", partial);
  await upsertSessionRows("ext-null", [row({ inputTokens: 0, outputTokens: 0, requests: 1, parserVersion: 4, fieldEvidence: { inputTokens: "known" } })]);
  await deriveUploaderRows("ext-null", [{ tool: TOOL, date: "2026-09-28" }]);
  const corrected = await UsageDaily.findOne({ externalId: "ext-null" }).lean();
  check("[null] parser upgrade lowers partial to known zero", corrected?.inputTokens === 0 && corrected.fieldEvidence?.inputTokens === "known", corrected);

  // Old parser versions supplied 0 as a default for absent fields. A resend
  // without evidence must not promote that default into a confirmed zero.
  await upsertSessionRows("ext-legacyzero", [row({ parserVersion: 3 })]);
  await deriveUploaderRows("ext-legacyzero", [{ tool: TOOL, date: "2026-09-28" }]);
  const legacyZeroSession = await UsageSession.findOne({ externalId: "ext-legacyzero" }).lean();
  const legacyZeroDaily = await UsageDaily.findOne({ externalId: "ext-legacyzero" }).lean();
  const legacyZeroHourly = await UsageHourly.findOne({ externalId: "ext-legacyzero" }).lean();
  check("[legacy zero] stored zero remains unconfirmed", legacyZeroSession?.inputTokens === 0 && legacyZeroSession.fieldEvidence?.inputTokens === "unknown");
  check("[legacy zero] derived daily zero remains unconfirmed", legacyZeroDaily?.inputTokens === 0 && legacyZeroDaily.fieldEvidence?.inputTokens === "unknown");
  check("[legacy zero] derived hourly zero remains unconfirmed", legacyZeroHourly?.inputTokens === 0 && legacyZeroHourly.fieldEvidence?.inputTokens === "unknown");
  await upsertSessionRows("ext-legacyzero", [row({ parserVersion: 4, inputTokens: 0, fieldEvidence: { inputTokens: "known" } })]);
  await deriveUploaderRows("ext-legacyzero", [{ tool: TOOL, date: "2026-09-28" }]);
  const nativeZero = await UsageDaily.findOne({ externalId: "ext-legacyzero" }).lean();
  check("[native zero] explicit zero becomes known after parser upgrade", nativeZero?.inputTokens === 0 && nativeZero.fieldEvidence?.inputTokens === "known");
  await UsageSession.create({
    externalId: "ext-historicalzero", memberId: null, tool: TOOL,
    sessionId: "claude_code:historical", hour: "2026-09-28T10", date: "2026-09-28",
    model: MODEL, provider: "", inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0,
    parserVersion: 3, machineIds: [],
  });
  await deriveUploaderRows("ext-historicalzero", [{ tool: TOOL, date: "2026-09-28" }]);
  const historicalZero = await UsageDaily.findOne({ externalId: "ext-historicalzero" }).lean();
  check("[historical zero] metadata-free stored zero stays unknown", historicalZero?.inputTokens === 0 && historicalZero.fieldEvidence?.inputTokens === "unknown");
  await upsertSessionRows("ext-historicalzero", [row({ sessionId: "claude_code:historical", parserVersion: 3 })]);
  const historicalResend = await UsageSession.findOne({ externalId: "ext-historicalzero" }).lean();
  check("[historical zero] same-version resend cannot confirm zero", historicalResend?.inputTokens === 0 && historicalResend.fieldEvidence?.inputTokens === "unknown");

  // ---- 1. max-merge across machines, order-independent -------------------
  for (const [ext, order] of [
    ["ext-merge", [A, B]],
    ["ext-merge-rev", [B, A]],
  ] as const) {
    for (const m of order) {
      const v =
        m === A
          ? { inputTokens: 10, outputTokens: 5, requests: 1 }
          : { inputTokens: 30, outputTokens: 20, requests: 3 };
      await upsertSessionRows(ext, [row({ ...v, machineId: m })]);
    }
    const docs = await UsageSession.find({ externalId: ext }).lean();
    check(`[1 ${ext}] one session doc`, docs.length === 1, docs.length);
    const d = docs[0];
    check(
      `[1 ${ext}] values = max {30,20,0,0,3}`,
      d?.inputTokens === 30 &&
        d?.outputTokens === 20 &&
        d?.cacheReadTokens === 0 &&
        d?.cacheCreationTokens === 0 &&
        d?.requests === 3,
      d,
    );
    check(
      `[1 ${ext}] machineIds = [A,B]`,
      JSON.stringify([...(d?.machineIds ?? [])].sort()) === JSON.stringify([A, B]),
      d?.machineIds,
    );
    check(`[1 ${ext}] date = hour prefix`, d?.date === "2026-09-28", d?.date);
  }
  // Field-wise max: each field keeps its own high-water mark.
  await upsertSessionRows("ext-fieldmax", [row({ inputTokens: 10, outputTokens: 50, machineId: A })]);
  await upsertSessionRows("ext-fieldmax", [row({ inputTokens: 30, outputTokens: 20, machineId: B })]);
  const fm = await UsageSession.findOne({ externalId: "ext-fieldmax" }).lean();
  check("[1 fieldmax] {30,50}", fm?.inputTokens === 30 && fm?.outputTokens === 50, fm);
  // Hostname machineIds are pseudonymized (anonymizeMachineId backstop).
  await upsertSessionRows("ext-host", [row({ inputTokens: 1, machineId: "calebs-macbook" })]);
  const hd = await UsageSession.findOne({ externalId: "ext-host" }).lean();
  check(
    "[1 host] machineId anonymized",
    hd?.machineIds.length === 1 && /^dev_[0-9a-f]{12}$/.test(hd.machineIds[0]),
    hd?.machineIds,
  );
  // Model aliases are canonicalized before keying.
  await upsertSessionRows("ext-alias", [row({ model: "opus-5", inputTokens: 4 })]);
  await upsertSessionRows("ext-alias", [row({ model: "claude-opus-5", inputTokens: 6 })]);
  const al = await UsageSession.find({ externalId: "ext-alias" }).lean();
  check("[1 alias] one canonical doc", al.length === 1 && al[0].model === MODEL && al[0].inputTokens === 6, al);

  // ---- 2. derivation into usagedailies / usagehourlies -------------------
  const d2 = await deriveUploaderRows("ext-merge", [{ tool: TOOL, date: "2026-09-28" }]);
  const daily2 = await UsageDaily.find({ externalId: "ext-merge" }).lean();
  check("[2] one derived daily row", daily2.length === 1, daily2);
  const r2 = daily2[0];
  check(
    "[2] derived daily key + values",
    r2?.date === "2026-09-28" &&
      r2?.tool === TOOL &&
      r2?.model === MODEL &&
      r2?.machineId === "sessions" &&
      r2?.source === "uploader" &&
      r2?.inputTokens === 30 &&
      r2?.outputTokens === 20 &&
      r2?.requests === 3 &&
      r2?.sessions === 1,
    r2,
  );
  const hourly2 = await UsageHourly.find({ externalId: "ext-merge" }).lean();
  check(
    "[2] one derived hourly row",
    hourly2.length === 1 &&
      hourly2[0].hour === "2026-09-28T10" &&
      hourly2[0].machineId === "sessions" &&
      hourly2[0].inputTokens === 30,
    hourly2,
  );
  check("[2] derive result counts", d2.daily === 1 && d2.hourly === 1 && d2.divertedLegacy === 0, d2);
  // Re-derive is idempotent.
  await deriveUploaderRows("ext-merge", [{ tool: TOOL, date: "2026-09-28" }]);
  check(
    "[2] re-derive idempotent",
    (await UsageDaily.countDocuments({ externalId: "ext-merge" })) === 1 &&
      (await UsageHourly.countDocuments({ externalId: "ext-merge" })) === 1,
  );
  // Stale derived rows (e.g. a model label that no longer exists in the
  // session aggregate) are removed on re-derive.
  await UsageDaily.create({
    date: "2026-09-28",
    tool: TOOL,
    model: "old-label",
    externalId: "ext-merge",
    machineId: "sessions",
    source: "uploader",
    inputTokens: 1,
  });
  await UsageHourly.create({
    hour: "2026-09-28T03",
    tool: TOOL,
    model: "old-label",
    externalId: "ext-merge",
    machineId: "sessions",
    source: "uploader",
    inputTokens: 1,
  });
  await deriveUploaderRows("ext-merge", [{ tool: TOOL, date: "2026-09-28" }]);
  check(
    "[2] stale derived rows removed",
    (await UsageDaily.countDocuments({ externalId: "ext-merge", model: "old-label" })) === 0 &&
      (await UsageHourly.countDocuments({ externalId: "ext-merge", model: "old-label" })) === 0,
  );

  // ---- 3. sessions across midnight -> one daily row per date --------------
  const up3 = await upsertSessionRows("ext-midnight", [
    row({ sessionId: "claude_code:S1", hour: "2026-09-28T23", inputTokens: 100, outputTokens: 10, requests: 4 }),
    row({ sessionId: "claude_code:S2", hour: "2026-09-29T00", inputTokens: 7, outputTokens: 3, requests: 1 }),
  ]);
  check(
    "[3] touched = 2 (tool,date) pairs",
    up3.touched.length === 2 &&
      up3.touched.some((t) => t.date === "2026-09-28") &&
      up3.touched.some((t) => t.date === "2026-09-29"),
    up3,
  );
  await deriveUploaderRows("ext-midnight", up3.touched);
  const daily3 = await UsageDaily.find({ externalId: "ext-midnight" }).sort({ date: 1 }).lean();
  check(
    "[3] two daily rows by date",
    daily3.length === 2 && daily3[0].date === "2026-09-28" && daily3[1].date === "2026-09-29",
    daily3,
  );
  const sumIn = daily3.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const sumOut = daily3.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  check("[3] sums match sources", sumIn === 107 && sumOut === 13, { sumIn, sumOut });
  check("[3] two hourly rows", (await UsageHourly.countDocuments({ externalId: "ext-midnight" })) === 2);
  // Distinct-session count lands on the first model row of the day only.
  const up3b = await upsertSessionRows("ext-sesscount", [
    row({ sessionId: "claude_code:X", model: "claude-sonnet-5", inputTokens: 1 }),
    row({ sessionId: "claude_code:X", model: "claude-opus-5", inputTokens: 2 }),
    row({ sessionId: "claude_code:Y", hour: "2026-09-28T11", model: "claude-opus-5", inputTokens: 3 }),
  ]);
  await deriveUploaderRows("ext-sesscount", up3b.touched);
  const daily3b = await UsageDaily.find({ externalId: "ext-sesscount" }).sort({ model: 1 }).lean();
  check(
    "[3b] sessions=2 on first model row, null on the rest",
    daily3b.length === 2 &&
      daily3b[0].model === "claude-opus-5" &&
      daily3b[0].sessions === 2 &&
      daily3b[0].inputTokens === 5 &&
      daily3b[1].sessions === null,
    daily3b,
  );

  // ---- 4. parserVersion override ----------------------------------------
  await upsertSessionRows("ext-version", [row({ parserVersion: 1, inputTokens: 50 })]);
  let v = await UsageSession.findOne({ externalId: "ext-version" }).lean();
  check("[4] v1 stored 50", v?.inputTokens === 50 && v?.parserVersion === 1, v);
  await upsertSessionRows("ext-version", [row({ parserVersion: 2, inputTokens: 40 })]);
  v = await UsageSession.findOne({ externalId: "ext-version" }).lean();
  check("[4] v2 overwrites to 40", v?.inputTokens === 40 && v?.parserVersion === 2, v);
  const low = await upsertSessionRows("ext-version", [row({ parserVersion: 1, inputTokens: 60 })]);
  v = await UsageSession.findOne({ externalId: "ext-version" }).lean();
  check("[4] v1 after v2 ignored (40 kept)", v?.inputTokens === 40 && v?.parserVersion === 2, v);
  check("[4] ignored row not counted as upserted", low.upserted === 0, low);
  // Same key twice in one batch: highest version wins regardless of order.
  await upsertSessionRows("ext-version", [
    row({ parserVersion: 3, inputTokens: 30 }),
    row({ parserVersion: 1, inputTokens: 90 }),
  ]);
  v = await UsageSession.findOne({ externalId: "ext-version" }).lean();
  check("[4] in-batch highest version wins", v?.inputTokens === 30 && v?.parserVersion === 3, v);

  // ---- 5. legacy uploader rows diverted for covered (tool,date) ----------
  const D = "2026-09-20";
  const Dm1 = "2026-09-19";
  await upsertUsageRows([
    { date: D, tool: TOOL, model: MODEL, externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", source: "uploader", inputTokens: 999, sessions: 4 },
    { date: Dm1, tool: TOOL, model: MODEL, externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", source: "uploader", inputTokens: 555 },
  ]);
  await upsertHourlyRows([
    { hour: `${D}T05`, tool: TOOL, model: MODEL, externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", source: "uploader", inputTokens: 999 },
    { hour: `${Dm1}T05`, tool: TOOL, model: MODEL, externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", source: "uploader", inputTokens: 555 },
  ]);
  const up5 = await upsertSessionRows("ext-legacy", [row({ hour: `${D}T05`, inputTokens: 100 })]);
  const d5 = await deriveUploaderRows("ext-legacy", up5.touched);
  check("[5] divertedLegacy = 1", d5.divertedLegacy === 1, d5);
  check(
    "[5] old row gone from usagedailies for covered date",
    (await UsageDaily.countDocuments({ externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", date: D })) === 0,
  );
  const leg = await UsageDailyLegacy.find({ externalId: "ext-legacy" }).lean();
  check(
    "[5] old row preserved in usagedailylegacies",
    leg.length === 1 &&
      leg[0].date === D &&
      leg[0].machineId === "dev_aaaaaaaaaaaa" &&
      leg[0].inputTokens === 999 &&
      leg[0].sessions === 4 &&
      leg[0].source === "uploader" &&
      leg[0].divertedAt instanceof Date,
    leg,
  );
  check(
    "[5] uncovered date D-1 untouched",
    (await UsageDaily.countDocuments({ externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", date: Dm1, inputTokens: 555 })) === 1,
  );
  const derived5 = await UsageDaily.findOne({ externalId: "ext-legacy", date: D, machineId: "sessions" }).lean();
  check("[5] derived row present for D", derived5?.inputTokens === 100, derived5);
  check(
    "[5] hourly: covered date old row removed, D-1 kept",
    (await UsageHourly.countDocuments({ externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", hour: `${D}T05` })) === 0 &&
      (await UsageHourly.countDocuments({ externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", hour: `${Dm1}T05` })) === 1,
  );
  // Re-running is idempotent (nothing left to divert, backup not duplicated).
  const d5b = await deriveUploaderRows("ext-legacy", up5.touched);
  check(
    "[5] re-derive diverts nothing new",
    d5b.divertedLegacy === 0 && (await UsageDailyLegacy.countDocuments({ externalId: "ext-legacy" })) === 1,
    d5b,
  );
  // A v1 row for the same key arriving later is diverted again by key
  // (backup keeps the latest daily total — no duplicate backup rows).
  await upsertUsageRows([
    { date: D, tool: TOOL, model: MODEL, externalId: "ext-legacy", machineId: "dev_aaaaaaaaaaaa", source: "uploader", inputTokens: 1200 },
  ]);
  const n5c = await divertLegacyRows("ext-legacy", [{ tool: TOOL, date: D }]);
  const leg5c = await UsageDailyLegacy.find({ externalId: "ext-legacy" }).lean();
  check(
    "[5] later v1 row re-diverted onto the same backup key",
    n5c === 1 && leg5c.length === 1 && leg5c[0].inputTokens === 1200,
    { n5c, leg5c },
  );
  check("[5] divertLegacyRows([]) = 0", (await divertLegacyRows("ext-legacy", [])) === 0);
  // Derived rows themselves are never diverted.
  check(
    "[5] derived row survives divert",
    (await UsageDaily.countDocuments({ externalId: "ext-legacy", date: D, machineId: "sessions" })) === 1,
  );

  // ---- 6. poller outranks derived uploader rows ---------------------------
  await upsertUsageRows([
    { date: "2026-09-21", tool: TOOL, model: MODEL, externalId: "ext-poller", machineId: "", source: "poller", inputTokens: 5 },
  ]);
  const up6 = await upsertSessionRows("ext-poller", [row({ hour: "2026-09-21T09", inputTokens: 77 })]);
  await deriveUploaderRows("ext-poller", up6.touched);
  const daily6 = await UsageDaily.find({ externalId: "ext-poller" }).lean();
  check(
    "[6] poller row kept, no derived row written",
    daily6.length === 1 && daily6[0].source === "poller" && daily6[0].inputTokens === 5,
    daily6,
  );

  // ---- 8. superseded buckets (Ruling R8) ---------------------------------
  // v1 put session R's tokens in buckets the v2 parser no longer emits.
  const R = "claude_code:R";
  const up8a = await upsertSessionRows("ext-r8", [
    row({ sessionId: R, parserVersion: 1, hour: "2026-09-25T08", inputTokens: 10 }),
    row({ sessionId: R, parserVersion: 1, hour: "2026-09-25T14", inputTokens: 20 }),
    row({ sessionId: R, parserVersion: 1, hour: "2026-09-25T20", inputTokens: 30 }),
    row({ sessionId: R, parserVersion: 1, hour: "2026-09-26T03", inputTokens: 40 }),
    row({ sessionId: "claude_code:OTHER", parserVersion: 1, hour: "2026-09-25T14", inputTokens: 5 }),
  ]);
  await deriveUploaderRows("ext-r8", up8a.touched);
  // A same-version (v2) bucket outside this batch must survive.
  await UsageSession.create({
    externalId: "ext-r8", tool: TOOL, sessionId: R, hour: "2026-09-25T16", date: "2026-09-25",
    model: MODEL, inputTokens: 7, parserVersion: 2,
  });
  const up8 = await upsertSessionRows("ext-r8", [
    row({ sessionId: R, parserVersion: 2, hour: "2026-09-25T12", inputTokens: 100 }),
    row({ sessionId: R, parserVersion: 2, hour: "2026-09-25T22", inputTokens: 200 }),
  ]);
  const r8 = await UsageSession.find({ externalId: "ext-r8", sessionId: R }).sort({ hour: 1 }).lean();
  check(
    "[8] R buckets = v1 T08 (before min hour) + v2 T12/T16/T22",
    JSON.stringify(r8.map((d) => [d.hour, d.parserVersion, d.inputTokens])) ===
      JSON.stringify([
        ["2026-09-25T08", 1, 10],
        ["2026-09-25T12", 2, 100],
        ["2026-09-25T16", 2, 7],
        ["2026-09-25T22", 2, 200],
      ]),
    r8.map((d) => [d.hour, d.parserVersion, d.inputTokens]),
  );
  check(
    "[8] other session's v1 bucket untouched",
    (await UsageSession.countDocuments({ externalId: "ext-r8", sessionId: "claude_code:OTHER" })) === 1,
  );
  check(
    "[8] touched includes the removed bucket's date",
    up8.touched.some((t) => t.date === "2026-09-26") && up8.touched.some((t) => t.date === "2026-09-25"),
    up8.touched,
  );
  await deriveUploaderRows("ext-r8", up8.touched);
  const d8 = await UsageDaily.find({ externalId: "ext-r8", machineId: "sessions" }).lean();
  check(
    "[8] derived: 09-25 = 10+100+7+200+5, 09-26 gone",
    d8.length === 1 && d8[0].date === "2026-09-25" && d8[0].inputTokens === 322,
    d8,
  );

  // ---- 9. derive re-sums alias variants by canonical model ---------------
  // Docs written before an alias existed keep the raw label; derivation must
  // add them into one canonical row, not let one $set overwrite the other.
  await UsageSession.create([
    { externalId: "ext-alias-derive", tool: TOOL, sessionId: "claude_code:X", hour: "2026-09-27T09", date: "2026-09-27", model: "opus-5", inputTokens: 3, parserVersion: 2 },
    { externalId: "ext-alias-derive", tool: TOOL, sessionId: "claude_code:Y", hour: "2026-09-27T09", date: "2026-09-27", model: MODEL, inputTokens: 4, parserVersion: 2 },
  ]);
  await deriveUploaderRows("ext-alias-derive", [{ tool: TOOL, date: "2026-09-27" }]);
  const d9 = await UsageDaily.find({ externalId: "ext-alias-derive" }).lean();
  check(
    "[9] one canonical daily row, tokens summed, sessions 2",
    d9.length === 1 && d9[0].model === MODEL && d9[0].inputTokens === 7 && d9[0].sessions === 2,
    d9,
  );
  const h9 = await UsageHourly.find({ externalId: "ext-alias-derive" }).lean();
  check(
    "[9] one canonical hourly row, tokens summed",
    h9.length === 1 && h9[0].model === MODEL && h9[0].inputTokens === 7,
    h9,
  );

  // ---- 10. alias-labelled docs merge into the canonical key (F1) ---------
  // A doc stored under a label that a LATER alias entry remaps must not live
  // on beside the canonical doc a resend inserts (double count).
  const D10 = "2026-09-26";
  const T10 = [{ tool: TOOL, date: D10 }];
  const base10 = {
    tool: TOOL, sessionId: "claude_code:AL", hour: `${D10}T09`, date: D10, parserVersion: 2,
  };
  // 10a. alias doc only, resent under the canonical label, same tokens.
  await UsageSession.create({
    ...base10, externalId: "ext-al-a", model: "opus-5",
    inputTokens: 50, outputTokens: 5, requests: 2, machineIds: [A],
  });
  await deriveUploaderRows("ext-al-a", T10);
  const before10a = await UsageDaily.findOne({ externalId: "ext-al-a", machineId: "sessions" }).lean();
  const up10a = await upsertSessionRows("ext-al-a", [
    row({ sessionId: "claude_code:AL", hour: `${D10}T09`, model: MODEL, inputTokens: 50, outputTokens: 5, requests: 2, machineId: B }),
  ]);
  await deriveUploaderRows("ext-al-a", up10a.touched);
  const docs10a = await UsageSession.find({ externalId: "ext-al-a" }).lean();
  check(
    "[10a] exactly one doc, canonical label, values kept",
    docs10a.length === 1 &&
      docs10a[0].model === MODEL &&
      docs10a[0].inputTokens === 50 &&
      docs10a[0].outputTokens === 5 &&
      docs10a[0].requests === 2 &&
      JSON.stringify([...docs10a[0].machineIds].sort()) === JSON.stringify([A, B]),
    docs10a,
  );
  const after10a = await UsageDaily.find({ externalId: "ext-al-a", machineId: "sessions" }).lean();
  check(
    "[10a] derived totals unchanged (50, not 100)",
    before10a?.inputTokens === 50 &&
      after10a.length === 1 &&
      after10a[0].model === MODEL &&
      after10a[0].inputTokens === 50 &&
      after10a[0].sessions === 1,
    { before10a, after10a },
  );
  // 10b. alias AND canonical doc both exist → max-merged into the canonical
  // doc, alias doc deleted.
  await UsageSession.create([
    { ...base10, externalId: "ext-al-b", model: "opus-5", inputTokens: 50, outputTokens: 9 },
    { ...base10, externalId: "ext-al-b", model: MODEL, inputTokens: 40, outputTokens: 20 },
  ]);
  const up10b = await upsertSessionRows("ext-al-b", [
    row({ sessionId: "claude_code:AL", hour: `${D10}T09`, inputTokens: 45, outputTokens: 1 }),
  ]);
  const docs10b = await UsageSession.find({ externalId: "ext-al-b" }).lean();
  check(
    "[10b] one canonical doc = field max {50,20}",
    docs10b.length === 1 &&
      docs10b[0].model === MODEL &&
      docs10b[0].inputTokens === 50 &&
      docs10b[0].outputTokens === 20,
    docs10b,
  );
  check("[10b] touched covers the date", up10b.touched.some((t) => t.date === D10), up10b.touched);
  // 10c. alias doc at an OLDER parser version, resend at a newer one → the
  // newer parser's (lower) numbers win, one doc.
  await UsageSession.create({
    ...base10, externalId: "ext-al-c", model: "opus-5", parserVersion: 1, inputTokens: 80,
  });
  await upsertSessionRows("ext-al-c", [
    row({ sessionId: "claude_code:AL", hour: `${D10}T09`, parserVersion: 2, inputTokens: 60 }),
  ]);
  const docs10c = await UsageSession.find({ externalId: "ext-al-c" }).lean();
  check(
    "[10c] one doc, v2 value 60",
    docs10c.length === 1 &&
      docs10c[0].model === MODEL &&
      docs10c[0].parserVersion === 2 &&
      docs10c[0].inputTokens === 60,
    docs10c,
  );
  // 10d. derivation guard: if an alias and a canonical doc of the SAME
  // (session, hour) coexist anyway, the derived total takes the max, not the
  // sum; distinct sessions still add.
  await UsageSession.create([
    { ...base10, externalId: "ext-al-d", model: "opus-5", inputTokens: 50, outputTokens: 2 },
    { ...base10, externalId: "ext-al-d", model: MODEL, inputTokens: 30, outputTokens: 8 },
    { ...base10, externalId: "ext-al-d", sessionId: "claude_code:OTHER", model: MODEL, inputTokens: 5 },
  ]);
  await deriveUploaderRows("ext-al-d", T10);
  const d10d = await UsageDaily.find({ externalId: "ext-al-d", machineId: "sessions" }).lean();
  const h10d = await UsageHourly.find({ externalId: "ext-al-d", machineId: "sessions" }).lean();
  check(
    "[10d] daily = max(50,30)+5 = 55, out max(2,8) = 8, sessions 2",
    d10d.length === 1 && d10d[0].inputTokens === 55 && d10d[0].outputTokens === 8 && d10d[0].sessions === 2,
    d10d,
  );
  check(
    "[10d] hourly = 55",
    h10d.length === 1 && h10d[0].inputTokens === 55 && h10d[0].outputTokens === 8,
    h10d,
  );
  // 10e. injected canonicalizer (a future ALIASES entry) — same merge.
  const canon10 = (m: string | null | undefined) => (m === "zz-old" ? "zz-new" : (m ?? ""));
  await UsageSession.create({
    ...base10, externalId: "ext-al-e", model: "zz-old", inputTokens: 70,
  });
  const up10e = await upsertSessionRows(
    "ext-al-e",
    [row({ sessionId: "claude_code:AL", hour: `${D10}T09`, model: "zz-new", inputTokens: 70 })],
    { canonicalize: canon10 },
  );
  await deriveUploaderRows("ext-al-e", up10e.touched, { canonicalize: canon10 });
  const docs10e = await UsageSession.find({ externalId: "ext-al-e" }).lean();
  const d10e = await UsageDaily.find({ externalId: "ext-al-e", machineId: "sessions" }).lean();
  check(
    "[10e] injected alias → one doc 'zz-new', derived 70",
    docs10e.length === 1 &&
      docs10e[0].model === "zz-new" &&
      d10e.length === 1 &&
      d10e[0].model === "zz-new" &&
      d10e[0].inputTokens === 70,
    { docs10e, d10e },
  );

  // ---- 11. renamed grok pseudo-sessions (F3, uploader PARSER_VERSION 3) --
  // The grok fallback id changed from raw machineId chars to a sha1 tag, so
  // the old docs have a DIFFERENT sessionId (R8 never sees them). A newer-
  // version fallback row of the same device replaces the device's older
  // fallback docs from its minimum date on.
  const G = "grok";
  const g = (over: Record<string, unknown>) => ({
    externalId: "ext-grok", tool: G, model: "grok-4-fast", parserVersion: 2, inputTokens: 10, ...over,
  });
  await UsageSession.create([
    g({ sessionId: "grok-calebs-m-2026-09-27", hour: "2026-09-27T10", date: "2026-09-27", machineIds: [A] }),
    g({ sessionId: "grok-calebs-m-2026-09-28", hour: "2026-09-28T10", date: "2026-09-28", machineIds: [A] }),
    g({ sessionId: "grok-calebs-m-2026-09-26", hour: "2026-09-26T10", date: "2026-09-26", machineIds: [A] }), // before min date
    g({ sessionId: "grok-otherdev-2026-09-27", hour: "2026-09-27T10", date: "2026-09-27", machineIds: [B] }), // other device
    g({ sessionId: "conv-1", hour: "2026-09-27T11", date: "2026-09-27", machineIds: [A] }), // explicit id
  ]);
  const up11 = await upsertSessionRows("ext-grok", [
    row({ tool: G, model: "grok-4-fast", sessionId: "grok-1a2b3c4d-2026-09-27", hour: "2026-09-27T10", parserVersion: 3, inputTokens: 10, machineId: A }),
    row({ tool: G, model: "grok-4-fast", sessionId: "grok-1a2b3c4d-2026-09-28", hour: "2026-09-28T10", parserVersion: 3, inputTokens: 10, machineId: A }),
  ]);
  const ids11 = (await UsageSession.find({ externalId: "ext-grok" }).lean()).map((d) => d.sessionId).sort();
  check(
    "[11] old fallback ids of device A (>= min date) replaced; others kept",
    JSON.stringify(ids11) ===
      JSON.stringify([
        "conv-1",
        "grok-1a2b3c4d-2026-09-27",
        "grok-1a2b3c4d-2026-09-28",
        "grok-calebs-m-2026-09-26",
        "grok-otherdev-2026-09-27",
      ]),
    ids11,
  );
  await deriveUploaderRows("ext-grok", up11.touched);
  const d11 = await UsageDaily.find({ externalId: "ext-grok", machineId: "sessions" }).sort({ date: 1 }).lean();
  check(
    "[11] derived: 09-27 = 10 (new A) + 10 (B) + 10 (conv-1), 09-28 = 10",
    d11.length === 2 && d11[0].date === "2026-09-27" && d11[0].inputTokens === 30 && d11[1].inputTokens === 10,
    d11.map((d) => [d.date, d.inputTokens]),
  );
  // Same-version resend deletes nothing (only older versions are superseded).
  await UsageSession.create(g({ sessionId: "grok-zzzzzzzz-2026-09-28", hour: "2026-09-28T11", date: "2026-09-28", machineIds: [A], parserVersion: 3 }));
  await upsertSessionRows("ext-grok", [
    row({ tool: G, model: "grok-4-fast", sessionId: "grok-1a2b3c4d-2026-09-28", hour: "2026-09-28T10", parserVersion: 3, inputTokens: 10, machineId: A }),
  ]);
  check(
    "[11] same-version fallback doc kept",
    (await UsageSession.countDocuments({ externalId: "ext-grok", sessionId: "grok-zzzzzzzz-2026-09-28" })) === 1,
  );

  // ---- 7. sessionCoverage ------------------------------------------------
  const cov = await sessionCoverage("ext-legacy", [
    { tool: TOOL, date: D },
    { tool: TOOL, date: Dm1 },
    { tool: "codex", date: D },
  ]);
  check("[7] coverage = only covered pair", cov.size === 1 && cov.has(`${TOOL}|${D}`), [...cov]);
  check("[7] coverage empty input", (await sessionCoverage("ext-legacy", [])).size === 0);
  check(
    "[7] coverage scoped by externalId",
    (await sessionCoverage("ext-nobody", [{ tool: TOOL, date: D }])).size === 0,
  );

  // Claude organization tag: stored with the bucket, upgraded only by stronger
  // evidence, never part of the key (so it cannot split or double a session).
  await UsageSession.deleteMany({});
  const TEAM_ORG = "11111111-1111-4111-8111-111111111111";
  const OWN_ORG = "22222222-2222-4222-8222-222222222222";
  const acct = (over: Partial<UsageSessionRow> = {}) =>
    row({ sessionId: "claude_code:ACC", inputTokens: 5, requests: 1, ...over });
  const acctDocs = () => UsageSession.find({ externalId: "ext-acct" }).lean();
  await upsertSessionRows("ext-acct", [acct({ machineId: A })]);
  let ad = await acctDocs();
  check("account: untagged row stores no organization", ad.length === 1 && (ad[0].accountOrg ?? "") === "" && (ad[0].accountEvidence ?? "") === "", ad);
  await upsertSessionRows("ext-acct", [acct({ machineId: B, accountOrg: TEAM_ORG, accountEvidence: "hook" })]);
  ad = await acctDocs();
  check("account: a later tagged resend tags the same doc", ad.length === 1 && ad[0].accountOrg === TEAM_ORG && ad[0].accountEvidence === "hook" && ad[0].inputTokens === 5, ad);
  await upsertSessionRows("ext-acct", [acct()]);
  ad = await acctDocs();
  check("account: an untagged resend keeps the tag", ad.length === 1 && ad[0].accountOrg === TEAM_ORG, ad);
  await upsertSessionRows("ext-acct", [acct({ accountOrg: OWN_ORG, accountEvidence: "transcript" })]);
  ad = await acctDocs();
  check("account: transcript evidence replaces hook evidence", ad.length === 1 && ad[0].accountOrg === OWN_ORG && ad[0].accountEvidence === "transcript", ad);
  await upsertSessionRows("ext-acct", [acct({ accountOrg: TEAM_ORG, accountEvidence: "hook" })]);
  ad = await acctDocs();
  check("account: hook evidence does not replace transcript evidence", ad[0].accountOrg === OWN_ORG && ad[0].accountEvidence === "transcript", ad);
  await upsertSessionRows("ext-acct", [acct({ parserVersion: 3, inputTokens: 4 })]);
  ad = await acctDocs();
  check("account: a newer parser's untagged row keeps the tag", ad.length === 1 && ad[0].parserVersion === 3 && ad[0].inputTokens === 4 && ad[0].accountOrg === OWN_ORG, ad);
  await upsertSessionRows("ext-acct", [acct({ parserVersion: 3, accountOrg: TEAM_ORG, accountEvidence: "transcript" })]);
  ad = await acctDocs();
  check("account: two organizations at the same strength become mixed", ad.length === 1 && ad[0].accountOrg === "mixed" && ad[0].accountEvidence === "transcript", ad);
  await upsertSessionRows("ext-acct2", [
    acct({ accountOrg: TEAM_ORG, accountEvidence: "hook" }),
    acct({ accountOrg: OWN_ORG, accountEvidence: "hook" }),
  ]);
  const ad2 = await UsageSession.find({ externalId: "ext-acct2" }).lean();
  check("account: same key twice in one request merges to one mixed doc", ad2.length === 1 && ad2[0].accountOrg === "mixed" && ad2[0].inputTokens === 5, ad2);

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
