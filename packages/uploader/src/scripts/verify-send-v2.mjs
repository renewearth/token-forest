// Tests for the v2 upload path (collection v2, Task 5): change cursor
// (lib/cursor.mjs), sticky claude attribution index (lib/claude-attr.mjs),
// sendV2 batching + v1 fallback (send.mjs), device/label config and the CLI
// end to end. Run with node. Every case uses a temporary HOME and
// TOKEN_FOREST_STATE_DIR and a local node:http fake server — it never reads
// real tool logs, never touches ~/.token-forest or ~/.config/token-forest, and
// never talks to a real server.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, chmodSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tag8 = (m) => createHash("sha1").update(m).digest("hex").slice(0, 8);

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "cli.mjs");
const PKG_VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8")).version;
check(`package version bumped to 0.3.0 (got ${PKG_VERSION})`, PKG_VERSION === "0.3.0");

const tmpDirs = [];
function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
// A fresh sandbox: HOME + STATE_DIR, also applied to this process so in-process
// imports (device-id, cursor, claude-attr) never see the real home.
function sandbox() {
  const home = tmp("tf-send-home-");
  const state = path.join(home, "state");
  process.env.HOME = home;
  process.env.TOKEN_FOREST_STATE_DIR = state;
  return { home, state };
}
function writeLines(file, lines, mtime) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
}
const ccLine = (sessionId, msgId, reqId, ts, model, u) => ({
  type: "assistant", sessionId, requestId: reqId, timestamp: ts,
  message: { id: msgId, model, usage: {
    input_tokens: u[0], output_tokens: u[1],
    cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3],
  } },
});
const sess = (tool, sessionId, hour, model = "m") => ({
  tool, sessionId, hour, model, provider: "", inputTokens: 1, outputTokens: 1,
  cacheReadTokens: 0, cacheCreationTokens: 0, requests: 1, parserVersion: 2,
});

// Fake ingest server. `respond(body, n)` → { status, json } (n = 0-based index).
async function startServer(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      const n = requests.length;
      requests.push({ url: req.url, auth: req.headers.authorization, raw, body });
      const { status, json } = respond(body, n, req.url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}
// v2 server: accepts anything that has rows, sessions or device.
const v2Server = () => startServer((body) => {
  const ok = (body?.rows?.length ?? 0) > 0 || (body?.sessions?.length ?? 0) > 0 || body?.device;
  if (!ok) return { status: 400, json: { error: "invalid payload", issues: [{ code: "custom", path: ["rows"] }] } };
  return { status: 200, json: { ok: true, upserted: body.rows?.length ?? 0, sessionsUpserted: body.sessions?.length ?? 0 } };
});
// Old server: strips unknown keys, requires rows.min(1).
const oldServer = () => startServer((body) => {
  if (!Array.isArray(body?.rows)) {
    return { status: 400, json: { error: "invalid payload", issues: [{ code: "invalid_type", expected: "array", received: "undefined", path: ["rows"], message: "Required" }] } };
  }
  if (body.rows.length === 0) {
    return { status: 400, json: { error: "invalid payload", issues: [{ code: "too_small", path: ["rows"] }] } };
  }
  return { status: 200, json: { ok: true, upserted: body.rows.length, skipped: 0, hourlyUpserted: body.hourly?.length ?? 0 } };
});

// Run the CLI as a child process (async, so the in-process fake server keeps
// serving). Env is scrubbed of every TOKEN_FOREST_* var first.
function runCli(args, { home, state, url, extraEnv = {}, limits = false }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("TOKEN_FOREST_")) env[k] = v;
  Object.assign(env, { HOME: home, TOKEN_FOREST_STATE_DIR: state }, extraEnv);
  if (url) Object.assign(env, { TOKEN_FOREST_URL: url, TOKEN_FOREST_TOKEN: "tf_test_token" });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...(limits ? ["--no-digest"] : ["--no-limits"]), ...args], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const HOST = hostname();
function noHostname(label, raw) {
  if (HOST.length >= 4) check(`${label}: hostname not in body`, !raw.includes(HOST));
}

const RECENT = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
const OLD_MTIME = new Date(Date.now() - 5 * 86400_000); // 5 days ago

const cursorMod = await import("../lib/cursor.mjs");
const sendMod = await import("../send.mjs");
const attrMod = await import("../lib/claude-attr.mjs");
const claudeCode = await import("../parsers/claude-code.mjs");
const lockMod = await import("../lib/run-lock.mjs");
const { PARSER_VERSION } = await import("../lib/sessions.mjs");

// 4. decideWindow table ------------------------------------------------------
{
  const { decideWindow, applySinceFloor } = cursorMod;
  const PV = PARSER_VERSION;
  const now = new Date("2026-09-30T12:00:00+09:00");
  eq("4: no cursor → full", decideWindow({ lastSuccessAt: null, lastFullAt: null, parserVersion: null }, now), { mode: "full", sinceDate: null });
  eq("4: lastFull 8 days ago → full",
    decideWindow({ lastSuccessAt: "2026-09-29T03:00:00.000Z", lastFullAt: "2026-09-22T03:00:00.000Z", parserVersion: PV }, now),
    { mode: "full", sinceDate: null });
  eq("4: yesterday success → incremental since day before",
    decideWindow({ lastSuccessAt: "2026-09-29T03:00:00.000Z", lastFullAt: "2026-09-27T03:00:00.000Z", parserVersion: PV }, now),
    { mode: "incremental", sinceDate: "2026-09-28" });
  // KST boundary: 2026-09-29T20:00Z = 09-30 05:00 KST → since 09-29.
  eq("4: success date is the KST date",
    decideWindow({ lastSuccessAt: "2026-09-29T20:00:00.000Z", lastFullAt: "2026-09-29T20:00:00.000Z", parserVersion: PV }, now),
    { mode: "incremental", sinceDate: "2026-09-29" });
  eq("4: lastFull missing → full",
    decideWindow({ lastSuccessAt: "2026-09-29T03:00:00.000Z", lastFullAt: null, parserVersion: PV }, now), { mode: "full", sinceDate: null });
  // R19: a cursor from another parser version (or none recorded) → full.
  eq("4/R19: parserVersion missing → full",
    decideWindow({ lastSuccessAt: "2026-09-29T03:00:00.000Z", lastFullAt: "2026-09-29T03:00:00.000Z", parserVersion: null }, now),
    { mode: "full", sinceDate: null });
  eq("4/R19: parserVersion differs → full",
    decideWindow({ lastSuccessAt: "2026-09-29T03:00:00.000Z", lastFullAt: "2026-09-29T03:00:00.000Z", parserVersion: PV - 1 }, now),
    { mode: "full", sinceDate: null });
  // Minor b: TOKEN_FOREST_SINCE is a lower bound, never lowers the window.
  eq("floor: full → since floor", applySinceFloor({ mode: "full", sinceDate: null }, "2026-07-01"), { mode: "full", sinceDate: "2026-07-01" });
  eq("floor: raises an earlier window", applySinceFloor({ mode: "incremental", sinceDate: "2026-06-01" }, "2026-07-01"), { mode: "incremental", sinceDate: "2026-07-01" });
  eq("floor: keeps a later window", applySinceFloor({ mode: "incremental", sinceDate: "2026-09-28" }, "2026-07-01"), { mode: "incremental", sinceDate: "2026-09-28" });
  eq("floor: none → unchanged", applySinceFloor({ mode: "full", sinceDate: null }, null), { mode: "full", sinceDate: null });
}

