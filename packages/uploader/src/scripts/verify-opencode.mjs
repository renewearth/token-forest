// Tests for the opencode parser. Builds throwaway SQLite fixtures with
// node:sqlite in a temp dir (never touches ~/.local/share/opencode). Run with node.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { aggregate, classifyError } from "../parsers/opencode.mjs";
import { PARSER_VERSION } from "../lib/sessions.mjs";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

const dir = mkdtempSync(path.join(tmpdir(), "tf-opencode-"));
const SECRET = "SECRET_SHOULD_NOT_LEAK";

// Real opencode schema (measured 2026-09-30) + account/credential tables that
// hold plaintext tokens in the real DB — the parser must never read them.
function makeDb(name, messages, { withMessage = true } = {}) {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  if (withMessage) {
    db.exec(`CREATE TABLE message (id text PRIMARY KEY, session_id text,
      time_created integer, time_updated integer, data text)`);
  }
  db.exec("CREATE TABLE account (id text PRIMARY KEY, token text)");
  db.exec("CREATE TABLE credential (id text PRIMARY KEY, token text)");
  db.prepare("INSERT INTO account VALUES (?, ?)").run("a1", SECRET);
  db.prepare("INSERT INTO credential VALUES (?, ?)").run("c1", SECRET);
  if (withMessage) {
    const ins = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    for (const m of messages) {
      ins.run(m.id, m.session_id, m.time_created, m.time_created,
        typeof m.data === "string" ? m.data : JSON.stringify(m.data));
    }
  }
  db.close();
  return file;
}

// 2026-09-30T02:00:00Z = 2026-09-30T11 KST
const T = Date.parse("2026-09-30T02:00:00Z");
const assistant = (id, session, ms, tokens, extra = {}) => ({
  id, session_id: session, time_created: ms,
  data: {
    role: "assistant", modelID: "claude-sonnet-5", providerID: "github-copilot", cost: 0.07,
    tokens, time: { created: ms, completed: ms + 1000 }, path: { cwd: "/home/someone/proj" },
    ...extra,
  },
});
const user = (id, session, ms) => ({
  id, session_id: session, time_created: ms,
  data: { role: "user", time: { created: ms }, content: SECRET },
});
const tok = (input, output, reasoning, read, write) => ({
  total: input + output + reasoning + read + write, input, output, reasoning,
  cache: { read, write },
});

// (1)+(2)+(3): two assistant messages in one session + one user message.
{
  const file = makeDb("basic.db", [
    assistant("m1", "ses_A", T, tok(2, 5, 0, 0, 28697)),
    user("m2", "ses_A", T + 5000),
    assistant("m3", "ses_A", T + 10000, tok(10, 20, 7, 100, 0)),
  ]);
  const res = await aggregate({ sinceDate: "2026-09-30", machineId: "host-1", dbPath: file });

  eq("(1) one session row", res.sessions.length, 1);
  const s = res.sessions[0];
  eq("(1) tool", s.tool, "opencode");
  eq("(1) sessionId = session_id", s.sessionId, "ses_A");
  eq("(1) KST hour", s.hour, "2026-09-30T11");
  eq("(1) model", s.model, "claude-sonnet-5");
  eq("(1) provider", s.provider, "github-copilot");
  eq("(1) input sum", s.inputTokens, 12);
  eq("(2) output = output + reasoning", s.outputTokens, 5 + 20 + 7);
  eq("(1) cacheRead = cache.read", s.cacheReadTokens, 100);
  eq("(1) cacheCreation = cache.write", s.cacheCreationTokens, 28697);
  eq("(1) requests = assistant messages", s.requests, 2);
  eq("(1) parserVersion", s.parserVersion, PARSER_VERSION);

  eq("rows: one daily row", res.rows.length, 1);
  const r = res.rows[0];
  eq("rows: date", r.date, "2026-09-30");
  eq("rows: tool", r.tool, "opencode");
  eq("rows: machineId", r.machineId, "host-1");
  eq("rows: input", r.inputTokens, 12);
  eq("rows: output", r.outputTokens, 32);
  eq("rows: cacheRead", r.cacheReadTokens, 100);
  eq("rows: cacheCreation", r.cacheCreationTokens, 28697);
  eq("rows: requests", r.requests, 2);
  eq("rows: sessions = distinct sessions that day", r.sessions, 1);
  eq("rows: source", r.source, "uploader");
  eq("hourly: one row", res.hourlyRows.length, 1);
  eq("hourly: hour", res.hourlyRows[0].hour, "2026-09-30T11");
  eq("hourly: requests", res.hourlyRows[0].requests, 2);

  eq("health shape", res.health,
    { parser: "opencode", filesScanned: 1, linesUnrecognized: 0, sessionsEmitted: 1 });
  eq("stats.events", res.stats.events, 2);

  check("(3) no secret anywhere in result", !JSON.stringify(res).includes(SECRET));
  check("(3) no cwd path leaks into result", !JSON.stringify(res).includes("/home/someone"));
}

