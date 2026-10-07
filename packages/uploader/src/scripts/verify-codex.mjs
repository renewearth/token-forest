// Unit tests for the codex parser's pure core (foldSession) and the rate-limit
// snapshot (Task 9). Run with node. File cases use a temp dir — never the real
// ~/.codex.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import * as codex from "../parsers/codex.mjs";
const { foldSession, assembleRows } = codex;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

// helper: build a token_count line with cumulative totals
const tc = (ts, input, cached, output) => ({
  type: "event_msg",
  timestamp: ts,
  payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  } },
});
const ctx = (model) => ({ type: "turn_context", payload: { model } });

// 1. Two cumulative snapshots, same model/day: diffs are attributed, input excludes cached.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("2026-06-26T02:00:00Z", 100, 0, 10),
    tc("2026-06-26T02:05:00Z", 250, 50, 30),
  ]);
  eq("two snapshots -> 2 events", ev.length, 2);
  eq("e1 input", ev[0].inputTokens, 100);
  eq("e1 cacheRead", ev[0].cacheReadTokens, 0);
  eq("e1 output", ev[0].outputTokens, 10);
  eq("e1 model", ev[0].model, "gpt-5.5");
  eq("e1 date", ev[0].date, "2026-06-26");
  // delta in=150, cached=50 -> input=100, cacheRead=50, output=20
  eq("e2 input (excl cached)", ev[1].inputTokens, 100);
  eq("e2 cacheRead", ev[1].cacheReadTokens, 50);
  eq("e2 output", ev[1].outputTokens, 20);
}

// 2. Repeated identical snapshot adds nothing.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("2026-06-26T02:00:00Z", 100, 0, 10),
    tc("2026-06-26T02:00:01Z", 100, 0, 10),
  ]);
  eq("repeated snapshot -> 1 event", ev.length, 1);
}

// 3. Reset (total drops) starts a fresh baseline and counts the full new total.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("2026-06-26T02:00:00Z", 200, 0, 20),
    tc("2026-06-26T03:00:00Z", 50, 0, 5), // new session/compaction reset
  ]);
  eq("reset -> 2 events", ev.length, 2);
  eq("reset e2 input full", ev[1].inputTokens, 50);
}

// 4. Model switch via turn_context attributes the later delta to the new model.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("2026-06-26T02:00:00Z", 100, 0, 10),
    ctx("gpt-5.3-codex"),
    tc("2026-06-26T02:05:00Z", 180, 0, 25),
  ]);
  eq("e2 model switched", ev[1].model, "gpt-5.3-codex");
}

// 5. KST day boundary: 15:00Z + 9h crosses to next KST day.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("2026-06-26T15:00:00Z", 100, 0, 10),
  ]);
  eq("KST boundary date", ev[0].date, "2026-06-27");
  eq("KST hour", ev[0].hour, "2026-06-27T00");
}

// 6. Malformed timestamp is skipped without crashing.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("not-a-date", 100, 0, 10),
    tc("2026-06-26T02:05:00Z", 200, 0, 20),
  ]);
  eq("malformed timestamp skipped -> 1 event", ev.length, 1);
  eq("malformed timestamp: surviving event input", ev[0].inputTokens, 200);
}

// 7. Partial-field drop (a field missing from a snapshot) must not force a
// full-total rebaseline of the other fields, which would double-count them.
{
  const ev = foldSession([
    ctx("gpt-5.5"),
    tc("2026-06-26T02:00:00Z", 100, 50, 10),
    {
      type: "event_msg",
      timestamp: "2026-06-26T02:05:00Z",
      payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 150, output_tokens: 15 }, // cached_input_tokens omitted
      } },
    },
  ]);
  eq("partial-field drop -> 2 events", ev.length, 2);
  // The missing cached field cannot establish non-cache input for this event.
  eq("partial-field drop: outputTokens delta not double-counted", ev[1].outputTokens, 5);
  eq("partial-field drop: inputTokens unknown", ev[1].inputTokens, null);
  eq("partial-field drop: cacheReadTokens unknown", ev[1].cacheReadTokens, null);
  eq("partial-field drop: cache creation unsupported", ev[1].fieldEvidence.cacheCreationTokens, "unsupported");
}

