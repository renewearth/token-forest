import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectRecords, manifest } from "../../packages/uploader/src/reliable/sources.mjs";
import { bindOutboxOwner, stageRecords, readOutbox } from "../../packages/uploader/src/reliable/outbox.mjs";
import { sendReliable } from "../../packages/uploader/src/reliable/send.mjs";
const uri = "mongodb://127.0.0.1:27398/tf-v2-test-collection-preview", origin = "http://127.0.0.1:4812";
if (process.env.MONGODB_URI !== uri) throw Error("Disposable preview database required");
const db = (await mongoose.connect(uri)).connection.db;
await db.collection("members").updateOne({ email: "fixture-a@example.test" }, { $setOnInsert: { name: "Fixture A", identities: [], ingestToken: "synthetic-preview-only" } }, { upsert: true });
const suffix = randomUUID(), token = `synthetic-${suffix}`;
const memberId = new mongoose.Types.ObjectId();
await db.collection("members").insertOne({ _id: memberId, name: "HTTP Fixture", email: `${suffix}@example.test`, ingestToken: token, identities: [] });
const home = await mkdtemp(path.join(tmpdir(), "tf-http-sources-"));
const at = "2026-10-01T00:00:00.000Z";
const put = async (rel, lines) => { const dest = path.join(home, rel); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, lines.map((x) => JSON.stringify(x)).join("\n") + "\n"); };
try {
  await put(".claude/projects/a/session.jsonl", [{ type: "assistant", timestamp: at, sessionId: "a", requestId: "request-1", message: { id: "msg-1", model: "claude", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } }]);
  await put(".codex/sessions/rollout-2026-10-01-123e4567-e89b-12d3-a456-426614174000.jsonl", [{ type: "turn_context", payload: { model: "gpt" } }, { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } } } }]);
  await put(".gemini/tmp/a/chats/session-one.jsonl", [{ sessionId: "gem-session" }, { type: "gemini", id: "turn-1", timestamp: at, model: "gemini", tokens: { input: 30, cached: 10, output: 12, thoughts: 2 } }]);
  await put(".local/share/grok-usage.jsonl", [{ ts: Date.parse(at), id: "grok-1", model: "grok", prompt_tokens: 10, completion_tokens: 3 }]);
  const sqlitePath = path.join(home, ".local/share/opencode/opencode.db"); await mkdir(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  sqlite.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("oc-1", "oc-session", Date.parse(at), Date.parse(at), JSON.stringify({ role: "assistant", modelID: "oc", providerID: "copilot", time: { created: Date.parse(at), completed: Date.parse(at) }, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 2, write: 0 } } })); sqlite.close();
  const accounts = Object.fromEntries(["claude_code", "codex", "gemini", "grok", "opencode"].map((tool) => [tool, "synthetic-company"]));
  const collected = await collectRecords({ sourceRoot: home, accounts }); assert.equal(collected.records.length, 5);
  for (const device of ["mini", "book", "dev2"]) {
    process.env.TOKEN_FOREST_STATE_DIR = path.join(home, `state-${device}`);
    bindOutboxOwner({ serverUrl: origin, token }); stageRecords(collected.records);
    const options = { serverUrl: origin, token, device: { machineId: device, uploaderVersion: "http-fixture", buildHash: "test" }, health: collected.health };
    if (device === "mini") {
      let lost = false;
      await assert.rejects(() => sendReliable({ ...options, fetchImpl: async (url, init) => { const response = await fetch(url, init); if (init.method === "POST" && !lost) { lost = true; assert.equal(response.status, 200); await response.text(); throw Error("simulated response loss after server storage"); } return response; } }), /response loss/);
      assert.equal(readOutbox().entries.length, 5);
    }
    const sent = await sendReliable(options); assert.equal(sent.pending, 0);
    console.log(`PASS actual HTTP ${device}: 5 parsed records, exact acknowledgements, pending=0`);
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const status = await (await fetch(`${origin}/api/me/collection-status`, { headers })).json();
  assert.equal(status.recordCount, 5); assert.equal(status.deviceStatus.length, 3); assert(status.deviceStatus.every((d) => d.pending === 0)); assert.equal(status.staleChains, 0);
  const expected = manifest(collected.records, collected.health).records.map(({ key, digest }) => ({ key, digest }));
  const reconciled = await (await fetch(`${origin}/api/ingest/records/reconcile`, { method: "POST", headers, body: JSON.stringify({ expected }) })).json();
  assert.equal(reconciled.results.length, 5); assert(reconciled.results.every((r) => r.status === "matched"));
  assert.equal((await fetch(`${origin}/api/me/collection-status`)).status, 401);
  console.log("PASS actual HTTP: response loss retry, 3-device union=5, 5/5 digest reconciliation, own status, anonymous denied");
} finally {
  for (const name of ["usagerecords", "usagerecordchains", "usagerecordderived", "usagerecordconflicts", "usagerecorddevices", "usagerecorddevicesources"]) await db.collection(name).deleteMany({ memberId });
  await db.collection("members").deleteOne({ _id: memberId });
  await mongoose.disconnect(); await rm(home, { recursive: true, force: true }); delete process.env.TOKEN_FOREST_STATE_DIR;
}