// cursor read/write honours TOKEN_FOREST_STATE_DIR; garbage → nulls ---------
{
  const { state } = sandbox();
  const NULLS = { lastSuccessAt: null, lastFullAt: null, parserVersion: null };
  eq("cursor: missing → nulls", cursorMod.readCursor(), NULLS);
  cursorMod.writeCursor({ lastSuccessAt: "2026-09-30T00:00:00.000Z", lastFullAt: "2026-09-29T00:00:00.000Z" });
  check("cursor: written under STATE_DIR", existsSync(path.join(state, "cursor.json")));
  eq("cursor: round-trip (parserVersion stamped)", cursorMod.readCursor(),
    { lastSuccessAt: "2026-09-30T00:00:00.000Z", lastFullAt: "2026-09-29T00:00:00.000Z", parserVersion: PARSER_VERSION });
  writeFileSync(path.join(state, "cursor.json"), "{not json");
  eq("cursor: garbage → nulls", cursorMod.readCursor(), NULLS);
}

// device-id honours TOKEN_FOREST_STATE_DIR ---------------------------------
{
  const { home, state } = sandbox();
  const { deviceId } = await import("../lib/device-id.mjs");
  const id = deviceId();
  check("device-id: file in STATE_DIR", existsSync(path.join(state, "device-id")));
  check("device-id: not in HOME/.token-forest", !existsSync(path.join(home, ".token-forest", "device-id")));
  eq("device-id: stable", deviceId(), id);
}

// 6. sendV2 batching (R8/R14): ≤5000 rows/request, a session never split, an
// oversized session alone; health+device on the first request only ----------
{
  sandbox();
  const srv = await v2Server();
  const sessions = [];
  // s-big: 6000 rows (alone). s-a: 3000, s-b: 2500 (can't share), s-c: 2000, s-d: 1.
  const addSession = (tool, id, n) => {
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString().slice(0, 13);
      sessions.push(sess(tool, id, d));
    }
  };
  addSession("claude_code", "s-a", 3000);
  addSession("claude_code", "s-big", 6000);
  addSession("claude_code", "s-b", 2500);
  addSession("codex", "s-a", 2000); // same id, other tool = other session
  addSession("claude_code", "s-d", 1);
  const device = { machineId: "dev-uuid", uploaderVersion: PKG_VERSION };
  const health = [{ parser: "claude_code", filesScanned: 3, linesUnrecognized: 0, sessionsEmitted: sessions.length }];
  const r = await sendMod.sendV2({
    serverUrl: srv.url, token: "t", sessions, health, device, fallbackRows: [], fallbackHourly: [],
  });
  eq("6: mode", r.mode, "v2");
  check("6: every request ≤5000 rows or a single session",
    srv.requests.every((q) => {
      const ids = new Set(q.body.sessions.map((s) => `${s.tool}|${s.sessionId}`));
      return q.body.sessions.length <= 5000 || ids.size === 1;
    }));
  const where = new Map();
  let split = false;
  srv.requests.forEach((q, i) => {
    for (const s of q.body.sessions) {
      const k = `${s.tool}|${s.sessionId}`;
      if (where.has(k) && where.get(k) !== i) split = true;
      where.set(k, i);
    }
  });
  check("6: no session split across requests", !split);
  eq("6: all rows sent once", srv.requests.reduce((n, q) => n + q.body.sessions.length, 0), sessions.length);
  check("6: big session alone", srv.requests.some((q) => q.body.sessions.length === 6000 && new Set(q.body.sessions.map((s) => s.sessionId)).size === 1));
  check("6: health+device on first request", srv.requests[0].body.device && srv.requests[0].body.health);
  check("6: health+device only on first", srv.requests.slice(1).every((q) => !("device" in q.body) && !("health" in q.body)));
  check("6: >1 request", srv.requests.length >= 3);
  eq("6: requests reported", r.requests, srv.requests.length);
  eq("6: sessionsUpserted summed", r.sessionsUpserted, sessions.length);
  check("6: no rows key in v2 requests", srv.requests.every((q) => !("rows" in q.body)));
  await srv.close();
}

// 2b. sendV2 fallback trigger: unrecognized_keys → v1; other 400 → throw ------
{
  const strict = await startServer((body) =>
    body?.rows
      ? { status: 200, json: { upserted: body.rows.length } }
      : { status: 400, json: { issues: [{ code: "unrecognized_keys", keys: ["sessions"], path: [] }] } });
  const r = await sendMod.sendV2({
    serverUrl: strict.url, token: "t", sessions: [sess("claude_code", "s", "2026-09-29T10")],
    health: [], device: { machineId: "d", uploaderVersion: "x" },
    fallbackRows: [{ date: "2026-09-29", tool: "claude_code", model: "m", inputTokens: 1 }], fallbackHourly: [],
  });
  eq("2b: unrecognized_keys → v1-fallback", r.mode, "v1-fallback");
  eq("2b: retried with rows", strict.requests.length, 2);
  check("2b: fallback body has rows only (no sessions/device)", strict.requests[1].body.rows && !strict.requests[1].body.sessions && !strict.requests[1].body.device);
  await strict.close();

  const other = await startServer(() => ({ status: 400, json: { issues: [{ code: "invalid_string", path: ["sessions", 0, "hour"] }] } }));
  let threw = null;
  try {
    await sendMod.sendV2({
      serverUrl: other.url, token: "t", sessions: [sess("claude_code", "s", "2026-09-29T10")],
      health: [], device: { machineId: "d", uploaderVersion: "x" },
      fallbackRows: [{ date: "2026-09-29", tool: "claude_code", model: "m" }], fallbackHourly: [],
    });
  } catch (err) { threw = err; }
  check("2b: other 400 throws", threw !== null);
  eq("2b: other 400 → no v1 retry", other.requests.length, 1);
  await other.close();

  const s500 = await startServer(() => ({ status: 500, json: { error: "boom" } }));
  threw = null;
  try {
    await sendMod.sendV2({ serverUrl: s500.url, token: "t", sessions: [sess("claude_code", "s", "2026-09-29T10")], health: [], device: { machineId: "d", uploaderVersion: "x" }, fallbackRows: [], fallbackHourly: [] });
  } catch (err) { threw = err; }
  check("2b: 500 throws", threw !== null);
  await s500.close();
}

