// Tests for session-grained rows (collection v2): the shared bucketing core
// (lib/sessions.mjs) and the `sessions` + `health` output of the claude-code,
// codex, gemini and grok parsers. Run with node. Uses a temporary HOME per case
// (os.homedir() honours $HOME) — never touches real tool logs.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

const { bucketEvents, PARSER_VERSION } = await import("../lib/sessions.mjs");
const claudeCode = await import("../parsers/claude-code.mjs");
const codex = await import("../parsers/codex.mjs");
const gemini = await import("../parsers/gemini.mjs");
const grok = await import("../parsers/grok.mjs");

const tmpHomes = [];
function freshHome() {
  const dir = mkdtempSync(path.join(tmpdir(), "tf-sessions-"));
  tmpHomes.push(dir);
  process.env.HOME = dir;
  return dir;
}
function writeLines(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests"];
function totals(rows) {
  const t = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0]));
  for (const r of rows) for (const f of TOKEN_FIELDS) t[f] += r[f];
  return t;
}

// fixture builders -----------------------------------------------------------
const ccLine = (sessionId, msgId, reqId, ts, model, u) => ({
  type: "assistant", sessionId, requestId: reqId, timestamp: ts,
  message: { id: msgId, model, usage: {
    input_tokens: u[0], output_tokens: u[1],
    cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3],
  } },
});
const cxCtx = (model) => ({ type: "turn_context", payload: { model } });
const cxTc = (ts, input, cached, output) => ({
  type: "event_msg", timestamp: ts,
  payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  } },
});
const gmTurn = (id, ts, model, input, cached, output, thoughts) => ({
  id, timestamp: ts, type: "gemini", model,
  tokens: { input, output, cached, thoughts, tool: 0, total: input + output + thoughts },
});
const gkLine = (ts, model, pt, ct, extra = {}) => ({
  ts, tool: "chat", model, prompt_tokens: pt, completion_tokens: ct,
  total_tokens: pt + ct, cost_in_usd_ticks: 0, ...extra,
});
const ev = (sessionId, ts, model, i, o, cr, cc) => ({
  tool: "claude_code", sessionId, ts, model,
  inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc,
});

// 1. bucketEvents: same session + hour + model -> one row, requests = 3, sums.
{
  const rows = bucketEvents([
    ev("s1", "2026-09-29T01:00:00Z", "opus", 10, 1, 100, 5),
    ev("s1", "2026-09-29T01:10:00Z", "opus", 20, 2, 200, 6),
    ev("s1", "2026-09-29T01:59:59Z", "opus", 30, 3, 300, 7),
  ]);
  eq("1: one row", rows.length, 1);
  eq("1: row", {
    ...Object.fromEntries(["tool", "sessionId", "hour", "model", "provider", ...TOKEN_FIELDS, "parserVersion"].map((f) => [f, rows[0][f]])),
  }, {
    tool: "claude_code", sessionId: "s1", hour: "2026-09-29T10", model: "opus", provider: "",
    inputTokens: 60, outputTokens: 6, cacheReadTokens: 600, cacheCreationTokens: 18,
    requests: 3, parserVersion: 4,
  });
  eq("1: PARSER_VERSION", PARSER_VERSION, 4);
  eq("1: KST basis", rows[0].dateBasis, "KST");
  eq("1: input evidence", rows[0].fieldEvidence.inputTokens, "known");
}

// Absent values remain null; explicit zero is known and a partial sum keeps
// its numeric observation while evidence says the bucket is incomplete.
{
  const rows = bucketEvents([
    { ...ev("partial", "2026-09-29T01:00:00Z", "m", 0, null, null, null),
      fieldEvidence: { cacheCreationTokens: "unsupported" } },
    { ...ev("partial", "2026-09-29T01:01:00Z", "m", null, 2, null, null),
      fieldEvidence: { cacheCreationTokens: "unsupported" } },
  ]);
  eq("null: observed zero retained", rows[0].inputTokens, 0);
  eq("null: partial evidence", rows[0].fieldEvidence.inputTokens, "unknown");
  eq("null: no cache read", rows[0].cacheReadTokens, null);
  eq("null: unsupported cache write", rows[0].fieldEvidence.cacheCreationTokens, "unsupported");
  eq("null: observed output", rows[0].outputTokens, 2);
}