// A token property omitted by OpenCode must not become an observed zero.
{
  const file = makeDb("missing-token.db", [
    assistant("missing", "ses_missing", T, { input: 0, output: 3, reasoning: 0 }),
  ]);
  const res = await aggregate({ sinceDate: "2026-09-30", dbPath: file });
  eq("missing cache read stays null", res.sessions[0]?.cacheReadTokens, null);
  eq("missing cache write stays null", res.rows[0]?.cacheCreationTokens, null);
  eq("explicit input zero stays known", res.sessions[0]?.fieldEvidence?.inputTokens, "known");
}

// (4) missing DB -> empty result, no throw, no error.
{
  let res, threw = false;
  try {
    res = await aggregate({ sinceDate: "2026-09-30", dbPath: path.join(dir, "nope.db") });
  } catch { threw = true; }
  check("(4) missing db does not throw", !threw);
  eq("(4) empty rows", res?.rows, []);
  eq("(4) empty hourly", res?.hourlyRows, []);
  eq("(4) empty sessions", res?.sessions, []);
  eq("(4) health no error, 0 files", res?.health,
    { parser: "opencode", filesScanned: 0, linesUnrecognized: 0, sessionsEmitted: 0 });
}

// (5) wrong schema (no message table) -> empty + health.error.
{
  const file = makeDb("noschema.db", [], { withMessage: false });
  let res, threw = false;
  try { res = await aggregate({ dbPath: file }); } catch { threw = true; }
  check("(5) bad schema does not throw", !threw);
  eq("(5) empty sessions", res?.sessions, []);
  eq("(5) empty rows", res?.rows, []);
  eq("(5) health.error", res?.health?.error, "schema mismatch");
  eq("(5) filesScanned = 1 (db opened)", res?.health?.filesScanned, 1);
  check("(5) no secret in result", !JSON.stringify(res).includes(SECRET));
}

// sinceDate: window starts at KST midnight (2026-09-29T15:00Z = 09-30 00:00 KST).
{
  const midnight = Date.parse("2026-09-29T15:00:00Z");
  const file = makeDb("since.db", [
    assistant("o1", "ses_old", midnight - 1, tok(1000, 0, 0, 0, 0)),
    assistant("n1", "ses_new", midnight, tok(1, 1, 0, 0, 0)),
  ]);
  const res = await aggregate({ sinceDate: "2026-09-30", dbPath: file });
  eq("since: only the post-midnight message", res.sessions.map((s) => s.sessionId), ["ses_new"]);
  eq("since: KST hour 00", res.sessions[0]?.hour, "2026-09-30T00");
  const all = await aggregate({ dbPath: file });
  eq("no sinceDate: everything", all.sessions.length, 2);
}

// Malformed JSON counts as unrecognized; assistant without tokens is ignored;
// ts falls back to the time_created column when data.time.created is absent.
{
  const noTime = assistant("t1", "ses_B", T, tok(3, 4, 0, 0, 0));
  delete noTime.data.time;
  const file = makeDb("messy.db", [
    { id: "bad", session_id: "ses_B", time_created: T, data: "{not json" },
    { id: "nt", session_id: "ses_B", time_created: T,
      data: { role: "assistant", modelID: "m", providerID: "p", time: { created: T } } },
    noTime,
  ]);
  const res = await aggregate({ dbPath: file });
  eq("messy: linesUnrecognized", res.health.linesUnrecognized, 1);
  eq("messy: one session row (tokenless skipped)", res.sessions.length, 1);
  eq("messy: requests 1", res.sessions[0]?.requests, 1);
  eq("messy: ts fallback hour", res.sessions[0]?.hour, "2026-09-30T11");
}

