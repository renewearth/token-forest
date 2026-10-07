import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Use only the explicitly started local synthetic preview. No token or cookie
// is read or printed; its trusted test proxy identity is supplied by the runner.
const origin = process.env.TOKEN_FOREST_TEST_HTTP_ORIGIN;
const email = process.env.TOKEN_FOREST_TEST_MEMBER_EMAIL;
if (!origin || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin) || !email?.endsWith("@example.test")) throw Error("Set a local synthetic preview origin and an @example.test member identity.");
const id = randomUUID();
const headers = { "tailscale-user-login": email };
const page = await fetch(`${origin}/knowhow/experiments/new`, { headers });
assert.equal(page.status, 200);
await page.text();
const manifest = JSON.parse(readFileSync(".next/dev/server/server-reference-manifest.json", "utf8"));
const actions = Object.fromEntries(Object.entries(manifest.node).map(([key, value]) => [value.exportedName, key]));
async function call(name, args) {
  assert.ok(actions[name], `Missing compiled action ${name}`);
  const response = await fetch(`${origin}/knowhow/experiments/${id}`, { method: "POST", headers: { ...headers, "next-action": actions[name], "content-type": "text/plain;charset=UTF-8", origin }, body: JSON.stringify(args) });
  assert.equal(response.status, 200, `${name}: HTTP status`);
  const line = (await response.text()).split("\n").find((value) => /^\d+:\{"ok":/.test(value));
  assert.ok(line, `${name}: action response missing`);
  const result = JSON.parse(line.slice(line.indexOf(":") + 1));
  assert.equal(result.ok, true, `${name}: ${result.code ?? "unexpected failure"}`);
  return result.value;
}
const input = { title: "합성 HTTP 저장 회귀", problem: "문제", method: "방법", result: "stopped", limitations: "한계", tags: [], tools: [], links: [], measurement: null };
let created = false;
try {
  const first = await call("createExperimentAction", [id, input]); created = true;
  assert.equal(first.contentVersion, 1);
  console.log("PASS HTTP authenticated create draft");
  const second = await call("saveExperimentAction", [id, 1, { ...input, method: "수정한 방법" }, randomUUID()]);
  assert.equal(second.contentVersion, 2);
  console.log("PASS HTTP authenticated save version 1 → 2");
  const loaded = await call("reloadExperimentAction", [id]);
  assert.equal(loaded.input.method, "수정한 방법");
  console.log("PASS HTTP reload persists saved content");
} finally {
  if (created) { await call("deleteExperimentAction", [id, randomUUID()]); console.log("PASS HTTP fixture deleted"); }
}