// 2. KST hour boundary: 14:59:59Z -> 23h KST, 15:00:00Z -> next KST day 00h.
{
  const rows = bucketEvents([
    ev("s1", "2026-09-29T15:00:00Z", "opus", 1, 1, 0, 0),
    ev("s1", "2026-09-29T14:59:59Z", "opus", 1, 1, 0, 0),
  ]);
  eq("2: two rows", rows.length, 2);
  eq("2: hours (sorted)", rows.map((r) => r.hour), ["2026-09-29T23", "2026-09-30T00"]);
}

// 2b. key separation + deterministic order regardless of input order; provider kept.
{
  const input = [
    { ...ev("s2", "2026-09-29T01:00:00Z", "b", 1, 0, 0, 0), provider: "github-copilot" },
    ev("s1", "2026-09-29T01:00:00Z", "b", 1, 0, 0, 0),
    ev("s1", "2026-09-29T01:00:00Z", "a", 1, 0, 0, 0),
    { ...ev("s1", "2026-09-29T01:00:00Z", "a", 1, 0, 0, 0), tool: "codex" },
  ];
  const a = bucketEvents(input);
  const b = bucketEvents([...input].reverse());
  eq("2b: 4 keys -> 4 rows", a.length, 4);
  eq("2b: order independent of input", a, b);
  eq("2b: sort (tool, sessionId, hour, model)",
    a.map((r) => `${r.tool}/${r.sessionId}/${r.model}`),
    ["claude_code/s1/a", "claude_code/s1/b", "claude_code/s2/b", "codex/s1/a"]);
  eq("2b: provider carried", a[2].provider, "github-copilot");
}

// 3. claude-code copy attribution: the same message.id+requestId in two files is
// attributed to the smallest sessionId, whatever the scan order.
for (const swap of [false, true]) {
  const home = freshHome();
  const dir = path.join(home, ".claude", "projects", "proj");
  const shared = (sid) => ccLine(sid, "msg_1", "req_1", "2026-09-29T02:00:00Z", "claude-opus-5", [10, 20, 30, 40]);
  // created in reverse filename order; `swap` flips which file holds which id
  writeLines(path.join(dir, "b.jsonl"), [shared(swap ? "aaa" : "bbb")]);
  writeLines(path.join(dir, "a.jsonl"), [shared(swap ? "bbb" : "aaa")]);
  const { sessions = [], rows } = await claudeCode.aggregate({});
  eq(`3(swap=${swap}): one session row`, sessions.length, 1);
  eq(`3(swap=${swap}): attributed to smallest sessionId`, sessions[0]?.sessionId, "aaa");
  eq(`3(swap=${swap}): counted once`, sessions[0]?.requests, 1);
  eq(`3(swap=${swap}): rows unchanged (one request)`, rows[0]?.requests, 1);
}

// 3b. claude-code sessionId falls back to the file stem when entry.sessionId is missing.
{
  const home = freshHome();
  const line = ccLine(undefined, "msg_x", "req_x", "2026-09-29T02:00:00Z", "claude-opus-5", [1, 1, 0, 0]);
  writeLines(path.join(home, ".claude", "projects", "p", "0f0e-stem.jsonl"), [line]);
  const { sessions = [] } = await claudeCode.aggregate({});
  eq("3b: stem fallback", sessions.map((s) => s.sessionId), ["0f0e-stem"]);
}