// assembleRows: merge per-file event lists into daily rows + hourly mirror.
{
  const fileA = [
    { date: "2026-06-26", hour: "2026-06-26T02", model: "gpt-5.5",
      inputTokens: 100, cacheReadTokens: 0, outputTokens: 10, cacheCreationTokens: 0 },
    { date: "2026-06-26", hour: "2026-06-26T02", model: "gpt-5.5",
      inputTokens: 50, cacheReadTokens: 20, outputTokens: 5, cacheCreationTokens: 0 },
  ];
  const fileB = [
    { date: "2026-06-26", hour: "2026-06-26T09", model: "gpt-5.5",
      inputTokens: 30, cacheReadTokens: 0, outputTokens: 3, cacheCreationTokens: 0 },
  ];
  const { rows, hourlyRows } = assembleRows([fileA, fileB], "test-host");

  eq("one daily row (same date|model)", rows.length, 1);
  eq("row tool", rows[0].tool, "codex");
  eq("row input summed", rows[0].inputTokens, 180);
  eq("row cacheRead summed", rows[0].cacheReadTokens, 20);
  eq("row output summed", rows[0].outputTokens, 18);
  eq("row requests = events", rows[0].requests, 3);
  eq("row machineId", rows[0].machineId, "test-host");
  eq("row source", rows[0].source, "uploader");
  // two files active that day -> sessions = 2, on the (only/first) row
  eq("sessions = distinct files that day", rows[0].sessions, 2);
  // hourly mirror keeps the two hours distinct
  eq("two hourly rows", hourlyRows.length, 2);
}

// assembleRows: two models same day, one file -> sessions on first row only.
{
  const f = [
    { date: "2026-06-30", hour: "2026-06-30T01", model: "gpt-5.5",
      inputTokens: 10, cacheReadTokens: 0, outputTokens: 1, cacheCreationTokens: 0 },
    { date: "2026-06-30", hour: "2026-06-30T01", model: "gpt-5.3-codex",
      inputTokens: 20, cacheReadTokens: 0, outputTokens: 2, cacheCreationTokens: 0 },
  ];
  const { rows } = assembleRows([f], "h");
  eq("two models same day -> 2 rows", rows.length, 2);
  // rows sorted by model: 'gpt-5.3-codex' before 'gpt-5.5'
  eq("first row of day carries sessions=1", rows[0].sessions, 1);
  eq("second same-day row sessions=null", rows[1].sessions, null);
}

// assembleRows: one file spanning two KST days -> +1 session on EACH day.
{
  const f = [
    { date: "2026-06-30", hour: "2026-06-30T23", model: "gpt-5.5",
      inputTokens: 10, cacheReadTokens: 0, outputTokens: 1, cacheCreationTokens: 0 },
    { date: "2026-07-01", hour: "2026-07-01T00", model: "gpt-5.5",
      inputTokens: 20, cacheReadTokens: 0, outputTokens: 2, cacheCreationTokens: 0 },
  ];
  const { rows } = assembleRows([f], "h");
  eq("file spanning 2 days -> 2 rows", rows.length, 2);
  eq("day1 sessions=1", rows[0].sessions, 1);
  eq("day2 sessions=1", rows[1].sessions, 1);
}


// ─── Task 9: rate-limit snapshots ───────────────────────────────────────────
// Real shape (measured 2026-09-30): token_count event_msg lines carry
// payload.rate_limits = { limit_id, limit_name, primary, secondary, credits }.
const rl = (ts, primary, secondary, limitId = "codex") => ({
  type: "event_msg", timestamp: ts,
  payload: { type: "token_count", info: null, rate_limits: {
    limit_id: limitId, limit_name: null, primary, secondary,
    credits: { has_credits: false, unlimited: false, balance: null },
  } },
});
const win = (used, minutes, resetsAt) => ({ used_percent: used, window_minutes: minutes, resets_at: resetsAt });
const NOW = new Date("2026-09-30T20:00:00Z"); // KST 2026-10-01 05:00
const NOW_S = NOW.getTime() / 1000;
const RESET = 1791217347; // 2026-10-05T16:22:27Z, after NOW
const RESET_ISO = new Date(RESET * 1000).toISOString();
const RESET_5H = NOW_S + 3600; // 1h after NOW
const EV = Date.parse("2026-09-30T19:30:00Z"); // event 30 min before NOW
const MID = "0123abcd-4567-89ef-0123-456789abcdef"; // pseudonymous device-id
// organization tag = sha1(machineId)[0:8] — never raw machineId chars (F3)
const ORG = `device:${createHash("sha1").update(MID).digest("hex").slice(0, 8)}`;

{
  check("T9: latestLimits exported", typeof codex.latestLimits === "function");
  check("T9: limitsToSnapshots exported", typeof codex.limitsToSnapshots === "function");
  check("T9: latestRateLimits exported", typeof codex.latestRateLimits === "function");
  check("T9: snapshotLimits exported", typeof codex.snapshotLimits === "function");
}