// 13. claude-attr index: load/save; save merges with disk (on-disk keys win,
// R21); `seen` prunes unseen pins (R20); no age-based prune -----------------
{
  const { state } = sandbox();
  attrMod.saveAttribution(new Map([["aaaaaaaaaaaaaaaa", "s-a"], ["bbbbbbbbbbbbbbbb", "s-b"]]));
  check("13: attr file under STATE_DIR", existsSync(path.join(state, "claude-attr.json")));
  eq("13: round-trip", [...attrMod.loadAttribution()], [["aaaaaaaaaaaaaaaa", "s-a"], ["bbbbbbbbbbbbbbbb", "s-b"]]);
  // A second writer with a conflicting pin and a new key: disk keeps s-a.
  attrMod.saveAttribution(new Map([["aaaaaaaaaaaaaaaa", "s-OTHER"], ["cccccccccccccccc", "s-c"]]));
  const merged = attrMod.loadAttribution();
  eq("13/R21: on-disk key wins", merged.get("aaaaaaaaaaaaaaaa"), "s-a");
  eq("13/R21: disk-only key kept", merged.get("bbbbbbbbbbbbbbbb"), "s-b");
  eq("13/R21: new key added", merged.get("cccccccccccccccc"), "s-c");
  // R20: a full run's seen set drops everything else (disk entries too).
  attrMod.saveAttribution(merged, { seen: new Set(["aaaaaaaaaaaaaaaa"]) });
  eq("13/R20: only seen kept", [...attrMod.loadAttribution().keys()], ["aaaaaaaaaaaaaaaa"]);
  writeFileSync(path.join(state, "claude-attr.json"), "garbage");
  eq("13: garbage → empty map", attrMod.loadAttribution().size, 0);
  eq("13: key helper is sha1 prefix 16", attrMod.attrKey("msg|req").length, 16);
}

// claude-code parser with an attribution map: indexed keys keep their session,
// new keys use the min rule and are added; no map → unchanged output ---------
{
  const { home } = sandbox();
  const dir = path.join(home, ".claude", "projects", "p");
  writeLines(path.join(dir, "aaa.jsonl"), [ccLine("aaa", "m1", "r1", "2026-09-29T01:00:00Z", "opus", [1, 1, 0, 0])]);
  writeLines(path.join(dir, "a00.jsonl"), [
    ccLine("a00", "m1", "r1", "2026-09-29T01:00:00Z", "opus", [1, 1, 0, 0]),
    ccLine("a00", "m2", "r2", "2026-09-29T02:00:00Z", "opus", [2, 2, 0, 0]),
  ]);
  const plain = await claudeCode.aggregate({});
  eq("parser: no map → min rule", plain.sessions.map((s) => `${s.sessionId}|${s.inputTokens}`), ["a00|1", "a00|2"]);
  check("parser: no map → no attribution field", !("attribution" in plain) && !("attributionSeen" in plain));
  const map = new Map([[attrMod.attrKey("m1|r1"), "aaa"]]);
  const withMap = await claudeCode.aggregate({ attribution: map });
  eq("parser: indexed key sticks", withMap.sessions.map((s) => `${s.sessionId}|${s.inputTokens}`), ["a00|2", "aaa|1"]);
  check("parser: returns the map", withMap.attribution === map);
  eq("parser: new key added", map.get(attrMod.attrKey("m2|r2")), "a00");
  eq("parser: indexed key unchanged", map.get(attrMod.attrKey("m1|r1")), "aaa");
  eq("parser: attributionSeen = every key met",
    [...withMap.attributionSeen].sort(), [attrMod.attrKey("m1|r1"), attrMod.attrKey("m2|r2")].sort());
}

// R18: a pin to a session with no file on disk → the message is left out of
// sessions (counted in stats.skippedPinnedAbsent); a pin to a session whose
// file exists but is skipped by mtime still applies; v1 rows keep counting it.
{
  const { home } = sandbox();
  const dir = path.join(home, ".claude", "projects", "p");
  writeLines(path.join(dir, "b00.jsonl"), [
    ccLine("b00", "m-gone", "r-gone", "2026-09-29T01:00:00Z", "opus", [4, 4, 0, 0]),
    ccLine("b00", "m-old", "r-old", "2026-09-29T01:00:00Z", "opus", [6, 6, 0, 0]),
    ccLine("b00", "m-b", "r-b", "2026-09-29T01:00:00Z", "opus", [1, 1, 0, 0]),
  ]);
  // "old-sess" still has a file, but its mtime is before the window.
  writeLines(path.join(dir, "old-sess.jsonl"), [ccLine("old-sess", "m-x", "r-x", "2026-09-20T01:00:00Z", "opus", [9, 9, 0, 0])],
    new Date("2026-09-21T00:00:00Z"));
  const map = new Map([
    [attrMod.attrKey("m-gone|r-gone"), "gone-sess"], // file pruned by Claude
    [attrMod.attrKey("m-old|r-old"), "old-sess"],
  ]);
  const r = await claudeCode.aggregate({ sinceDate: "2026-09-28", attribution: map });
  eq("R18: absent pin skipped, mtime-skipped pin kept",
    r.sessions.map((s) => `${s.sessionId}|${s.inputTokens}`), ["b00|1", "old-sess|6"]);
  eq("R18: skippedPinnedAbsent", r.stats.skippedPinnedAbsent, 1);
  eq("R18: v1 rows still count it", r.rows.reduce((n, x) => n + x.inputTokens, 0), 11);
  eq("R18: pin kept in index", map.get(attrMod.attrKey("m-gone|r-gone")), "gone-sess");
  const plain = await claudeCode.aggregate({ sinceDate: "2026-09-28" });
  eq("R18: default mode stat is 0", plain.stats.skippedPinnedAbsent, 0);
}

