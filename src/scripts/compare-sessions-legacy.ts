import "./env";
// READ-ONLY comparison of session-grained usage (usagesessions) against the v1
// uploader daily totals it superseded (usagedailylegacies + remaining v1
// usagedailies rows), for ONE member. Prints a tool x machine x date
// difference table; never writes.
//
//   pnpm compare-sessions --member kim@example.com [--json] [--no-wait]
//
// Prints the database name and waits 5 seconds before querying so a wrong
// MONGODB_URI can be Ctrl-C'd (--no-wait is for tests only).
//
// Sessions: each session doc counts ONCE in the per-date total; in the
// per-machine view it is attributed to every machineIds entry (a duplicated
// session appears under each machine, so machine rows may sum above the total).
// Legacy dates are the v1 row's own date: UTC-day only before uploader commit
// 0cf15e4 (2026-07-27), KST-day after; session dates are KST — a small shift at day edges is expected and shows up as +/- pairs.
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

export const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "requests",
] as const;
export type Field = (typeof FIELDS)[number];
export type Vals = Record<Field, number>;

export type DiffRow = {
  tool: string;
  machine: string; // "*" = per-date total (sessions counted once)
  date: string;
  sessions: Vals;
  legacy: Vals;
  diff: Vals; // sessions - legacy
};
export type ToolSummary = { tool: string; sessions: Vals; legacy: Vals; diff: Vals };
export type Comparison = { rows: DiffRow[]; summary: ToolSummary[] };

const NO_MACHINE = "(none)";
const zero = (): Vals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests: 0,
});
function addTo(acc: Vals, src: Partial<Record<Field, number | null>>) {
  for (const f of FIELDS) acc[f] += src[f] ?? 0;
}
const sub = (a: Vals, b: Vals): Vals => {
  const out = zero();
  for (const f of FIELDS) out[f] = a[f] - b[f];
  return out;
};

export async function compareForMember(email: string): Promise<Comparison> {
  // Members are stored as typed on `member add` (no lowercase in the schema),
  // so match the trimmed input and its lowercase form.
  const typed = email.trim();
  const member = await Member.findOne({
    email: { $in: [...new Set([typed, typed.toLowerCase()])] },
  }).lean();
  if (!member) throw new Error(`no member with email ${email}`);
  const identities = await MemberIdentity.find({ memberId: member._id }).lean();
  const externalIds = [...new Set(identities.map((i) => i.externalId))];
  const owner = { $or: [{ memberId: member._id }, { externalId: { $in: externalIds } }] };

  const [sessionDocs, legacyDocs, liveDocs] = await Promise.all([
    UsageSession.find(owner).lean(),
    UsageDailyLegacy.find(owner).lean(),
    UsageDaily.find({ ...owner, source: "uploader", machineId: { $ne: "sessions" } }).lean(),
  ]);

  // Legacy union, keyed by the usagedailies identity; a live row wins a tie.
  const legacyByKey = new Map<string, (typeof legacyDocs)[number] | (typeof liveDocs)[number]>();
  for (const d of [...legacyDocs, ...liveDocs]) {
    legacyByKey.set(JSON.stringify([d.date, d.tool, d.model, d.externalId, d.machineId]), d);
  }

  const cells = new Map<string, DiffRow>();
  const cell = (tool: string, machine: string, date: string): DiffRow => {
    const k = JSON.stringify([tool, machine, date]);
    let r = cells.get(k);
    if (!r) {
      r = { tool, machine, date, sessions: zero(), legacy: zero(), diff: zero() };
      cells.set(k, r);
    }
    return r;
  };

  for (const s of sessionDocs) {
    addTo(cell(s.tool, "*", s.date).sessions, s);
    const machines = s.machineIds.length > 0 ? s.machineIds : [NO_MACHINE];
    for (const m of machines) addTo(cell(s.tool, m, s.date).sessions, s);
  }
  for (const d of legacyByKey.values()) {
    addTo(cell(d.tool, "*", d.date).legacy, d);
    addTo(cell(d.tool, d.machineId === "" ? NO_MACHINE : d.machineId, d.date).legacy, d);
  }

  const rows = [...cells.values()].sort(
    (a, b) =>
      a.tool.localeCompare(b.tool) ||
      a.date.localeCompare(b.date) ||
      (a.machine === "*" ? -1 : b.machine === "*" ? 1 : a.machine.localeCompare(b.machine)),
  );
  for (const r of rows) r.diff = sub(r.sessions, r.legacy);

  const byTool = new Map<string, ToolSummary>();
  for (const r of rows) {
    if (r.machine !== "*") continue;
    let t = byTool.get(r.tool);
    if (!t) {
      t = { tool: r.tool, sessions: zero(), legacy: zero(), diff: zero() };
      byTool.set(r.tool, t);
    }
    addTo(t.sessions, r.sessions);
    addTo(t.legacy, r.legacy);
  }
  const summary = [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool));
  for (const t of summary) t.diff = sub(t.sessions, t.legacy);
  return { rows, summary };
}

const fmt = (v: Vals) => FIELDS.map((f) => String(v[f])).join("/");

function printTable(email: string, c: Comparison) {
  console.log(`member: ${email}`);
  console.log("values: input/output/cacheRead/cacheCreation/requests");
  console.log(["tool", "machine", "date", "sessions", "legacy", "sessions-legacy"].join("\t"));
  for (const r of c.rows) {
    console.log([r.tool, r.machine, r.date, fmt(r.sessions), fmt(r.legacy), fmt(r.diff)].join("\t"));
  }
  console.log("\nsummary (sessions - legacy):");
  for (const t of c.summary) {
    console.log(`${t.tool}\tsessions ${fmt(t.sessions)}\tlegacy ${fmt(t.legacy)}\tdiff ${fmt(t.diff)}`);
  }
}

async function main() {
  const argv = process.argv;
  const mi = argv.indexOf("--member");
  const email = mi >= 0 ? argv[mi + 1] : undefined;
  if (!email || email.startsWith("--")) {
    console.error("usage: compare-sessions --member <email> [--json] [--no-wait]");
    process.exit(1);
  }
  const json = argv.includes("--json");
  // Read-only: mongoose must not create missing collections/indexes on connect
  // (a write, e.g. against production before the v2 rollout).
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await connectDb();
  const log = json ? console.error : console.log;
  log(`database: ${mongoose.connection.name} (read-only)`);
  if (!argv.includes("--no-wait")) {
    log("querying in 5 seconds — Ctrl-C to abort");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const c = await compareForMember(email);
  if (json) console.log(JSON.stringify({ database: mongoose.connection.name, member: email, ...c }, null, 2));
  else printTable(email, c);
}

if (/(^|\/)compare-sessions-legacy\.ts$/.test(process.argv[1] ?? "")) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