// primary only (secondary null) → one snapshot, exact values; resets_at s → ISO;
// organization = "device:" + sha1(machineId)[0:8]
if (typeof codex.limitsToSnapshots === "function") {
  const snaps = codex.limitsToSnapshots(rl("x", win(2.0, 10080, RESET), null).payload.rate_limits,
    { now: NOW, eventTs: EV, machineId: MID });
  eq("T9 primary only: snapshots", snaps, [{
    date: "2026-10-01", accountEmail: "codex:codex", organization: ORG, window: "codex_10080m",
    utilizationPct: 2, resetsAt: RESET_ISO,
  }]);
  eq("T9 resets_at seconds → ISO", RESET_ISO, "2026-10-05T16:22:27.000Z"); // date -u -r 1791217347
  eq("R23 no machineId → organization \"\"",
    codex.limitsToSnapshots({ primary: win(2, 10080, RESET) }, { now: NOW, eventTs: EV })[0]?.organization, "");
  eq("R23 empty machineId → organization \"\"",
    codex.limitsToSnapshots({ primary: win(2, 10080, RESET) }, { now: NOW, eventTs: EV, machineId: "" })[0]?.organization, "");

  // both windows → 300m + 10080m
  const both = codex.limitsToSnapshots(
    rl("x", win(41.5, 300, RESET_5H), win(12, 10080, RESET)).payload.rate_limits, { now: NOW, eventTs: EV, machineId: MID });
  eq("T9 both: windows", both.map((s) => `${s.accountEmail}|${s.organization}|${s.window}|${s.utilizationPct}|${s.resetsAt}`), [
    `codex:codex|${ORG}|codex_300m|41.5|${new Date(RESET_5H * 1000).toISOString()}`,
    `codex:codex|${ORG}|codex_10080m|12|${RESET_ISO}`,
  ]);
  // primary null + secondary present → only secondary
  eq("T9 primary null → secondary only",
    codex.limitsToSnapshots(rl("x", null, win(7, 10080, RESET)).payload.rate_limits, { now: NOW, eventTs: EV }).map((s) => s.window),
    ["codex_10080m"]);
  // missing resets_at → null (freshness then rests on the event age alone)
  eq("T9 no resets_at → resetsAt null",
    codex.limitsToSnapshots({ limit_id: "codex", primary: { used_percent: 3, window_minutes: 300 } }, { now: NOW, eventTs: EV })[0]?.resetsAt, null);
  eq("T9 window without minutes skipped",
    codex.limitsToSnapshots({ limit_id: "codex", primary: { used_percent: 3 }, secondary: { window_minutes: 10080 } }, { now: NOW, eventTs: EV }), []);
  eq("T9 missing limit_id → codex:codex",
    codex.limitsToSnapshots({ primary: win(1, 300, RESET_5H) }, { now: NOW, eventTs: EV })[0]?.accountEmail, "codex:codex");
  eq("T9 null → []", codex.limitsToSnapshots(null, { now: NOW, eventTs: EV }), []);

  // R23 freshness: a window whose reset already passed, or whose reading is
  // older than the window itself, is stale → skipped; the other window stays.
  eq("R23 expired resets_at → skipped",
    codex.limitsToSnapshots({ primary: win(80, 300, NOW_S - 60), secondary: win(12, 10080, RESET) }, { now: NOW, eventTs: EV }).map((s) => s.window),
    ["codex_10080m"]);
  eq("R23 resets_at == now → skipped",
    codex.limitsToSnapshots({ primary: win(80, 300, NOW_S) }, { now: NOW, eventTs: EV }), []);
  const old6h = NOW.getTime() - 6 * 3600_000; // older than 300m, younger than 10080m
  eq("R23 event older than the window → skipped",
    codex.limitsToSnapshots({ primary: win(80, 300, RESET_5H), secondary: win(12, 10080, RESET) }, { now: NOW, eventTs: old6h }).map((s) => s.window),
    ["codex_10080m"]);
  eq("R23 event exactly window-old → kept",
    codex.limitsToSnapshots({ primary: win(80, 300, RESET_5H) }, { now: NOW, eventTs: NOW.getTime() - 300 * 60_000 }).map((s) => s.window),
    ["codex_300m"]);
  eq("R23 event 8 days old → both skipped",
    codex.limitsToSnapshots({ primary: win(80, 300, RESET_5H), secondary: win(12, 10080, RESET) }, { now: NOW, eventTs: NOW.getTime() - 8 * 86400_000 }), []);
  eq("R23 no event timestamp → skipped (freshness unknown)",
    codex.limitsToSnapshots({ primary: win(80, 10080, RESET) }, { now: NOW }), []);
  eq("R23 fresh → sent",
    codex.limitsToSnapshots({ primary: win(80, 300, RESET_5H) }, { now: NOW, eventTs: EV }).map((s) => `${s.window}|${s.utilizationPct}`),
    ["codex_300m|80"]);
}