// 1 + 5. CLI against a v2 server: one POST with sessions+device+health, no
// hostname, cursor written (full run), machineId on session rows -------------
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [
    ccLine("s1", "m1", "r1", RECENT, "claude-opus-5", [10, 20, 30, 40]),
  ]);
  const srv = await v2Server();
  const res = await runCli([], { home, state, url: srv.url });
  eq("1: exit 0", res.code, 0);
  eq("1: one POST", srv.requests.length, 1);
  const b = srv.requests[0]?.body ?? {};
  eq("1: path", srv.requests[0]?.url, "/api/ingest");
  eq("1: bearer", srv.requests[0]?.auth, "Bearer tf_test_token");
  eq("1: sessions", (b.sessions ?? []).map((s) => `${s.tool}|${s.sessionId}|${s.inputTokens}`), ["claude_code|s1|10"]);
  const deviceIdOnDisk = readFileSync(path.join(state, "device-id"), "utf8").trim();
  eq("1: device", b.device, { machineId: deviceIdOnDisk, uploaderVersion: PKG_VERSION });
  eq("1: session row machineId", b.sessions?.[0]?.machineId, deviceIdOnDisk);
  eq("1: health parsers", (b.health ?? []).map((h) => h.parser), ["claude_code", "codex", "gemini", "grok", "opencode"]);
  eq("1: health claude", (b.health ?? [])[0], { parser: "claude_code", filesScanned: 1, linesUnrecognized: 0, sessionsEmitted: 1 });
  check("1: no rows in v2 body", !("rows" in b));
  noHostname("1/5", srv.requests[0]?.raw ?? "");
  const cur = existsSync(path.join(state, "cursor.json")) ? readJson(path.join(state, "cursor.json")) : {};
  check("1: cursor lastSuccessAt set", typeof cur.lastSuccessAt === "string");
  check("1: cursor lastFullAt set (first run is full)", typeof cur.lastFullAt === "string");
  check("1: real ~/.token-forest untouched (sandbox)", !existsSync(path.join(home, ".token-forest")));
  check("1: stdout says v2", /v2/.test(res.stdout));
  await srv.close();
}

// 1c. F4: a session row the server schema would reject (grok conversation id
// > 200 chars) is dropped before sending and counted as unrecognized — the
// rest of the request still goes through.
{
  const { home, state } = sandbox();
  const now = Math.floor(Date.parse(RECENT) / 1000);
  writeLines(path.join(home, ".local", "share", "grok-usage.jsonl"), [
    { ts: now, tool: "chat", model: "grok-4-fast", prompt_tokens: 10, completion_tokens: 1 },
    { ts: now, tool: "chat", model: "grok-3", prompt_tokens: 7, completion_tokens: 1, conversation_id: "c".repeat(250) },
  ]);
  const srv = await v2Server();
  const res = await runCli([], { home, state, url: srv.url });
  eq("1c: exit 0", res.code, 0);
  const b = srv.requests[0]?.body ?? {};
  eq("1c: only the valid grok row sent", (b.sessions ?? []).filter((x) => x.tool === "grok").map((x) => x.model), ["grok-4-fast"]);
  const gh = (b.health ?? []).find((h) => h.parser === "grok");
  eq("1c: grok health", [gh?.linesUnrecognized, gh?.sessionsEmitted], [1, 1]);
  await srv.close();
}

// 1b. opencode is wired into the CLI: a fixture opencode.db under the temp
// HOME's ~/.local/share/opencode yields opencode session rows (machineId set)
// and an opencode health entry; its account/credential tables are never read.
{
  const { home, state } = sandbox();
  const { DatabaseSync } = await import("node:sqlite");
  const dbFile = path.join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)");
  db.exec("CREATE TABLE account (id text PRIMARY KEY, token text)");
  db.prepare("INSERT INTO account VALUES (?, ?)").run("a1", "OC_SECRET_SHOULD_NOT_LEAK");
  const ms = Date.parse(RECENT);
  const ins = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  ins.run("m1", "ses_oc1", ms, ms, JSON.stringify({ role: "assistant", modelID: "claude-sonnet-5", providerID: "github-copilot",
    tokens: { input: 5, output: 7, reasoning: 3, cache: { read: 11, write: 13 } }, time: { created: ms } }));
  ins.run("m2", "ses_oc1", ms + 1000, ms + 1000, JSON.stringify({ role: "user", time: { created: ms + 1000 }, content: "OC_SECRET_SHOULD_NOT_LEAK" }));
  db.close();
  const srv = await v2Server();
  const res = await runCli([], { home, state, url: srv.url });
  eq("1b: exit 0", res.code, 0);
  const b = srv.requests[0]?.body ?? {};
  const oc = (b.sessions ?? []).filter((s) => s.tool === "opencode");
  eq("1b: opencode session rows", oc.map((s) => `${s.sessionId}|${s.model}|${s.provider}|${s.inputTokens}|${s.outputTokens}|${s.cacheReadTokens}|${s.cacheCreationTokens}|${s.requests}`),
    ["ses_oc1|claude-sonnet-5|github-copilot|5|10|11|13|1"]);
  const deviceIdOnDisk = readFileSync(path.join(state, "device-id"), "utf8").trim();
  check("1b: opencode rows carry machineId", oc.length > 0 && oc.every((s) => s.machineId === deviceIdOnDisk));
  eq("1b: opencode health", (b.health ?? []).find((h) => h.parser === "opencode"),
    { parser: "opencode", filesScanned: 1, linesUnrecognized: 0, sessionsEmitted: 1 });
  check("1b: no secret in body", !(srv.requests[0]?.raw ?? "").includes("OC_SECRET_SHOULD_NOT_LEAK"));
  await srv.close();
}

