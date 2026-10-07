// Tests for scripts/audit-local.mjs: on the Task 3/4 session fixtures (plus an
// opencode.db), the audit's per tool × KST date raw totals — counted WITHOUT
// sessionization — equal the parsers' session-row totals. Also: the CLI prints
// JSON only (no message content, no paths) and writes nothing. Run with node.
// Uses a temporary HOME per case — never touches real tool logs.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, "audit-local.mjs");
const auditMod = await import("./audit-local.mjs");
const parsers = {
  claude_code: await import("../parsers/claude-code.mjs"),
  codex: await import("../parsers/codex.mjs"),
  gemini: await import("../parsers/gemini.mjs"),
  grok: await import("../parsers/grok.mjs"),
  opencode: await import("../parsers/opencode.mjs"),
};

const tmpHomes = [];
function freshHome() {
  const dir = mkdtempSync(path.join(tmpdir(), "tf-audit-"));
  tmpHomes.push(dir);
  process.env.HOME = dir;
  return dir;
}
function writeLines(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}
const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests"];

// sessions → { date: totals } (date = KST date of the hour bucket)
function sessionsByDate(sessions) {
  const out = {};
  for (const s of sessions) {
    const d = s.hour.slice(0, 10);
    out[d] ??= { ...Object.fromEntries(FIELDS.map((f) => [f, null])), fieldEvidence: {} };
    for (const f of FIELDS) {
      const value = s[f];
      const evidence = s.fieldEvidence?.[f] ?? (value == null ? "unknown" : "known");
      const previous = out[d].fieldEvidence[f];
      out[d].fieldEvidence[f] = previous === undefined ? evidence :
        previous === "known" && evidence === "known" ? "known" :
        previous === "unsupported" && evidence === "unsupported" ? "unsupported" : "unknown";
      if (value != null) out[d][f] = (out[d][f] ?? 0) + value;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
const values = (r) => Object.fromEntries(FIELDS.map((f) => [f, r?.[f]]));

// fixture builders (same shapes as verify-sessions.mjs) ----------------------
const SECRET = "AUDIT_SECRET_CONTENT";
const ccLine = (sessionId, msgId, reqId, ts, model, u) => ({
  type: "assistant", sessionId, requestId: reqId, timestamp: ts,
  message: { id: msgId, model, usage: {
    input_tokens: u[0], output_tokens: u[1],
    cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3],
  }, content: [{ type: "text", text: SECRET }] },
});
const cxCtx = (model) => ({ type: "turn_context", payload: { model } });
const cxTc = (ts, input, cached, output) => ({
  type: "event_msg", timestamp: ts,
  payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  } },
});
const gmTurn = (id, ts, model, input, cached, output, thoughts) => ({
  id, timestamp: ts, type: "gemini", model, content: SECRET,
  tokens: { input, output, cached, thoughts, tool: 0, total: input + output + thoughts },
});
const gkLine = (ts, model, pt, ct, extra = {}) => ({
  ts, tool: "chat", model, prompt_tokens: pt, completion_tokens: ct,
  total_tokens: pt + ct, cost_in_usd_ticks: 0, ...extra,
});
const secs = (iso) => Date.parse(iso) / 1000;

function makeOpencodeDb(home, messages) {
  const file = path.join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)");
  db.exec("CREATE TABLE account (id text PRIMARY KEY, token text)");
  db.prepare("INSERT INTO account VALUES (?, ?)").run("a1", SECRET);
  const ins = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  for (const m of messages) ins.run(m.id, m.session, m.ms, m.ms, typeof m.data === "string" ? m.data : JSON.stringify(m.data));
  db.close();
  return file;
}
const ocAssistant = (id, session, iso, t) => ({
  id, session, ms: Date.parse(iso),
  data: { role: "assistant", modelID: "claude-sonnet-5", providerID: "github-copilot",
    tokens: { input: t[0], output: t[1], reasoning: t[2], cache: { read: t[3], write: t[4] } },
    time: { created: Date.parse(iso) } },
});

