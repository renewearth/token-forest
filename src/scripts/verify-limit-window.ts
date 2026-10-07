// Plan-limit window labels (limits.tsx) and the Codex snapshot shape the
// uploader sends to /api/limits (server schema unchanged). No DB.
import { createHash } from "node:crypto";
import { windowLabel, organizationLabels } from "@/lib/limit-window";
import { limitsPayloadSchema, limitSnapshotSchema } from "@/lib/types";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}
function eq(label: string, a: unknown, b: unknown) {
  check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));
}

// Claude windows keep their labels.
eq("five_hour", windowLabel("five_hour"), "5시간 창");
eq("seven_day", windowLabel("seven_day"), "7일 창");
eq("seven_day_opus", windowLabel("seven_day_opus"), "7일 창 (Opus)");
// Codex windows (Task 9).
eq("codex_300m", windowLabel("codex_300m"), "codex 5시간");
eq("codex_10080m", windowLabel("codex_10080m"), "codex 주간");
eq("codex_60m", windowLabel("codex_60m"), "codex 60분");
eq("codex_1440m", windowLabel("codex_1440m"), "codex 1440분");
// Anything else passes through.
eq("unknown passes through", windowLabel("something_else"), "something_else");
eq("codex_ without minutes passes through", windowLabel("codex_m"), "codex_m");

// R23: organization labels. Claude orgs pass through; Codex "device:<8>" orgs
// become the same pseudonymous "기기 N" the /me devices table shows (matched
// by id prefix) — never the raw id; without a device list they are numbered
// among themselves.
{
  const m1 = "0123abcd-4567-89ef-0123-456789abcdef";
  const m2 = "feedbeef-0000-4000-8000-000000000000";
  const withIds = organizationLabels(["", "Acme Team", "device:feedbeef", "device:0123abcd", "device:99999999"], [m2, m1, ""]);
  eq("org '' stays ''", withIds.get(""), "");
  eq("claude org passes through", withIds.get("Acme Team"), "Acme Team");
  eq("device org → /me label (기기 1 = smallest id)", withIds.get("device:0123abcd"), "기기 1");
  eq("device org → /me label (기기 2)", withIds.get("device:feedbeef"), "기기 2");
  eq("unknown device → 기기 (no raw id)", withIds.get("device:99999999"), "기기");
  const noIds = organizationLabels(["device:feedbeef", "Acme", "device:0123abcd", "device:feedbeef"]);
  eq("no device list → numbered among device orgs", [noIds.get("device:0123abcd"), noIds.get("device:feedbeef"), noIds.get("Acme")], ["기기 1", "기기 2", "Acme"]);
  check("labels never contain the raw id prefix", ![...withIds.values(), ...noIds.values()].some((v) => /0123abcd|feedbeef|99999999/.test(v)));
  // F3: uploader PARSER_VERSION 3 tags orgs with sha1(machineId)[0:8]; they
  // map to the same /me label (legacy raw-prefix orgs still match too).
  const tag = (m: string) => createHash("sha1").update(m).digest("hex").slice(0, 8);
  const hashed = organizationLabels([`device:${tag(m1)}`, `device:${tag(m2)}`], [m2, m1]);
  eq("hashed device org → /me label (기기 1)", hashed.get(`device:${tag(m1)}`), "기기 1");
  eq("hashed device org → /me label (기기 2)", hashed.get(`device:${tag(m2)}`), "기기 2");
}

// The uploader's Codex snapshots validate against the unchanged schema.
const codexSnap = {
  date: "2026-10-01",
  accountEmail: "codex:codex",
  organization: "",
  window: "codex_10080m",
  utilizationPct: 2,
  resetsAt: "2026-10-05T16:22:27.000Z",
};
check("codex snapshot validates", limitSnapshotSchema.safeParse(codexSnap).success);
check(
  "codex 300m snapshot validates",
  limitSnapshotSchema.safeParse({ ...codexSnap, window: "codex_300m", utilizationPct: 41.5 }).success,
);
check("codex snapshot resetsAt null validates", limitSnapshotSchema.safeParse({ ...codexSnap, resetsAt: null }).success);
check(
  "payload with claude + codex validates",
  limitsPayloadSchema.safeParse({
    snapshots: [
      { date: "2026-10-01", accountEmail: "a@b.c", organization: "org", window: "five_hour", utilizationPct: 10 },
      codexSnap,
    ],
  }).success,
);

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("ALL PASS");