// T9. Codex rate-limit windows join the /api/limits snapshot (no Claude
// credentials in the temp HOME → Claude only warns; no network beyond the fake).
{
  const writeRollout = (home, rateLimits, ts = RECENT) => writeLines(
    path.join(home, ".codex", "sessions", "2026", "09", "30", "rollout-2026-09-30T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"),
    [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      { type: "event_msg", timestamp: ts, payload: { type: "token_count",
        info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
        rate_limits: rateLimits } },
    ]);
  // resets relative to the real clock (the CLI stamps freshness with Date.now()).
  const RESET_S = Math.floor(Date.now() / 1000) + 2 * 3600;
  const RESET_ISO = new Date(RESET_S * 1000).toISOString();
  const RL = { limit_id: "codex", limit_name: null,
    primary: { used_percent: 41.5, window_minutes: 300, resets_at: RESET_S },
    secondary: { used_percent: 12, window_minutes: 10080, resets_at: RESET_S },
    credits: { has_credits: false, unlimited: false, balance: "SHOULD_NOT_SEND" } };
  const limitsServer = (limitsStatus = 200) => startServer((body, n, url) => {
    if (url === "/api/limits") {
      return limitsStatus === 200
        ? { status: 200, json: { ok: true, upserted: body?.snapshots?.length ?? 0 } }
        : { status: limitsStatus, json: { error: "boom" } };
    }
    return { status: 200, json: { ok: true, sessionsUpserted: body?.sessions?.length ?? 0 } };
  });
  const kstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  // --limits-only: one POST to /api/limits with both codex windows
  {
    const { home, state } = sandbox();
    writeRollout(home, RL);
    const srv = await limitsServer();
    const r = await runCli(["--limits-only"], { home, state, url: srv.url, limits: true });
    eq("T9 limits-only: exit 0", r.code, 0);
    const lim = srv.requests.filter((q) => q.url === "/api/limits");
    eq("T9 limits-only: one limits POST", lim.length, 1);
    // R23 + F3: organization = "device:" + sha1(pseudonymous device-id)[0:8]
    const org = `device:${tag8(readFileSync(path.join(state, "device-id"), "utf8").trim())}`;
    check("R23 limits-only: org is device-id based", /^device:[0-9a-f]{8}$/.test(org));
    eq("T9 limits-only: codex snapshots", lim[0]?.body?.snapshots, [
      { date: kstToday, accountEmail: "codex:codex", organization: org, window: "codex_300m", utilizationPct: 41.5, resetsAt: RESET_ISO },
      { date: kstToday, accountEmail: "codex:codex", organization: org, window: "codex_10080m", utilizationPct: 12, resetsAt: RESET_ISO },
    ]);
    noHostname("R23 limits-only", lim[0]?.raw ?? "");
    check("T9 limits-only: credits never sent", !(lim[0]?.raw ?? "").includes("SHOULD_NOT_SEND"));
    check("T9 limits-only: claude failure only warns", /warn: .*[Cc]laude/.test(r.stderr));
    await srv.close();
  }
  // a normal run uploads usage, then the codex limits
  {
    const { home, state } = sandbox();
    writeRollout(home, RL);
    const srv = await limitsServer();
    const r = await runCli([], { home, state, url: srv.url, limits: true });
    eq("T9 run: exit 0", r.code, 0);
    eq("T9 run: ingest then limits", srv.requests.map((q) => q.url), ["/api/ingest", "/api/limits"]);
    eq("T9 run: codex windows", (srv.requests[1]?.body?.snapshots ?? []).map((s) => s.window), ["codex_300m", "codex_10080m"]);
    await srv.close();
  }
  // R23: --machine-id override is what the organization is built from
  {
    const { home, state } = sandbox();
    writeRollout(home, RL);
    const srv = await limitsServer();
    await runCli(["--limits-only", "--machine-id", "feedbeef-0000-4000-8000-000000000000"], { home, state, url: srv.url, limits: true });
    eq("R23 --machine-id → organization", (srv.requests[0]?.body?.snapshots ?? []).map((s) => s.organization), [`device:${tag8("feedbeef-0000-4000-8000-000000000000")}`, `device:${tag8("feedbeef-0000-4000-8000-000000000000")}`]);
    check("F3 --machine-id: no raw override chars in organization", !(srv.requests[0]?.raw ?? "").includes("feedbeef"));
    await srv.close();
  }
  // R23: the newest reading is 6h old → the 300m window is stale, weekly kept;
  // an expired reset drops the window too
  {
    const { home, state } = sandbox();
    writeRollout(home, { ...RL, secondary: { ...RL.secondary, resets_at: Math.floor(Date.now() / 1000) - 60 } },
      new Date(Date.now() - 6 * 3600_000).toISOString());
    const srv = await limitsServer();
    const r = await runCli(["--limits-only"], { home, state, url: srv.url, limits: true });
    eq("R23 stale: exit 0", r.code, 0);
    eq("R23 stale: nothing POSTed (300m too old, 10080m reset passed)", srv.requests.length, 0);
    await srv.close();
  }
  {
    const { home, state } = sandbox();
    writeRollout(home, RL, new Date(Date.now() - 6 * 3600_000).toISOString());
    const srv = await limitsServer();
    await runCli(["--limits-only"], { home, state, url: srv.url, limits: true });
    eq("R23 stale 300m only: weekly still sent", (srv.requests[0]?.body?.snapshots ?? []).map((s) => s.window), ["codex_10080m"]);
    await srv.close();
  }
  // limits endpoint failing → warn only, exit 0
  {
    const { home, state } = sandbox();
    writeRollout(home, RL);
    const srv = await limitsServer(500);
    const r = await runCli(["--limits-only"], { home, state, url: srv.url, limits: true });
    eq("T9 limits 500: exit 0", r.code, 0);
    check("T9 limits 500: warns about the upload", /warn: .*limits upload failed \(500\)/.test(r.stderr));
    await srv.close();
  }
  // no rate_limits anywhere and no Claude account → nothing POSTed, exit 0
  {
    const { home, state } = sandbox();
    const srv = await limitsServer();
    const r = await runCli(["--limits-only"], { home, state, url: srv.url, limits: true });
    eq("T9 none: exit 0", r.code, 0);
    eq("T9 none: no limits POST", srv.requests.length, 0);
    await srv.close();
  }
  // --dry-run prints the codex windows, sends nothing
  {
    const { home, state } = sandbox();
    writeRollout(home, RL);
    const srv = await limitsServer();
    const r = await runCli(["--dry-run"], { home, state, url: srv.url, limits: true });
    eq("T9 dry-run: exit 0", r.code, 0);
    eq("T9 dry-run: nothing sent", srv.requests.length, 0);
    check("T9 dry-run: codex windows printed", /codex_300m/.test(r.stdout) && /codex_10080m/.test(r.stdout));
    await srv.close();
  }
}

// 2. CLI against an old server: 400 at path rows → v1 retry, mode v1-fallback,
// cursor advanced -------------------------------------------------------------
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [
    ccLine("s1", "m1", "r1", RECENT, "claude-opus-5", [10, 20, 30, 40]),
  ]);
  const srv = await oldServer();
  const res = await runCli([], { home, state, url: srv.url });
  eq("2: exit 0", res.code, 0);
  eq("2: two POSTs", srv.requests.length, 2);
  check("2: first is v2", Array.isArray(srv.requests[0]?.body?.sessions));
  const r2 = srv.requests[1]?.body ?? {};
  eq("2: retry rows", (r2.rows ?? []).map((r) => `${r.tool}|${r.inputTokens}`), ["claude_code|10"]);
  check("2: retry carries hourly", Array.isArray(r2.hourly) && r2.hourly.length === 1);
  check("2: retry has no sessions", !("sessions" in r2));
  check("2: stdout says v1-fallback", /v1-fallback/.test(res.stdout));
  check("2: cursor advanced", existsSync(path.join(state, "cursor.json")));
  for (const q of srv.requests) noHostname("2/5", q.raw);
  await srv.close();
}

// 3. CLI against a 500 server: exit 1, cursor NOT advanced -------------------
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [
    ccLine("s1", "m1", "r1", RECENT, "claude-opus-5", [10, 20, 30, 40]),
  ]);
  mkdirSync(state, { recursive: true });
  const before = { lastSuccessAt: "2026-09-29T00:00:00.000Z", lastFullAt: "2026-09-28T00:00:00.000Z", parserVersion: PARSER_VERSION };
  writeFileSync(path.join(state, "cursor.json"), JSON.stringify(before));
  const srv = await startServer(() => ({ status: 500, json: { error: "boom" } }));
  const res = await runCli([], { home, state, url: srv.url });
  eq("3: exit 1", res.code, 1);
  eq("3: cursor unchanged", readJson(path.join(state, "cursor.json")), before);
  await srv.close();
}