// 4 + 5. Totals preserved (sessions == rows, per tool) and health, on one fixture HOME.
{
  const home = freshHome();
  // claude-code: two sessions, two models, a duplicate line, a synthetic line, 2 broken lines
  writeLines(path.join(home, ".claude", "projects", "p1", "s-one.jsonl"), [
    ccLine("s-one", "m1", "r1", "2026-09-29T01:00:00Z", "claude-opus-5", [10, 100, 1000, 5]),
    ccLine("s-one", "m1", "r1", "2026-09-29T01:00:00Z", "claude-opus-5", [10, 100, 1000, 5]), // dup
    ccLine("s-one", "m2", "r2", "2026-09-29T15:30:00Z", "claude-sonnet-5", [7, 70, 700, 3]),
    { type: "user", sessionId: "s-one", timestamp: "2026-09-29T01:00:00Z" },
    { type: "assistant", sessionId: "s-one", requestId: "r9", timestamp: "2026-09-29T01:00:00Z",
      message: { id: "m9", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    "{not json",
    "also not json }",
  ]);
  writeLines(path.join(home, ".claude", "projects", "p2", "s-two.jsonl"), [
    ccLine("s-two", "m3", "r3", "2026-09-29T01:20:00Z", "claude-opus-5", [1, 2, 3, 4]),
  ]);
  // codex: two rollouts, model switch, 2 broken lines
  const uuidA = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const uuidB = "0199a1b2-c3d4-7e5f-8a9b-ffffffffffff";
  writeLines(path.join(home, ".codex", "sessions", "2026", "09", "29", `rollout-2026-09-29T10-00-00-${uuidA}.jsonl`), [
    cxCtx("gpt-5.5"),
    cxTc("2026-09-29T01:00:00Z", 100, 20, 10),
    cxTc("2026-09-29T01:05:00Z", 250, 50, 30),
    "garbage line",
    cxCtx("gpt-5.3-codex"),
    cxTc("2026-09-29T02:00:00Z", 400, 60, 45),
    "{broken",
  ]);
  writeLines(path.join(home, ".codex", "sessions", "2026", "09", "29", `rollout-2026-09-29T11-00-00-${uuidB}.jsonl`), [
    cxCtx("gpt-5.5"),
    cxTc("2026-09-29T03:00:00Z", 10, 0, 1),
  ]);
  // gemini: header with sessionId + echoed turns; second file without header -> stem; 2 broken
  writeLines(path.join(home, ".gemini", "tmp", "projhash", "chats", "session-2026-09-29T01-00-aaaa1111.jsonl"), [
    { sessionId: "gem-session-1", projectHash: "projhash", startTime: "2026-09-29T01:00:00Z", lastUpdated: "2026-09-29T01:00:00Z", kind: "main" },
    { id: "u1", timestamp: "2026-09-29T01:00:00Z", type: "user", content: "x" },
    gmTurn("g1", "2026-09-29T01:01:00Z", "gemini-3-pro", 100, 0, 10, 5),
    gmTurn("g1", "2026-09-29T01:01:00Z", "gemini-3-pro", 100, 0, 10, 5), // echo
    gmTurn("g2", "2026-09-29T01:02:00Z", "gemini-3-pro", 250, 50, 25, 5),
    "nope",
    "nope again",
  ]);
  writeLines(path.join(home, ".gemini", "tmp", "projhash", "chats", "session-2026-09-29T02-00-bbbb2222.jsonl"), [
    gmTurn("g9", "2026-09-29T02:01:00Z", "gemini-3-flash", 30, 0, 3, 0),
  ]);
  // grok: per-call lines across a KST day boundary + one with a conversation id; 2 broken
  writeLines(path.join(home, ".local", "share", "grok-usage.jsonl"), [
    gkLine(Date.parse("2026-09-29T01:00:00Z") / 1000, "grok-4-fast", 100, 10),
    gkLine(Date.parse("2026-09-29T01:30:00Z") / 1000, "grok-4-fast", 50, 5),
    gkLine(Date.parse("2026-09-29T15:10:00Z") / 1000, "grok-4-fast", 20, 2), // KST 09-30
    gkLine(Date.parse("2026-09-29T02:00:00Z") / 1000, "grok-3", 7, 1, { conversation_id: "conv-42" }),
    "][",
    "{\"ts\":",
  ]);

  const results = {
    claude_code: await claudeCode.aggregate({}),
    codex: await codex.aggregate({}),
    gemini: await gemini.aggregate({}),
    grok: await grok.aggregate({}),
  };

  for (const [tool, r] of Object.entries(results)) {
    check(`4(${tool}): has sessions`, Array.isArray(r.sessions) && r.sessions.length > 0);
    eq(`4(${tool}): sessions total == rows total`, totals(r.sessions ?? []), totals(r.rows));
    eq(`4(${tool}): sessions total == hourlyRows total`, totals(r.sessions ?? []), totals(r.hourlyRows));
    check(`4(${tool}): every row has tool`, (r.sessions ?? []).every((s) => s.tool === tool));
    check(`4(${tool}): every row parserVersion ${PARSER_VERSION}`, (r.sessions ?? []).every((s) => s.parserVersion === PARSER_VERSION));
    check(`4(${tool}): no tool: prefix on sessionId`,
      (r.sessions ?? []).every((s) => typeof s.sessionId === "string" && s.sessionId && !s.sessionId.startsWith(`${tool}:`)));
    eq(`5(${tool}): health`, r.health, {
      parser: tool,
      filesScanned: tool === "claude_code" || tool === "codex" || tool === "gemini" ? 2 : 1,
      linesUnrecognized: 2,
      sessionsEmitted: r.sessions?.length,
    });
  }

  // sessionId rules per tool
  eq("ids(claude_code)", [...new Set((results.claude_code.sessions ?? []).map((s) => s.sessionId))], ["s-one", "s-two"]);
  eq("ids(codex) = rollout UUID", [...new Set((results.codex.sessions ?? []).map((s) => s.sessionId))], [uuidA, uuidB]);
  eq("ids(gemini) = header sessionId, else stem",
    [...new Set((results.gemini.sessions ?? []).map((s) => s.sessionId))],
    ["gem-session-1", "session-2026-09-29T02-00-bbbb2222"]);
  eq("ids(grok) = conversation id, else grok-<KST date>",
    (results.grok.sessions ?? []).map((s) => `${s.sessionId}|${s.hour}|${s.model}`),
    ["conv-42|2026-09-29T11|grok-3", "grok-2026-09-29|2026-09-29T10|grok-4-fast", "grok-2026-09-30|2026-09-30T00|grok-4-fast"]);
  eq("claude hour buckets are KST",
    (results.claude_code.sessions ?? []).map((s) => `${s.sessionId}|${s.hour}|${s.model}|${s.requests}`),
    ["s-one|2026-09-29T10|claude-opus-5|1", "s-one|2026-09-30T00|claude-sonnet-5|1", "s-two|2026-09-29T10|claude-opus-5|1"]);
  eq("codex model switch splits rows",
    (results.codex.sessions ?? []).map((s) => `${s.sessionId.slice(-4)}|${s.hour}|${s.model}|${s.requests}`),
    ["4a5b|2026-09-29T10|gpt-5.5|2", "4a5b|2026-09-29T11|gpt-5.3-codex|1", "ffff|2026-09-29T12|gpt-5.5|1"]);
}

// 6. sinceDate filter applies to sessions exactly like rows.
{
  const home = freshHome();
  writeLines(path.join(home, ".claude", "projects", "p", "s.jsonl"), [
    ccLine("s", "m1", "r1", "2026-09-27T01:00:00Z", "claude-opus-5", [10, 1, 0, 0]),
    ccLine("s", "m2", "r2", "2026-09-29T01:00:00Z", "claude-opus-5", [20, 2, 0, 0]),
  ]);
  const r = await claudeCode.aggregate({ sinceDate: "2026-09-28" });
  eq("6: sinceDate -> sessions match rows", totals(r.sessions ?? []), totals(r.rows));
  eq("6: one request after since", totals(r.sessions ?? []).requests, 1);
}

// 7. empty HOME: every parser returns empty sessions + zeroed health, no throw.
{
  freshHome();
  for (const [tool, mod] of [["claude_code", claudeCode], ["codex", codex], ["gemini", gemini], ["grok", grok]]) {
    const r = await mod.aggregate({});
    eq(`7(${tool}): empty sessions`, r.sessions, []);
    eq(`7(${tool}): zero health`, r.health, { parser: tool, filesScanned: 0, linesUnrecognized: 0, sessionsEmitted: 0 });
  }
}

// fixture writers per tool (one file each), used by 8-10
const secs = (iso) => Date.parse(iso) / 1000;
const toolFiles = {
  claude_code: (home) => path.join(home, ".claude", "projects", "p", "s-mt.jsonl"),
  codex: (home) => path.join(home, ".codex", "sessions", "2026", "09", "28",
    "rollout-2026-09-28T08-00-00-0199a1b2-c3d4-7e5f-8a9b-000000000001.jsonl"),
  gemini: (home) => path.join(home, ".gemini", "tmp", "ph", "chats", "session-2026-09-28T08-00-cccc3333.jsonl"),
  grok: (home) => path.join(home, ".local", "share", "grok-usage.jsonl"),
};
// Two usage events per tool: one at `early`, one at `late` (ISO UTC).
const twoEventLines = {
  claude_code: (early, late) => [
    ccLine("s-mt", "m1", "r1", early, "claude-opus-5", [10, 1, 0, 0]),
    ccLine("s-mt", "m2", "r2", late, "claude-opus-5", [20, 2, 0, 0]),
  ],
  codex: (early, late) => [cxCtx("gpt-5.5"), cxTc(early, 100, 0, 10), cxTc(late, 250, 0, 30)],
  gemini: (early, late) => [
    gmTurn("g1", early, "gemini-3-pro", 100, 0, 10, 0),
    gmTurn("g2", late, "gemini-3-pro", 250, 0, 30, 0),
  ],
  grok: (early, late) => [gkLine(secs(early), "grok-4-fast", 100, 10), gkLine(secs(late), "grok-4-fast", 150, 20)],
};
const mods = { claude_code: claudeCode, codex, gemini, grok };

// 8. sinceDate filters sessions exactly like rows, per tool: an event on KST
// 09-27 is dropped, the KST 09-29 one kept.
for (const tool of Object.keys(mods)) {
  const home = freshHome();
  writeLines(toolFiles[tool](home), twoEventLines[tool]("2026-09-27T01:00:00Z", "2026-09-29T01:00:00Z"));
  const r = await mods[tool].aggregate({ sinceDate: "2026-09-28" });
  eq(`8(${tool}): sinceDate -> sessions total == rows total`, totals(r.sessions ?? []), totals(r.rows));
  eq(`8(${tool}): one request after since`, totals(r.sessions ?? []).requests, 1);
  check(`8(${tool}): all hours >= since`, (r.sessions ?? []).every((s) => s.hour >= "2026-09-28"));
}

// 9. mtime window is KST-midnight based: a file last written 00:00-08:59 KST
// on sinceDate (i.e. the previous UTC day) must still be scanned; one written
// 23:59 KST the day before may be skipped.
for (const tool of Object.keys(mods)) {
  for (const [mtimeIso, scanned] of [["2026-09-27T23:30:00Z", true], ["2026-09-27T14:59:00Z", false]]) {
    const home = freshHome();
    const file = toolFiles[tool](home);
    // events at KST 09-27 23:00 (before since) and KST 09-28 08:00 (in window)
    writeLines(file, twoEventLines[tool]("2026-09-27T14:00:00Z", "2026-09-27T23:00:00Z"));
    utimesSync(file, new Date(mtimeIso), new Date(mtimeIso));
    const r = await mods[tool].aggregate({ sinceDate: "2026-09-28" });
    const label = `9(${tool}, mtime ${mtimeIso})`;
    eq(`${label}: filesScanned`, r.health?.filesScanned, scanned ? 1 : 0);
    eq(`${label}: in-window requests`, totals(r.sessions ?? []).requests, scanned ? 1 : 0);
    eq(`${label}: rows agree`, totals(r.rows).requests, scanned ? 1 : 0);
  }
}

// 9b. copy attribution does not depend on sinceDate when the older copy was
// last written early on sinceDate (KST 00:00-08:59).
{
  const home = freshHome();
  const dir = path.join(home, ".claude", "projects", "p");
  const shared = (sid) => ccLine(sid, "m1", "r1", "2026-09-27T23:00:00Z", "opus", [5, 1, 0, 0]); // KST 09-28 08:00
  writeLines(path.join(dir, "a.jsonl"), [shared("aaa")]);
  writeLines(path.join(dir, "b.jsonl"), [shared("bbb")]);
  utimesSync(path.join(dir, "a.jsonl"), new Date("2026-09-27T23:30:00Z"), new Date("2026-09-27T23:30:00Z"));
  utimesSync(path.join(dir, "b.jsonl"), new Date("2026-09-29T00:00:00Z"), new Date("2026-09-29T00:00:00Z"));
  for (const since of ["2026-09-28", "2026-09-20"]) {
    const r = await claudeCode.aggregate({ sinceDate: since });
    eq(`9b(since ${since}): attributed to aaa`, (r.sessions ?? []).map((s) => `${s.sessionId}|${s.requests}`), ["aaa|1"]);
  }
}

// 10. grok fallback id includes a device tag = sha1(machineId)[0:8] (per-device
// log, never synced) so two devices never share a key — never raw machineId
// chars, which with --machine-id could be a hostname; explicit ids are kept.
const tag8 = (m) => createHash("sha1").update(m).digest("hex").slice(0, 8);
{
  const home = freshHome();
  writeLines(toolFiles.grok(home), [
    gkLine(secs("2026-09-29T01:00:00Z"), "grok-4-fast", 10, 1),
    gkLine(secs("2026-09-29T02:00:00Z"), "grok-3", 7, 1, { conversation_id: "conv-42" }),
  ]);
  const r = await grok.aggregate({ machineId: "0123456789abcdef-ffff" });
  eq("10: grok ids with machineId", (r.sessions ?? []).map((s) => s.sessionId), ["conv-42", `grok-${tag8("0123456789abcdef-ffff")}-2026-09-29`]);
  check("10: grok id carries no raw machineId chars", !(r.sessions ?? []).some((s) => s.sessionId.includes("01234567")));
  const r2 = await grok.aggregate({});
  eq("10: grok ids without machineId", (r2.sessions ?? []).map((s) => s.sessionId), ["conv-42", "grok-2026-09-29"]);
  const { sessions: pure = [] } = grok.assembleRows([gkLine(secs("2026-09-29T01:00:00Z"), "grok-4-fast", 10, 1)], "abcdefgh1234");
  eq("10: assembleRows uses machineId", pure.map((s) => s.sessionId), [`grok-${tag8("abcdefgh1234")}-2026-09-29`]);
}

// 11. bucketEvents accepts a precomputed KST hour and otherwise derives it from ts.
{
  const rows = bucketEvents([
    { ...ev("s", undefined, "m", 1, 0, 0, 0), hour: "2026-09-29T10" }, // hour used, ts not needed
    ev("s", "2026-09-29T01:30:00Z", "m", 1, 0, 0, 0),
  ]);
  eq("11: precomputed hour merges with derived hour", rows.map((r) => `${r.hour}|${r.requests}`), ["2026-09-29T10|2"]);
}

// 12. Client-side validation mirrors the server usageSessionRowSchema (F4):
// an invalid row is dropped before sending (one bad row would 400 the whole
// request) and counted into that parser's health.linesUnrecognized.
{
  const { isValidSessionRow, dropInvalidSessions } = await import("../lib/sessions.mjs");
  const ok = {
    tool: "grok", sessionId: "s", hour: "2026-09-29T10", model: "m", provider: "",
    inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 1, parserVersion: PARSER_VERSION,
  };
  check("12: valid row", isValidSessionRow?.(ok) === true);
  const bad = {
    "empty sessionId": { sessionId: "" },
    "sessionId > 200": { sessionId: "x".repeat(201) },
    "non-string sessionId": { sessionId: 42 },
    "bad hour": { hour: "2026-09-29 10" },
    "float tokens": { inputTokens: 1.5 },
    "negative tokens": { outputTokens: -1 },
    "NaN requests": { requests: NaN },
    "non-string model": { model: 7 },
    "model > 200": { model: "m".repeat(201) },
    "provider > 60": { provider: "p".repeat(61) },
    "empty tool": { tool: "" },
    "tool > 40": { tool: "t".repeat(41) },
    "parserVersion 0": { parserVersion: 0 },
  };
  for (const [label, over] of Object.entries(bad)) {
    check(`12: rejects ${label}`, isValidSessionRow?.({ ...ok, ...over }) === false);
  }
  check("12: sessionId of exactly 200 ok", isValidSessionRow?.({ ...ok, sessionId: "x".repeat(200) }) === true);
  const r = dropInvalidSessions?.({
    sessions: [ok, { ...ok, sessionId: "" }, { ...ok, inputTokens: 2.5 }],
    health: { parser: "grok", filesScanned: 1, linesUnrecognized: 3, sessionsEmitted: 3 },
  });
  eq("12: dropInvalidSessions keeps valid rows", r?.sessions, [ok]);
  eq("12: dropped rows counted as unrecognized", r?.health, { parser: "grok", filesScanned: 1, linesUnrecognized: 5, sessionsEmitted: 1 });
  // Through a real parser: an over-long conversation id from the grok log.
  const home = freshHome();
  writeLines(toolFiles.grok(home), [
    gkLine(secs("2026-09-29T01:00:00Z"), "grok-4-fast", 10, 1),
    gkLine(secs("2026-09-29T02:00:00Z"), "grok-3", 7, 1, { conversation_id: "c".repeat(250) }),
  ]);
  const g = dropInvalidSessions?.(await grok.aggregate({ machineId: "m1" }));
  eq("12: grok over-long id dropped", (g?.sessions ?? []).map((x) => x.model), ["grok-4-fast"]);
  eq("12: grok health counts it", [g?.health?.linesUnrecognized, g?.health?.sessionsEmitted], [1, 1]);
}

for (const d of tmpHomes) rmSync(d, { recursive: true, force: true });
console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
