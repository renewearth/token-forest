// Synthetic-only protocol 3 verification. Run on dev2 with Node >=22.5.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { collectRecords, manifest } from "../reliable/sources.mjs";
import { recordKey, recordDigest } from "../reliable/records.mjs";
import { acquireReliableLock, bindOutboxOwner, stageRecords, readOutbox, acknowledgeExact } from "../reliable/outbox.mjs";
import { sendReliable } from "../reliable/send.mjs";
import { runReliable } from "../reliable/cli.mjs";

const root = mkdtempSync(path.join(tmpdir(), "tf-reliable-test-"));
const home = path.join(root, "home");
process.env.TOKEN_FOREST_STATE_DIR = path.join(root, "state");
const put = (rel, content) => { const file = path.join(home, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); return file; };
const lines = (...xs) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
const at = "2026-10-07T00:01:00.000Z";

const claudeRow = { type: "assistant", timestamp: at, sessionId: "session-a", requestId: "req-1",
  message: { id: "msg-1", model: "claude", usage: { input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } } };
put(".claude/projects/a/one.jsonl", lines(claudeRow, { ...claudeRow, sessionId: "session-b" }));
const codexFile = "rollout-2026-10-07-123e4567-e89b-12d3-a456-426614174000.jsonl";
const codexOne = { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage:
  { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40 } } } };
const codexTwo = { type: "event_msg", timestamp: "2026-10-07T00:02:00.000Z", payload: { type: "token_count", info: { total_token_usage:
  { input_tokens: 130, cached_input_tokens: 25, output_tokens: 50 } } } };
put(`.codex/sessions/2026/10/07/${codexFile}`, lines(
  { type: "turn_context", payload: { model: "gpt" } }, codexOne, codexTwo));
put(`.codex/archived_sessions/${codexFile}`, lines(
  { type: "turn_context", payload: { model: "gpt" } }, codexTwo));
put(".gemini/tmp/project/chats/session-one.jsonl", lines(
  { sessionId: "gem-session" },
  { type: "gemini", id: "turn-1", timestamp: at, model: "gemini", tokens: { input: 30, cached: 10, output: 12, thoughts: 2 } },
));
put(".local/share/grok-usage.jsonl", lines(
  { ts: 1791331260, model: "grok", prompt_tokens: 9, completion_tokens: 4 },
  { ts: 1791331261, id: "native-request", model: "grok", prompt_tokens: 2, completion_tokens: 1 },
));
const dbFile = path.join(home, ".local/share/opencode/opencode.db");
mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("oc-msg", "oc-session", Date.parse(at), Date.parse(at) + 1000,
  JSON.stringify({ role: "assistant", content: "NEVER_EXPORT_RAW_CONTENT", modelID: "model-a", providerID: "provider-a", time: { created: Date.parse(at), completed: Date.parse(at) + 1000 },
    tokens: { input: 7, output: 2, reasoning: 1, cache: { read: 3, write: 4 } } }));
db.close();

const accounts = Object.fromEntries(["claude_code", "codex", "gemini", "grok", "opencode"].map((tool) => [tool, "account-one"]));
const first = await collectRecords({ sourceRoot: home, accounts });
assert(!JSON.stringify(first).includes("NEVER_EXPORT_RAW_CONTENT"));
assert.equal(first.records.length, 7);
assert.equal(first.records.filter((r) => r.tool === "claude_code").length, 1);
assert.equal(first.records.find((r) => r.tool === "claude_code").requests, 1);
assert.equal(first.records.find((r) => r.tool === "claude_code").identityQuality, "native");
const codex = first.records.filter((r) => r.tool === "codex");
assert.deepEqual(codex.map((r) => r.inputTokens), [100, 130]);
assert.deepEqual(codex.map((r) => r.cacheReadTokens), [20, 25]);
assert(codex.every((r) => r.kind === "cumulative" && r.requests === null));
assert.equal(first.health.find((h) => h.parser === "codex").locationsPresent, 2);
const partialHome = path.join(root, "partial-home");
const partialCodex = path.join(partialHome, ".codex", "sessions", codexFile);
mkdirSync(path.dirname(partialCodex), { recursive: true });
writeFileSync(partialCodex, lines({ type: "turn_context", payload: { model: "gpt" } }, codexTwo));
const partial = await collectRecords({ sourceRoot: partialHome, accounts });
const onlyCodex = partial.records.find((r) => r.tool === "codex");
assert.equal(recordKey(onlyCodex), recordKey(codex[1]));
assert.equal(recordDigest(onlyCodex), recordDigest(codex[1]));
const extraHome = path.join(root, "extra-home");
const extraDir = path.join(root, "explicit-codex-rollouts");
mkdirSync(extraHome, { recursive: true });
mkdirSync(extraDir, { recursive: true });
writeFileSync(path.join(extraDir, codexFile), lines({ type: "turn_context", payload: { model: "gpt" } }, codexTwo));
const extra = await collectRecords({ sourceRoot: extraHome, codexDirs: [extraDir], accounts });
assert.equal(extra.records.filter((r) => r.tool === "codex").length, 1);
assert.equal(extra.health.find((h) => h.parser === "codex").locationsChecked, 3);
assert.equal(extra.health.find((h) => h.parser === "codex").locationsPresent, 1);
assert.equal(first.records.find((r) => r.tool === "gemini").requests, null);
assert.equal(first.records.find((r) => r.tool === "grok" && r.identityQuality === "unverified").requests, null);
assert.equal(first.records.find((r) => r.tool === "opencode").outputTokens, 3);
assert.equal(first.records.find((r) => r.tool === "opencode").revision, Date.parse(at) + 1000);