// latestRateLimits: the most recent (by timestamp) rate_limits event; none → null
if (typeof codex.latestRateLimits === "function") {
  const lines = [
    ctx("gpt-5.5"),
    rl("2026-09-30T01:00:00Z", win(10, 10080, RESET), null),
    tc("2026-09-30T01:01:00Z", 100, 0, 10),
    rl("2026-09-30T02:00:00Z", win(11, 10080, RESET), null),
    rl("2026-09-30T01:30:00Z", win(99, 10080, RESET), null), // out of order: older
  ];
  const got = codex.latestRateLimits(lines);
  eq("T9 latestRateLimits picks newest ts", got?.rateLimits?.primary?.used_percent, 11);
  eq("R23 latestRateLimits returns the event ts (ms)", got?.ts, Date.parse("2026-09-30T02:00:00Z"));
  eq("T9 latestRateLimits none → null", codex.latestRateLimits([ctx("gpt-5.5"), tc("2026-09-30T01:01:00Z", 1, 0, 1)]), null);
}

// latestLimits(files): newest rate_limits across the most recently modified
// rollout files; no rate_limits anywhere → []; stale windows dropped
if (typeof codex.latestLimits === "function") {
  const dir = mkdtempSync(path.join(tmpdir(), "tf-codex-limits-"));
  const write = (name, lines, mtime) => {
    const f = path.join(dir, name);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
    utimesSync(f, mtime, mtime);
    return f;
  };
  const a = write("rollout-a.jsonl", [ctx("gpt-5.5"), rl("2026-09-30T19:00:00Z", win(40, 300, RESET_5H), win(20, 10080, RESET))],
    new Date("2026-09-30T19:00:00Z"));
  const b = write("rollout-b.jsonl", [ctx("gpt-5.5"), rl("2026-09-29T03:00:00Z", win(5, 10080, RESET), null), "{broken"],
    new Date("2026-09-29T03:00:00Z"));
  const c = write("rollout-c.jsonl", [ctx("gpt-5.5"), tc("2026-09-30T19:30:00Z", 1, 0, 1)], new Date("2026-09-30T19:30:00Z"));
  const snaps = await codex.latestLimits([b, c, a], { now: NOW, machineId: MID });
  eq("T9 latestLimits across files", snaps.map((s) => `${s.window}|${s.utilizationPct}|${s.organization}`),
    [`codex_300m|40|${ORG}`, `codex_10080m|20|${ORG}`]);
  eq("T9 latestLimits date is KST today", snaps.map((s) => s.date), ["2026-10-01", "2026-10-01"]);
  eq("T9 latestLimits none → []", await codex.latestLimits([c], { now: NOW }), []);
  eq("T9 latestLimits no files → []", await codex.latestLimits([], { now: NOW }), []);
  eq("T9 latestLimits missing file ignored", (await codex.latestLimits([path.join(dir, "gone.jsonl"), b], { now: NOW })).map((s) => s.utilizationPct), [5]);
  // the newest event is 3 days old: its 300m window is stale, the weekly one is not
  const d = write("rollout-d.jsonl", [ctx("gpt-5.5"), rl("2026-09-27T20:00:00Z", win(90, 300, RESET_5H), win(30, 10080, RESET))],
    new Date("2026-09-27T20:00:00Z"));
  eq("R23 latestLimits drops the stale 300m window", (await codex.latestLimits([d], { now: NOW })).map((s) => s.window), ["codex_10080m"]);

  // snapshotLimits(): walks ~/.codex/sessions under HOME
  const home = mkdtempSync(path.join(tmpdir(), "tf-codex-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  eq("T9 snapshotLimits empty HOME → []", await codex.snapshotLimits({ now: NOW }), []);
  const f = path.join(home, ".codex", "sessions", "2026", "09", "30", "rollout-2026-09-30T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl");
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(rl("2026-09-30T19:00:00Z", win(2.0, 10080, RESET), null)) + "\n");
  eq("T9 snapshotLimits reads HOME rollouts", (await codex.snapshotLimits({ now: NOW, machineId: MID })).map((s) => `${s.accountEmail}|${s.organization}|${s.window}|${s.utilizationPct}`),
    [`codex:codex|${ORG}|codex_10080m|2`]);
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