// 9. CLI: 400 that is not a missing-rows/unknown-keys issue → exit 1, no v1 --
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [
    ccLine("s1", "m1", "r1", RECENT, "claude-opus-5", [10, 20, 30, 40]),
  ]);
  const srv = await startServer(() => ({ status: 400, json: { issues: [{ code: "too_big", path: ["sessions"] }] } }));
  const res = await runCli([], { home, state, url: srv.url });
  eq("9: exit 1", res.code, 1);
  eq("9: no retry", srv.requests.length, 1);
  check("9: no cursor", !existsSync(path.join(state, "cursor.json")));
  await srv.close();
}

// 7. CLI heartbeat (R12): no usage → one POST {device, health}; old server 400
// is ignored silently (exit 0, no v1 retry) -----------------------------------
{
  const { home, state } = sandbox();
  const srv = await v2Server();
  const res = await runCli([], { home, state, url: srv.url });
  eq("7: exit 0", res.code, 0);
  eq("7: one POST", srv.requests.length, 1);
  const b = srv.requests[0]?.body ?? {};
  eq("7: heartbeat keys", Object.keys(b).sort(), ["device", "health"]);
  noHostname("7", srv.requests[0]?.raw ?? "");
  await srv.close();

  const { home: h2, state: s2 } = sandbox();
  const old = await oldServer();
  const res2 = await runCli([], { home: h2, state: s2, url: old.url });
  eq("7: old server heartbeat → exit 0", res2.code, 0);
  eq("7: old server heartbeat → no retry", old.requests.length, 1);
  check("7: old server heartbeat → silent (no error line)", !/error|failed/i.test(res2.stderr));
  await old.close();
}

// 8. R6 sticky attribution across runs: run 1 (full) sees A(aaa); run 2
// (incremental) sees only a fork file B(a00 < aaa) with the same message → the
// message stays on "aaa". Control without the index → "a00". -----------------
{
  const { home, state } = sandbox();
  const dir = path.join(home, ".claude", "projects", "p");
  const shared = ccLine("aaa", "m-shared", "r-shared", RECENT, "claude-opus-5", [5, 5, 0, 0]);
  writeLines(path.join(dir, "aaa.jsonl"), [shared], OLD_MTIME);
  const srv = await v2Server();
  const r1 = await runCli([], { home, state, url: srv.url });
  eq("8: run1 exit 0", r1.code, 0);
  eq("8: run1 session", (srv.requests[0]?.body?.sessions ?? []).map((s) => s.sessionId), ["aaa"]);
  check("8: index written", existsSync(path.join(state, "claude-attr.json")));

  // Fork file B: copies the shared line under sessionId a00, plus a new message.
  writeLines(path.join(dir, "a00.jsonl"), [
    { ...shared, sessionId: "a00" },
    ccLine("a00", "m-new", "r-new", RECENT, "claude-opus-5", [7, 7, 0, 0]),
  ]);
  const r2 = await runCli([], { home, state, url: srv.url });
  eq("8: run2 exit 0", r2.code, 0);
  const run2 = srv.requests[1]?.body?.sessions ?? [];
  check("8: run2 was incremental (file A skipped by mtime)", /incremental/.test(r2.stderr));
  eq("8: run2 shared message stays on aaa",
    run2.map((s) => `${s.sessionId}|${s.inputTokens}`).sort(), ["a00|7", "aaa|5"]);

  // Control: same files + cursor, no index → min rule moves it to a00.
  rmSync(path.join(state, "claude-attr.json"));
  const r3 = await runCli([], { home, state, url: srv.url });
  eq("8: control exit 0", r3.code, 0);
  eq("8: control (no index) → a00",
    (srv.requests[2]?.body?.sessions ?? []).map((s) => `${s.sessionId}|${s.inputTokens}`).sort(), ["a00|12"]);
  await srv.close();
}

// 10. dry-run: sends nothing, no cursor, no index; prints per-tool summary ----
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [
    ccLine("s1", "m1", "r1", RECENT, "claude-opus-5", [10, 20, 30, 40]),
    ccLine("s2", "m2", "r2", RECENT, "claude-opus-5", [1, 2, 3, 4]),
  ]);
  const srv = await v2Server();
  const res = await runCli(["--dry-run"], { home, state, url: srv.url });
  eq("10: exit 0", res.code, 0);
  eq("10: no POST", srv.requests.length, 0);
  check("10: no cursor", !existsSync(path.join(state, "cursor.json")));
  check("10: no attr index", !existsSync(path.join(state, "claude-attr.json")));
  check("10: per-tool session count", /claude_code\s+2 session\(s\)/.test(res.stdout));
  check("10: token sum", /input 11/.test(res.stdout));
  check("10: health printed", /health/i.test(res.stdout) && /filesScanned/.test(res.stdout));
  await srv.close();
}

// 11. device label: config deviceLabel (trimmed) / --device-label; >32 → exit 2
{
  const { home, state } = sandbox();
  mkdirSync(path.join(home, ".config", "token-forest"), { recursive: true });
  writeFileSync(path.join(home, ".config", "token-forest", "config.json"), JSON.stringify({ deviceLabel: "  맥북  " }));
  const srv = await v2Server();
  const r = await runCli([], { home, state, url: srv.url });
  eq("11: exit 0", r.code, 0);
  eq("11: label from config, trimmed", srv.requests[0]?.body?.device?.label, "맥북");
  const r2 = await runCli(["--device-label", "dev2"], { home, state, url: srv.url });
  eq("11: flag exit 0", r2.code, 0);
  eq("11: flag overrides config", srv.requests[1]?.body?.device?.label, "dev2");
  const r3 = await runCli(["--device-label", "x".repeat(33)], { home, state, url: srv.url });
  eq("11: >32 → exit 2", r3.code, 2);
  check("11: clear error", /device label.*32/i.test(r3.stderr));
  eq("11: >32 → nothing sent", srv.requests.length, 2);
  await srv.close();
}