const streamHome = path.join(root, "stream-home");
const partialFile = path.join(streamHome, ".claude", "projects", "s", "partial.jsonl");
const finalFile = path.join(streamHome, ".claude", "projects", "s", "final.jsonl");
mkdirSync(path.dirname(partialFile), { recursive: true });
writeFileSync(partialFile, lines({ ...claudeRow, sessionId: "session-a" }));
writeFileSync(finalFile, lines({ ...claudeRow, sessionId: "session-b",
  timestamp: "2026-10-07T00:01:01.000Z", message: { ...claudeRow.message,
    stop_reason: "end_turn", usage: { ...claudeRow.message.usage, output_tokens: 8 } } }));
const stream = await collectRecords({ sourceRoot: streamHome, accounts });
assert.equal(stream.records.length, 2);
assert.equal(new Set(stream.records.map(recordKey)).size, 1);
assert.equal(new Set(stream.records.map((r) => r.sessionId)).size, 1);
assert.deepEqual(stream.records.map((r) => r.completeness), ["partial", "final"]);
assert(stream.records.every((r) => r.identityQuality === "native"));
assert(stream.records[1].revision > stream.records[0].revision);
assert.equal(stream.records.filter((r) => r.completeness === "final").length, 1);
assert.equal(stream.records[1].outputTokens, 8);
const noAccount = await collectRecords({ sourceRoot: streamHome });
assert(noAccount.records.every((r) => r.identityQuality === "unverified"));

const second = await collectRecords({ sourceRoot: home, accounts });
assert.deepEqual(manifest(first.records, first.health).records.map((r) => [r.key, r.digest]),
  manifest(second.records, second.health).records.map((r) => [r.key, r.digest]));
const one = first.records[0];
assert.equal(recordDigest({ ...one, extra: "ignored", model: one.model }), recordDigest(one));
assert.equal(recordKey({ ...one, machineId: "other" }), recordKey(one));

// Manifest must leave state absent even when configured credentials could be
// read by the upload path. Capture JSON output without touching real sources.
let output = "";
const originalLog = console.log;
console.log = (s) => { output += s; };
try { await runReliable(["--reliable-manifest", "--source-root", home, "--account", "claude_code=account-one"]); }
finally { console.log = originalLog; }
assert.equal(JSON.parse(output).protocolVersion, 3);
assert.equal(existsSync(process.env.TOKEN_FOREST_STATE_DIR), false);

const lock1 = await acquireReliableLock();
assert.equal(lock1.acquired, true);
const lock2 = await acquireReliableLock();
assert.equal(lock2.acquired, false);
assert.equal(lock2.reason, "already_running");
await lock1.release();
const lock3 = await acquireReliableLock();
assert.equal(lock3.acquired, true);
await lock3.release();
const lockFile = path.join(process.env.TOKEN_FOREST_STATE_DIR, "reliable.lock");
writeFileSync(lockFile, JSON.stringify({ pid: 99999999, nonce: "stale" }));
const stale = await acquireReliableLock();
assert.equal(stale.acquired, true);
assert.equal((await acquireReliableLock()).acquired, false);
await stale.release();

// Two independent processes race for one kernel lock. Exactly one may hold it.
const moduleUrl = pathToFileURL(fileURLToPath(new URL("../reliable/outbox.mjs", import.meta.url))).href;
const childCode = `import {acquireReliableLock} from ${JSON.stringify(moduleUrl)};` +
  `const l=await acquireReliableLock(); console.log(l.acquired?'acquired':'blocked');` +
  `if(l.acquired){await new Promise(r=>setTimeout(r,1000));await l.release();}`;