// Two sessions, two models, one day -> rows fold by date|model, sessions on first row.
{
  const file = makeDb("multi.db", [
    assistant("a", "ses_1", T, tok(1, 1, 0, 0, 0)),
    assistant("b", "ses_2", T, tok(2, 2, 0, 0, 0), { modelID: "gpt-5.5", providerID: "openai" }),
  ]);
  const res = await aggregate({ dbPath: file });
  eq("multi: 2 session rows", res.sessions.length, 2);
  eq("multi: 2 daily rows", res.rows.length, 2);
  eq("multi: first row sessions = 2", res.rows[0].sessions, 2);
  eq("multi: second row sessions = null", res.rows[1].sessions, null);
  eq("multi: provider per row", res.sessions.map((s) => s.provider), ["github-copilot", "openai"]);
}

// Locked DB (another connection holds an exclusive lock) -> "db locked".
{
  const file = makeDb("locked.db", [assistant("x", "ses_L", T, tok(1, 1, 0, 0, 0))]);
  const holder = new DatabaseSync(file);
  holder.exec("BEGIN EXCLUSIVE");
  let res, threw = false;
  try { res = await aggregate({ dbPath: file }); } catch { threw = true; }
  holder.exec("ROLLBACK");
  holder.close();
  check("locked: does not throw", !threw);
  eq("locked: health.error", res?.health?.error, "db locked");
  eq("locked: empty sessions", res?.sessions, []);
}

// Not a database at all -> "unreadable db".
{
  const file = path.join(dir, "garbage.db");
  writeFileSync(file, "this is not sqlite ".repeat(100));
  let res, threw = false;
  try { res = await aggregate({ dbPath: file }); } catch { threw = true; }
  check("garbage: does not throw", !threw);
  eq("garbage: health.error", res?.health?.error, "unreadable db");
}

// classifyError: fixed vocabulary, never raw exception text (no paths/usernames).
{
  eq("classify busy", classifyError({ errcode: 5, message: "database is locked" }), "db locked");
  eq("classify locked", classifyError({ errcode: 6, message: "x" }), "db locked");
  eq("classify no table", classifyError({ message: "no such table: message" }), "schema mismatch");
  eq("classify no column", classifyError({ message: "no such column: data" }), "schema mismatch");
  eq("classify other", classifyError(new Error("unable to open /Users/bob/x.db")), "unreadable db");
}

// Source guard: exactly one SQL statement, and it is the allowed one.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "../parsers/opencode.mjs"), "utf8");
  const sql = src.match(/\b(SELECT|INSERT|UPDATE|DELETE|PRAGMA|ATTACH)\b[^"'`]*/g) ?? [];
  eq("only the allowed query", sql,
    ["SELECT id, session_id, time_created, data FROM message WHERE time_created >= ?"]);
  check("no account/credential reference", !/account|credential/i.test(src));
  check("opens read-only", /readOnly:\s*true/.test(src));
}

// F5: default dbPath honors $XDG_DATA_HOME/opencode/opencode.db first, then
// ~/.local/share/opencode/opencode.db (temp HOME / XDG dirs only).
{
  const { mkdirSync, copyFileSync } = await import("node:fs");
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  const src = makeDb("xdg-src.db", [assistant("x1", "ses_XDG", T, tok(1, 2, 0, 0, 0))]);
  const homeSrc = makeDb("home-src.db", [assistant("h1", "ses_HOME", T, tok(3, 4, 0, 0, 0))]);
  const home = path.join(dir, "home");
  const xdg = path.join(dir, "xdg");
  mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
  mkdirSync(path.join(xdg, "opencode"), { recursive: true });
  copyFileSync(homeSrc, path.join(home, ".local", "share", "opencode", "opencode.db"));
  process.env.HOME = home;
  try {
    delete process.env.XDG_DATA_HOME;
    eq("F5: no XDG → ~/.local/share", (await aggregate({ sinceDate: "2026-09-30" })).sessions.map((x) => x.sessionId), ["ses_HOME"]);
    process.env.XDG_DATA_HOME = xdg;
    eq("F5: XDG set but no db there → ~/.local/share", (await aggregate({ sinceDate: "2026-09-30" })).sessions.map((x) => x.sessionId), ["ses_HOME"]);
    copyFileSync(src, path.join(xdg, "opencode", "opencode.db"));
    eq("F5: XDG db preferred", (await aggregate({ sinceDate: "2026-09-30" })).sessions.map((x) => x.sessionId), ["ses_XDG"]);
    process.env.XDG_DATA_HOME = "relative/dir"; // non-absolute XDG is ignored (XDG spec)
    eq("F5: relative XDG ignored", (await aggregate({ sinceDate: "2026-09-30" })).sessions.map((x) => x.sessionId), ["ses_HOME"]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