// 14. --since (explicit) ignores and keeps the cursor; --full forces full -----
{
  const { home, state } = sandbox();
  const dir = path.join(home, ".claude", "projects", "p");
  writeLines(path.join(dir, "old.jsonl"), [ccLine("old", "m-o", "r-o", RECENT, "opus", [3, 3, 0, 0])], OLD_MTIME);
  mkdirSync(state, { recursive: true });
  const recentFull = new Date(Date.now() - 86400_000).toISOString();
  const before = { lastSuccessAt: new Date().toISOString(), lastFullAt: recentFull, parserVersion: PARSER_VERSION };
  writeFileSync(path.join(state, "cursor.json"), JSON.stringify(before));
  const srv = await v2Server();
  // Incremental (cursor fresh): old.jsonl is skipped by mtime → heartbeat.
  await runCli([], { home, state, url: srv.url });
  check("14: incremental skips old file", !srv.requests[0]?.body?.sessions);
  // --full: sends it and stamps lastFullAt.
  await runCli(["--full"], { home, state, url: srv.url });
  eq("14: --full sends old file", (srv.requests[1]?.body?.sessions ?? []).map((s) => s.sessionId), ["old"]);
  const afterFull = readJson(path.join(state, "cursor.json"));
  check("14: --full stamps lastFullAt", afterFull.lastFullAt > recentFull);
  // --since explicit: window from flag, cursor untouched.
  const since = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  await runCli(["--since", since], { home, state, url: srv.url });
  eq("14: --since sends in-window rows", (srv.requests[2]?.body?.sessions ?? []).map((s) => s.sessionId), ["old"]);
  eq("14: --since leaves cursor untouched", readJson(path.join(state, "cursor.json")), afterFull);
  await srv.close();
}

// Helpers for the fix-round cases below.
const freshCursor = () => ({ lastSuccessAt: new Date().toISOString(), lastFullAt: new Date(Date.now() - 86400_000).toISOString(), parserVersion: PARSER_VERSION });
function seedCursor(state, c) {
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "cursor.json"), JSON.stringify(c));
}

// R21 lock: held → second run prints one line, exits 0, sends nothing, leaves
// the lock; stale (>2h) → taken over, run proceeds, lock released afterwards.
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [ccLine("s1", "m1", "r1", RECENT, "opus", [1, 1, 0, 0])]);
  mkdirSync(state, { recursive: true });
  const lockFile = path.join(state, "run.lock");
  // A live pid (this test process) with a fresh timestamp = genuinely held.
  const held = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  writeFileSync(lockFile, held);
  const srv = await v2Server();
  const r = await runCli([], { home, state, url: srv.url });
  eq("R21: held → exit 0", r.code, 0);
  eq("R21: held → nothing sent", srv.requests.length, 0);
  check("R21: held → one-line notice", /already running/.test(r.stdout) && r.stdout.trim().split("\n").length === 1);
  eq("R21: held → lock untouched", readFileSync(lockFile, "utf8"), held);
  check("R21: held → no cursor", !existsSync(path.join(state, "cursor.json")));
  writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: new Date(Date.now() - 3 * 3600_000).toISOString() }));
  const r2 = await runCli([], { home, state, url: srv.url });
  eq("R21: stale → exit 0", r2.code, 0);
  eq("R21: stale → sent", srv.requests.length, 1);
  check("R21: stale → lock released after run", !existsSync(lockFile));
  const r3 = await runCli(["--dry-run"], { home, state, url: srv.url, extraEnv: {} });
  eq("R21: dry-run ignores the lock", r3.code, 0);
  // Unit: acquire → second acquire refused → release → acquire again.
  const a = lockMod.acquireRunLock();
  check("R21 unit: acquired", a.acquired);
  check("R21 unit: second refused", !lockMod.acquireRunLock().acquired);
  a.release();
  const b = lockMod.acquireRunLock();
  check("R21 unit: re-acquired after release", b.acquired);
  b.release();
  check("R21 unit: stale taken over", (() => {
    writeFileSync(lockFile, JSON.stringify({ pid: 1, at: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    const c = lockMod.acquireRunLock();
    const ok = c.acquired;
    if (ok) c.release();
    return ok;
  })());
  await srv.close();
}

// R20 via the CLI: a full run drops pins it did not see; an incremental run
// never prunes. R19: a cursor from another parser version forces a full run.
{
  const { home, state } = sandbox();
  const dir = path.join(home, ".claude", "projects", "p");
  writeLines(path.join(dir, "s1.jsonl"), [ccLine("s1", "m1", "r1", RECENT, "opus", [1, 1, 0, 0])], OLD_MTIME);
  mkdirSync(state, { recursive: true });
  const attrFile = path.join(state, "claude-attr.json");
  writeFileSync(attrFile, JSON.stringify({ version: 2, entries: { ffffffffffffffff: "vanished" } }));
  seedCursor(state, freshCursor());
  const srv = await v2Server();
  await runCli([], { home, state, url: srv.url }); // incremental
  check("R20: incremental keeps unseen pin", attrMod.loadAttribution().has("ffffffffffffffff"));
  check("R20: incremental skipped the old file (heartbeat)", !srv.requests[0]?.body?.sessions);
  seedCursor(state, { ...freshCursor(), parserVersion: PARSER_VERSION - 1 });
  const r = await runCli([], { home, state, url: srv.url }); // R19 → full
  check("R19: other parserVersion → full run", /\(full\)/.test(r.stderr));
  eq("R19: full run sent the old file", (srv.requests[1]?.body?.sessions ?? []).map((x) => x.sessionId), ["s1"]);
  eq("R19: cursor re-stamped with current parserVersion", readJson(path.join(state, "cursor.json")).parserVersion, PARSER_VERSION);
  const after = attrMod.loadAttribution();
  check("R20: full run dropped the unseen pin", !after.has("ffffffffffffffff"));
  check("R20: full run kept the seen pin", after.get(attrMod.attrKey("m1|r1")) === "s1");
  await srv.close();
}

// Minor a: old server, session rows present but none inside the v1 window →
// explicit notice, lastFullAt NOT stamped, exit 0.
{
  const { home, state } = sandbox();
  const old = new Date(Date.now() - 60 * 86400_000).toISOString();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [ccLine("s1", "m1", "r1", old, "opus", [1, 1, 0, 0])]);
  // Cursor from an older parser version (R19 forces this full run).
  seedCursor(state, { lastSuccessAt: new Date().toISOString(), lastFullAt: null, parserVersion: PARSER_VERSION - 1 });
  const srv = await oldServer();
  const r = await runCli([], { home, state, url: srv.url });
  eq("a: exit 0", r.code, 0);
  eq("a: only the v2 attempt", srv.requests.length, 1);
  check("a: says server is v1", /server is v1/i.test(r.stdout) && !/Done \(v2\)/.test(r.stdout));
  const c = readJson(path.join(state, "cursor.json"));
  eq("a: lastFullAt unchanged (null)", c.lastFullAt, null);
  eq("a/round2: old parserVersion kept under keepFull", c.parserVersion, PARSER_VERSION - 1);
  check("a: lastSuccessAt set", typeof c.lastSuccessAt === "string");
  await srv.close();
}

// Minor b: TOKEN_FOREST_SINCE is a floor under the cursor window — the run
// stays cursor-driven (cursor advances) and nothing before the floor is sent.
{
  const { home, state } = sandbox();
  const dir = path.join(home, ".claude", "projects", "p");
  const floor = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  writeLines(path.join(dir, "s1.jsonl"), [
    ccLine("s1", "m-before", "r1", new Date(Date.now() - 20 * 86400_000).toISOString(), "opus", [1, 1, 0, 0]),
    ccLine("s1", "m-after", "r2", RECENT, "opus", [2, 2, 0, 0]),
  ]);
  const srv = await v2Server();
  const r = await runCli([], { home, state, url: srv.url, extraEnv: { TOKEN_FOREST_SINCE: floor } });
  eq("b: exit 0", r.code, 0);
  eq("b: only rows after the floor", (srv.requests[0]?.body?.sessions ?? []).map((x) => x.inputTokens), [2]);
  const c = existsSync(path.join(state, "cursor.json")) ? readJson(path.join(state, "cursor.json")) : {};
  check("b: cursor advanced (not frozen)", typeof c.lastSuccessAt === "string" && typeof c.lastFullAt === "string");
  await srv.close();
}

// Minor c: missing credentials → exit 2 and the attribution index is NOT saved.
{
  const { home, state } = sandbox();
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [ccLine("s1", "m1", "r1", RECENT, "opus", [1, 1, 0, 0])]);
  const r = await runCli([], { home, state, url: null });
  eq("c: no credentials → exit 2", r.code, 2);
  check("c: no attr index", !existsSync(path.join(state, "claude-attr.json")));
  check("c: no cursor", !existsSync(path.join(state, "cursor.json")));
  check("c: lock released", !existsSync(path.join(state, "run.lock")));
}