const contender = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode],
    { env: { ...process.env, TOKEN_FOREST_STATE_DIR: process.env.TOKEN_FOREST_STATE_DIR } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`lock contender exited ${code}`)));
});
const winners = await Promise.all([contender(), contender()]);
assert.equal(winners.filter((x) => x === "acquired").length, 1);

// SIGKILL the Node holder. Its Python helper sees pipe EOF and exits, so the
// next process acquires without deleting a stale file or recovery directory.
const holderCode = `import {acquireReliableLock} from ${JSON.stringify(moduleUrl)};` +
  `const l=await acquireReliableLock(); console.log(l.acquired?'acquired':'blocked');` +
  `setInterval(()=>{},1000);`;
const holder = spawn(process.execPath, ["--input-type=module", "-e", holderCode],
  { env: { ...process.env, TOKEN_FOREST_STATE_DIR: process.env.TOKEN_FOREST_STATE_DIR } });
const holderReply = await new Promise((resolve, reject) => {
  let output = "";
  holder.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("\n")) resolve(output.trim());
  });
  holder.once("error", reject);
  holder.once("close", (code) => reject(new Error(`holder exited before kill: ${code}`)));
});
assert.equal(holderReply, "acquired");
holder.kill("SIGKILL");
await new Promise((resolve) => holder.once("close", resolve));
let afterKill;
for (let i = 0; i < 50; i++) {
  afterKill = await acquireReliableLock();
  if (afterKill.acquired) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.equal(afterKill.acquired, true);
await afterKill.release();
assert.equal(existsSync(`${lockFile}.recover`), false);

bindOutboxOwner({ serverUrl: "https://example.invalid", token: "synthetic" });
assert.throws(() => bindOutboxOwner({ serverUrl: "https://example.invalid", token: "other-member" }), /owner review/);
assert.throws(() => bindOutboxOwner({ serverUrl: "https://different.invalid", token: "synthetic" }), /owner review/);
const staged = stageRecords(first.records);
assert.equal(staged.pending, 7);
assert.throws(() => bindOutboxOwner({ serverUrl: "https://example.invalid", token: "other-member" }), /owner review/);
const older = first.records[0];
const newer = { ...older, revision: older.revision + 1, outputTokens: older.outputTokens + 1 };
stageRecords([newer]);
const exact = acknowledgeExact([{ key: recordKey(older), digest: recordDigest(older), status: "stored" }]);
assert.equal(exact.removed, 1);
assert(readOutbox().entries.some((e) => e.digest === recordDigest(newer)));
assert.equal(acknowledgeExact([{ key: recordKey(newer), digest: recordDigest(newer), status: "conflict" }]).removed, 0);
assert(readOutbox().entries.some((e) => e.digest === recordDigest(newer)));
assert.equal(acknowledgeExact([{ key: recordKey(newer), digest: "0".repeat(64), status: "stored" }]).removed, 0);
assert(readOutbox().entries.some((e) => e.digest === recordDigest(newer)));

const calls = [];
const fakeFetch = async (url, request) => {
  calls.push({ url, request });
  if (request.method === "GET") return { ok: true, status: 200, json: async () => ({ protocolVersion: 3 }) };
  const body = JSON.parse(request.body);
  assert.equal(body.protocolVersion, 3);
  assert(body.records.length <= 1000);
  assert.equal(body.health.sources.length, 5);
  return { ok: true, status: 200, json: async () => ({ protocolVersion: 3, acknowledgements:
    body.records.map((r) => ({ key: recordKey(r), digest: recordDigest(r), status: "unchanged" })) }) };
};
const sent = await sendReliable({ serverUrl: "https://example.invalid", token: "synthetic", device:
  { machineId: "fixed-uuid", uploaderVersion: "test" }, health: first.health, fetchImpl: fakeFetch });
assert.equal(sent.pending, 0);
assert(calls.every((c) => c.url.endsWith("/api/ingest/records")));
assert.equal(calls.filter((c) => c.request.method === "POST").length, 2);
assert.equal(JSON.parse(calls.at(-1).request.body).health.pending, 0);
assert.equal(JSON.parse(calls.at(-1).request.body).health.status, "partial");
assert.equal(readOutbox().entries.length, 0);
assert.equal(stageRecords(first.records).added, 0);
assert.equal(readOutbox().entries.length, 0);
console.log("verify-reliable: PASS synthetic sources, manifest, stable key/digest, exact ACK, protocol3-only send");