// The Task 3/4 fixture HOME: every tool, KST day boundaries, duplicates,
// copies across files, model switches, broken lines.
function buildFixture() {
  const home = freshHome();
  // claude-code: two sessions, dup line, synthetic, broken lines, a KST day
  // crossing, and a message copied into a forked session file.
  writeLines(path.join(home, ".claude", "projects", "p1", "s-one.jsonl"), [
    ccLine("s-one", "m1", "r1", "2026-09-29T01:00:00Z", "claude-opus-5", [10, 100, 1000, 5]),
    ccLine("s-one", "m1", "r1", "2026-09-29T01:00:00Z", "claude-opus-5", [10, 100, 1000, 5]), // dup
    ccLine("s-one", "m2", "r2", "2026-09-29T15:30:00Z", "claude-sonnet-5", [7, 70, 700, 3]),
    { type: "user", sessionId: "s-one", timestamp: "2026-09-29T01:00:00Z", message: { content: SECRET } },
    { type: "assistant", sessionId: "s-one", requestId: "r9", timestamp: "2026-09-29T01:00:00Z",
      message: { id: "m9", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    "{not json",
    "also not json }",
  ]);
  writeLines(path.join(home, ".claude", "projects", "p2", "s-two.jsonl"), [
    ccLine("s-two", "m3", "r3", "2026-09-29T01:20:00Z", "claude-opus-5", [1, 2, 3, 4]),
    ccLine("s-two", "m1", "r1", "2026-09-29T01:00:00Z", "claude-opus-5", [10, 100, 1000, 5]), // copy of s-one's m1
  ]);
  // codex: two rollouts, model switch, reset, broken lines
  const uuidA = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const uuidB = "0199a1b2-c3d4-7e5f-8a9b-ffffffffffff";
  writeLines(path.join(home, ".codex", "sessions", "2026", "09", "29", `rollout-2026-09-29T10-00-00-${uuidA}.jsonl`), [
    cxCtx("gpt-5.5"),
    cxTc("2026-09-29T01:00:00Z", 100, 20, 10),
    cxTc("2026-09-29T01:05:00Z", 250, 50, 30),
    cxTc("2026-09-29T01:05:01Z", 250, 50, 30), // repeat → nothing
    "garbage line",
    cxCtx("gpt-5.3-codex"),
    cxTc("2026-09-29T02:00:00Z", 400, 60, 45),
    cxTc("2026-09-29T16:00:00Z", 40, 0, 4), // reset, next KST day
    "{broken",
  ]);
  writeLines(path.join(home, ".codex", "sessions", "2026", "09", "29", `rollout-2026-09-29T11-00-00-${uuidB}.jsonl`), [
    cxCtx("gpt-5.5"),
    cxTc("2026-09-29T03:00:00Z", 10, 0, 1),
  ]);
  // gemini: header + echoed turns; second file without header; broken lines
  writeLines(path.join(home, ".gemini", "tmp", "projhash", "chats", "session-2026-09-29T01-00-aaaa1111.jsonl"), [
    { sessionId: "gem-session-1", projectHash: "projhash", startTime: "2026-09-29T01:00:00Z", lastUpdated: "2026-09-29T01:00:00Z", kind: "main" },
    { id: "u1", timestamp: "2026-09-29T01:00:00Z", type: "user", content: SECRET },
    gmTurn("g1", "2026-09-29T01:01:00Z", "gemini-3-pro", 100, 0, 10, 5),
    gmTurn("g1", "2026-09-29T01:01:00Z", "gemini-3-pro", 100, 0, 10, 5), // echo
    gmTurn("g2", "2026-09-29T01:02:00Z", "gemini-3-pro", 250, 50, 25, 5),
    gmTurn("g3", "2026-09-29T15:02:00Z", "gemini-3-pro", 300, 50, 30, 9), // next KST day
    "nope",
    "nope again",
  ]);
  writeLines(path.join(home, ".gemini", "tmp", "projhash", "chats", "session-2026-09-29T02-00-bbbb2222.jsonl"), [
    gmTurn("g9", "2026-09-29T02:01:00Z", "gemini-3-flash", 30, 0, 3, 0),
  ]);
  // grok: per-call lines across a KST day boundary + a conversation id
  writeLines(path.join(home, ".local", "share", "grok-usage.jsonl"), [
    gkLine(secs("2026-09-29T01:00:00Z"), "grok-4-fast", 100, 10),
    gkLine(secs("2026-09-29T01:30:00Z"), "grok-4-fast", 50, 5),
    gkLine(secs("2026-09-29T15:10:00Z"), "grok-4-fast", 20, 2), // KST 09-30
    gkLine(secs("2026-09-29T02:00:00Z"), "grok-3", 7, 1, { conversation_id: "conv-42" }),
    gkLine(secs("2026-09-29T02:10:00Z"), "grok-3", 0, 0), // known zero, one real call
    "][",
  ]);
  // opencode: two sessions, a user message, a KST day crossing, a broken row
  makeOpencodeDb(home, [
    ocAssistant("o1", "ses_A", "2026-09-29T02:00:00Z", [2, 5, 1, 0, 28697]),
    { id: "o2", session: "ses_A", ms: Date.parse("2026-09-29T02:00:05Z"), data: { role: "user", content: SECRET, time: { created: Date.parse("2026-09-29T02:00:05Z") } } },
    ocAssistant("o3", "ses_A", "2026-09-29T15:30:00Z", [10, 20, 7, 100, 0]),
    ocAssistant("o4", "ses_B", "2026-09-29T03:00:00Z", [1, 1, 0, 0, 0]),
    { id: "o5", session: "ses_B", ms: Date.parse("2026-09-29T03:00:01Z"), data: "{broken" },
  ]);
  return home;
}

// 1. audit totals == sessions totals, per tool × KST date (no since, and since)
for (const since of [undefined, "2026-09-30"]) {
  const home = buildFixture();
  const audit = await auditMod.audit({ sinceDate: since });
  eq(`1(since ${since}): tools`, Object.keys(audit.tools), ["claude_code", "codex", "gemini", "grok", "opencode"]);
  for (const [tool, mod] of Object.entries(parsers)) {
    const r = await mod.aggregate({ sinceDate: since });
    const expected = sessionsByDate(r.sessions);
    check(`1(${tool}, since ${since}): fixture has usage`, Object.keys(expected).length > 0);
    eq(`1(${tool}, since ${since}): audit == sessions per date`, audit.tools[tool], expected);
    if (since) check(`1(${tool}): since respected`, Object.keys(audit.tools[tool]).every((d) => d >= since));
  }
  // spot values (hand-computed, independent of both implementations)
  if (!since) {
    eq("1: claude 09-29 (m1 counted once, m3)", values(audit.tools.claude_code["2026-09-29"]),
      { inputTokens: 11, outputTokens: 102, cacheReadTokens: 1003, cacheCreationTokens: 9, requests: 2 });
    eq("1: codex 09-30 (reset counts full)", values(audit.tools.codex["2026-09-30"]),
      { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: null, requests: 1 });
    eq("1: opencode 09-29", values(audit.tools.opencode["2026-09-29"]),
      { inputTokens: 3, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 28697, requests: 2 });
    eq("1: grok explicit zero still counts a call", audit.tools.grok["2026-09-29"].requests, 4);
  }
  rmSync(home, { recursive: true, force: true });
}

// A missing token count does not turn into a zero; a known zero remains zero.
{
  const home = freshHome();
  writeLines(path.join(home, ".local", "share", "grok-usage.jsonl"), [
    gkLine(secs("2026-09-29T01:00:00Z"), "grok-4-fast", 0, 1),
    { ts: secs("2026-09-29T01:01:00Z"), model: "grok-4-fast", completion_tokens: 2 },
  ]);
  const result = await auditMod.audit({});
  const row = result.tools.grok["2026-09-29"];
  eq("partial audit preserves observed zero", row.inputTokens, 0);
  eq("partial audit marks input unknown", row.fieldEvidence.inputTokens, "unknown");
  eq("partial audit sums known output", row.outputTokens, 3);
  eq("unsupported cache stays null", row.cacheReadTokens, null);
  rmSync(home, { recursive: true, force: true });
}

// 2. empty HOME → every tool present with no dates
{
  freshHome();
  const audit = await auditMod.audit({});
  eq("2: empty", audit.tools, { claude_code: {}, codex: {}, gemini: {}, grok: {}, opencode: {} });
}

// 3. CLI: JSON only on stdout, no content/paths, nothing written
{
  const home = buildFixture();
  const listing = () => {
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${p}|${statSync(p).size}|${statSync(p).mtimeMs}`);
      }
    };
    walk(home);
    return out.sort();
  };
  const before = listing();
  const env = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("TOKEN_FOREST_")) delete env[k];
  const r = spawnSync(process.execPath, [AUDIT, "--since", "2026-09-29"], { env, encoding: "utf8" });
  eq("3: exit 0", r.status, 0);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  check("3: stdout is JSON", json !== null);
  eq("3: sinceDate echoed", json?.sinceDate, "2026-09-29");
  check("3: has per-tool dates", json?.tools?.claude_code?.["2026-09-29"]?.requests === 2);
  check("3: no message content", !r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  check("3: no paths", !r.stdout.includes(home) && !r.stdout.includes(".claude") && !r.stdout.includes("opencode.db"));
  eq("3: HOME unchanged (read-only)", listing(), before);
  const bad = spawnSync(process.execPath, [AUDIT, "--since", "yesterday"], { env, encoding: "utf8" });
  check("3: bad --since → exit 2", bad.status === 2);
}

// 4. F7: invoked through a symlinked path (macOS /tmp → /private/tmp, a
// linked checkout) the script still runs — the main guard compares real paths.
{
  const { symlinkSync } = await import("node:fs");
  const home = freshHome();
  const links = mkdtempSync(path.join(tmpdir(), "tf-audit-link-"));
  tmpHomes.push(links);
  const fileLink = path.join(links, "audit-link.mjs");
  symlinkSync(AUDIT, fileLink);
  const dirLink = path.join(links, "src-link");
  symlinkSync(path.dirname(HERE), dirLink, "dir");
  const env = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("TOKEN_FOREST_")) delete env[k];
  for (const [label, p] of [["file symlink", fileLink], ["dir symlink", path.join(dirLink, "scripts", "audit-local.mjs")]]) {
    const r = spawnSync(process.execPath, [p, "--since", "2026-09-29"], { env, encoding: "utf8" });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    check(`4: via ${label} → exit 0 + JSON (stdout ${JSON.stringify(r.stdout.slice(0, 40))})`, r.status === 0 && json?.sinceDate === "2026-09-29");
  }
}

for (const d of tmpHomes) rmSync(d, { recursive: true, force: true });
console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