// Round 2 / 1: a full run whose walk hit an unreadable dir, or found no files,
// must not prune pins.
{
  const { home, state } = sandbox();
  const projects = path.join(home, ".claude", "projects");
  writeLines(path.join(projects, "p-ok", "s1.jsonl"), [ccLine("s1", "m1", "r1", RECENT, "opus", [1, 1, 0, 0])]);
  const locked = path.join(projects, "p-locked");
  writeLines(path.join(locked, "s2.jsonl"), [ccLine("s2", "m2", "r2", RECENT, "opus", [1, 1, 0, 0])]);
  mkdirSync(state, { recursive: true });
  const attrFile = path.join(state, "claude-attr.json");
  const seedPins = () => writeFileSync(attrFile, JSON.stringify({ version: 2, entries: { [attrMod.attrKey("m2|r2")]: "s2" } }));
  const srv = await v2Server();
  if (process.getuid?.() === 0) {
    console.error("note: running as root — chmod 000 is not enforced, skipping the unreadable-dir case");
  } else {
    seedPins();
    chmodSync(locked, 0o000);
    try {
      const r = await runCli([], { home, state, url: srv.url }); // no cursor → full
      eq("dirErrors: exit 0", r.code, 0);
      check("dirErrors: warns scan incomplete", /scan incomplete/.test(r.stderr));
      eq("dirErrors: pin in unreadable dir kept", attrMod.loadAttribution().get(attrMod.attrKey("m2|r2")), "s2");
      const direct = await claudeCode.aggregate({});
      eq("dirErrors: parser counts it", direct.stats.dirErrors, 1);
    } finally {
      chmodSync(locked, 0o755);
    }
  }
  // Readable again: a clean full run prunes nothing it saw (both pins stay).
  const r2 = await runCli(["--full"], { home, state, url: srv.url });
  eq("dirErrors: clean full exit 0", r2.code, 0);
  eq("dirErrors: clean full → 0 dir errors", (await claudeCode.aggregate({})).stats.dirErrors, 0);
  await srv.close();

  // files === 0: no transcripts at all → keep pins.
  const { home: h2, state: s2 } = sandbox();
  mkdirSync(s2, { recursive: true });
  writeFileSync(path.join(s2, "claude-attr.json"), JSON.stringify({ version: 2, entries: { eeeeeeeeeeeeeeee: "x" } }));
  const srv2 = await v2Server();
  const r3 = await runCli([], { home: h2, state: s2, url: srv2.url });
  eq("files=0: exit 0", r3.code, 0);
  check("files=0: pin kept", attrMod.loadAttribution().has("eeeeeeeeeeeeeeee"));
  eq("files=0: missing projects root is not a dir error", (await claudeCode.aggregate({})).stats.dirErrors, 0);
  await srv2.close();
}

// Round 2 / 2+3: lock pid liveness, content-changed takeover, signal release.
{
  const { home, state } = sandbox();
  mkdirSync(state, { recursive: true });
  const lockFile = path.join(state, "run.lock");
  // A pid that just exited → dead → taken over at once despite a fresh age.
  const deadPid = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", ""]);
    c.on("close", () => resolve(c.pid));
  });
  check("lock: pidAlive(dead) false", lockMod.pidAlive(deadPid) === false);
  check("lock: pidAlive(self) true", lockMod.pidAlive(process.pid) === true);
  writeFileSync(lockFile, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }));
  const t = lockMod.acquireRunLock();
  check("lock: dead pid + fresh age → taken over", t.acquired);
  if (t.acquired) t.release();
  // Content changed between the stale judgement and the takeover → back off.
  const judged = JSON.stringify({ pid: deadPid, at: "2000-01-01T00:00:00.000Z" });
  const winner = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  writeFileSync(lockFile, winner);
  check("lock: content changed → no takeover", lockMod.takeOverIfUnchanged(lockFile, judged, "mine") === false);
  eq("lock: winner's lock untouched", readFileSync(lockFile, "utf8"), winner);
  check("lock: unchanged content → takeover", lockMod.takeOverIfUnchanged(lockFile, winner, "mine") === true);
  eq("lock: now ours", readFileSync(lockFile, "utf8"), "mine");
  rmSync(lockFile);

  // SIGTERM mid-upload → exit 143 and the lock is released.
  writeLines(path.join(home, ".claude", "projects", "p", "s1.jsonl"), [ccLine("s1", "m1", "r1", RECENT, "opus", [1, 1, 0, 0])]);
  let arrived;
  const gotRequest = new Promise((r) => (arrived = r));
  const hang = http.createServer((req) => { req.resume(); arrived(); }); // never answers
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("TOKEN_FOREST_")) env[k] = v;
  Object.assign(env, { HOME: home, TOKEN_FOREST_STATE_DIR: state,
    TOKEN_FOREST_URL: `http://127.0.0.1:${hang.address().port}`, TOKEN_FOREST_TOKEN: "t" });
  const child = spawn(process.execPath, [CLI, "--no-limits"], { env });
  const exited = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
  await gotRequest;
  check("signal: lock held during upload", existsSync(lockFile));
  child.kill("SIGTERM");
  const ex = await exited;
  eq("signal: SIGTERM → exit 143", ex.code, 143);
  check("signal: lock released", !existsSync(lockFile));
  hang.closeAllConnections?.();
  await new Promise((r) => hang.close(r));
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("ALL PASS");
