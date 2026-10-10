// Claude organization tagging (packages/uploader/src/lib/claude-account.mjs):
// transcript evidence, hook ledger, bucket merge, the --hook CLI path, the
// server schema and the server merge rule. No database, no network.
//   ./node_modules/.bin/tsx src/scripts/verify-claude-account.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountTag, mergeAccountTag } from "@/lib/sessions";
import { usageSessionRowSchema } from "@/lib/types";
import { aggregate as aggregateClaude } from "../../packages/uploader/src/parsers/claude-code.mjs";
import {
  loadHookLedger,
  parseHookInput,
  readLoginOrg,
  recordHookSession,
} from "../../packages/uploader/src/lib/claude-account.mjs";
import { isValidSessionRow } from "../../packages/uploader/src/lib/sessions.mjs";
import { renderInstaller } from "@/app/install.sh/template";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const TEAM = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";

let seq = 0;
const assistant = (sessionId: string, ts: string, id?: string) =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: ts,
    requestId: `req-${id ?? ++seq}`,
    message: { id: `msg-${id ?? seq}`, model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  });
const bridge = (sessionId: string, org?: string) =>
  JSON.stringify({ type: "bridge-session", sessionId, bridgeSessionId: "b", lastSequenceNum: 1, ...(org ? { ownerAccountUuid: "acct", ownerOrganizationUuid: org } : {}) });

// The .mjs parser has no type annotations; state the options this script uses.
const aggregate = aggregateClaude as (options?: { accountLedger?: Map<string, string> }) => Promise<unknown>;
const envOf = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

type Row = { sessionId: string; hour: string; requests: number | null; accountOrg?: string; accountEvidence?: string };

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "tf-account-"));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const projects = path.join(home, ".claude", "projects", "p");
  mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.TOKEN_FOREST_STATE_DIR = state;
  delete process.env.CLAUDE_CONFIG_DIR;

  // 03:00Z = 12:00 KST, 04:00Z = 13:00 KST.
  const write = (name: string, lines: string[]) => writeFileSync(path.join(projects, `${name}.jsonl`), lines.join("\n") + "\n");
  // A: usage before any bridge line (no transcript evidence), then team.
  write("A", [assistant("A", "2026-10-01T03:00:00Z"), bridge("A", TEAM), assistant("A", "2026-10-01T04:00:00Z"), bridge("A"), assistant("A", "2026-10-01T04:10:00Z")]);
  // B: organization switches inside one hour bucket.
  write("B", [bridge("B", TEAM), assistant("B", "2026-10-01T03:00:00Z"), bridge("B", PERSONAL), assistant("B", "2026-10-01T03:30:00Z")]);
  // C: no bridge lines at all; the hook ledger knows it.
  write("C", [assistant("C", "2026-10-01T03:00:00Z")]);
  // D: neither evidence.
  write("D", [assistant("D", "2026-10-01T03:00:00Z")]);
  // E resumed as F: F copies E's line. Only F has a ledger entry — the copied
  // line stays under E (smallest id) and must not inherit F's organization.
  write("E", [assistant("E", "2026-10-01T03:00:00Z", "shared")]);
  write("F", [assistant("F", "2026-10-01T03:00:00Z", "shared"), assistant("F", "2026-10-01T04:00:00Z")]);
  // G: the same message first seen without a bridge line, then in a fork that has one.
  write("G", [assistant("G", "2026-10-01T03:00:00Z", "forked")]);
  write("H", [bridge("H", TEAM), assistant("H", "2026-10-01T03:00:00Z", "forked")]);

  check("recordHookSession writes", recordHookSession("C", TEAM) === true);
  check("recordHookSession rejects an empty organization", recordHookSession("C", "") === false);
  check("recordHookSession rejects a missing session", recordHookSession("", TEAM) === false);
  recordHookSession("F", PERSONAL);
  recordHookSession("A", PERSONAL);
  recordHookSession("Z", TEAM);
  recordHookSession("Z", PERSONAL);
  const ledger = loadHookLedger();
  check("ledger keeps one organization per session", ledger.get("C") === TEAM && ledger.get("F") === PERSONAL);
  check("ledger marks two organizations as mixed", ledger.get("Z") === "mixed");
  check("ledger file is private", (readFileSync(path.join(state, "claude-accounts.jsonl"), "utf8").match(/\n/g) ?? []).length === 5);

  const { sessions } = (await aggregate({ accountLedger: ledger })) as { sessions: Row[] };
  const at = (sessionId: string, hour: string) => sessions.find((r) => r.sessionId === sessionId && r.hour === hour);
  const a12 = at("A", "2026-10-01T12");
  const a13 = at("A", "2026-10-01T13");
  check("usage before the first bridge line falls back to the hook ledger", a12?.accountOrg === PERSONAL && a12.accountEvidence === "hook", a12);
  check("usage after a bridge line takes its organization", a13?.accountOrg === TEAM && a13.accountEvidence === "transcript" && a13.requests === 2, a13);
  const b = at("B", "2026-10-01T12");
  check("two organizations in one bucket become mixed", b?.accountOrg === "mixed" && b.accountEvidence === "transcript", b);
  const c = at("C", "2026-10-01T12");
  check("a session without bridge lines uses the hook ledger", c?.accountOrg === TEAM && c.accountEvidence === "hook", c);
  const d = at("D", "2026-10-01T12");
  check("no evidence leaves the row untagged", d !== undefined && d.accountOrg === undefined && d.accountEvidence === undefined, d);
  const e = at("E", "2026-10-01T12");
  check("a copied line does not inherit the later session's organization", e !== undefined && e.accountOrg === undefined && e.requests === 1, e);
  const f13 = at("F", "2026-10-01T13");
  check("the later session's own usage is tagged", f13?.accountOrg === PERSONAL && f13.accountEvidence === "hook", f13);
  check("the copied line is not double counted", at("F", "2026-10-01T12") === undefined);
  const g = at("G", "2026-10-01T12");
  check("a fork with a bridge line supplies the organization", g?.accountOrg === TEAM && g.accountEvidence === "transcript" && g.requests === 1, g);
  check("every emitted row passes the uploader's own validation", sessions.every(isValidSessionRow));
  const plain = (await aggregate({})) as { sessions: Row[] };
  check("without a ledger only transcript evidence is used", plain.sessions.find((r) => r.sessionId === "C")?.accountOrg === undefined && plain.sessions.find((r) => r.sessionId === "A" && r.hour === "2026-10-01T13")?.accountOrg === TEAM);

  check("uploader validation rejects an organization without evidence", !isValidSessionRow({ ...sessions[0], accountOrg: TEAM, accountEvidence: undefined }));
  check("uploader validation rejects an email as organization", !isValidSessionRow({ ...sessions[0], accountOrg: "someone@example.test", accountEvidence: "hook" }));

  // Login lookup and the hook payload.
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: TEAM, emailAddress: "someone@example.test" } }));
  check("readLoginOrg reads the home login", readLoginOrg() === TEAM);
  const profile = path.join(root, "profile");
  mkdirSync(profile);
  writeFileSync(path.join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: PERSONAL } }));
  check("readLoginOrg follows CLAUDE_CONFIG_DIR", readLoginOrg(envOf({ CLAUDE_CONFIG_DIR: profile })) === PERSONAL);
  check("readLoginOrg tolerates a missing login", readLoginOrg(envOf({ CLAUDE_CONFIG_DIR: path.join(root, "none") })) === null);
  check("parseHookInput reads session and event", JSON.stringify(parseHookInput('{"session_id":"S","hook_event_name":"SessionStart"}')) === '{"sessionId":"S","event":"SessionStart"}');
  check("parseHookInput tolerates garbage", parseHookInput("not json") === null && parseHookInput("") === null && parseHookInput("{}") === null);

  // The real CLI as a SessionStart hook: records, sends nothing, needs no config.
  const cli = path.resolve("packages/uploader/src/cli.mjs");
  const hookState = path.join(root, "hook-state");
  const env = envOf({ PATH: process.env.PATH ?? "", HOME: home, TOKEN_FOREST_STATE_DIR: hookState, CLAUDE_CONFIG_DIR: profile, TOKEN_FOREST_HOOK_INPUT: '{"session_id":"hooked","hook_event_name":"SessionStart"}' });
  const out = execFileSync(process.execPath, [cli, "--hook"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const written = readFileSync(path.join(hookState, "claude-accounts.jsonl"), "utf8");
  check("the CLI hook records the session's organization", written.includes('"s":"hooked"') && written.includes(PERSONAL), written);
  check("the CLI hook records no email", !written.includes("@"));
  check("a SessionStart hook prints nothing", out === "", out);

  // Server schema and merge rule.
  const base = { tool: "claude_code", sessionId: "S", hour: "2026-10-01T12", parserVersion: 4 };
  check("server schema accepts a tagged row", usageSessionRowSchema.safeParse({ ...base, accountOrg: TEAM, accountEvidence: "hook" }).success);
  check("server schema rejects unknown evidence", !usageSessionRowSchema.safeParse({ ...base, accountOrg: TEAM, accountEvidence: "guess" }).success);
  check("server schema still accepts an untagged row", usageSessionRowSchema.safeParse(base).success);
  const hookTeam = accountTag({ accountOrg: TEAM, accountEvidence: "hook" });
  const hookPersonal = accountTag({ accountOrg: PERSONAL, accountEvidence: "hook" });
  const logTeam = accountTag({ accountOrg: TEAM, accountEvidence: "transcript" });
  check("an organization without evidence is not a tag", accountTag({ accountOrg: TEAM }) === null && accountTag({ accountOrg: "", accountEvidence: "hook" }) === null);
  check("unknown merges to the known side", mergeAccountTag(null, hookTeam) === hookTeam && mergeAccountTag(hookTeam, null) === hookTeam);
  check("transcript beats hook in either order", mergeAccountTag(hookPersonal, logTeam) === logTeam && mergeAccountTag(logTeam, hookPersonal) === logTeam);
  check("same strength, different organization is mixed", mergeAccountTag(hookTeam, hookPersonal)?.accountOrg === "mixed");
  check("same tag is unchanged", mergeAccountTag(hookTeam, accountTag({ accountOrg: TEAM, accountEvidence: "hook" }))?.accountOrg === TEAM);

  // Installer: both hooks call run.sh --hook and the wrapper keeps stdin.
  const script = renderInstaller("https://ingest.example.test", "https://app.example.test", "");
  check("installer registers both session hooks", script.includes('["SessionStart", "SessionEnd"]') && script.includes(`"' --hook"`));
  check("installer wrapper hands the hook payload to the CLI", script.includes('TOKEN_FOREST_HOOK_INPUT="\\$(cat)"'));

  // Run the generated wrapper for real: a hook call must return at once, keep
  // the payload from stdin and let the CLI record it in the background.
  const runner = path.join(root, "run.sh");
  const runnerBlock = script.slice(script.indexOf('cat > "$RUNNER" <<RUNNER_EOF'), script.indexOf('chmod +x "$RUNNER"'));
  execFileSync("bash", ["-c", runnerBlock], { env: envOf({ PATH: process.env.PATH ?? "", RUNNER: runner, NODE_BIN: process.execPath, CLI: cli }) });
  const wrapState = path.join(root, "wrap-state");
  const wrapOut = execFileSync("sh", [runner, "--hook"], {
    input: '{"session_id":"wrapped","hook_event_name":"SessionStart"}',
    env: envOf({ PATH: process.env.PATH ?? "", HOME: home, TOKEN_FOREST_STATE_DIR: wrapState, CLAUDE_CONFIG_DIR: profile }),
    encoding: "utf8",
  });
  let wrapped = "";
  for (let i = 0; i < 50 && !wrapped.includes("wrapped"); i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      wrapped = readFileSync(path.join(wrapState, "claude-accounts.jsonl"), "utf8");
    } catch {
      // not written yet
    }
  }
  check("the wrapper passes the stdin payload to the background CLI", wrapped.includes('"s":"wrapped"') && wrapped.includes(PERSONAL), wrapped);
  check("the wrapper prints nothing in hook mode", wrapOut === "", wrapOut);

  // Run the generated settings merge for real against an older install.
  const mergeStart = script.lastIndexOf('const fs = require("fs");', script.indexOf("const file = process.env.TM_FILE;"));
  const mergeJs = path.join(root, "merge.cjs");
  writeFileSync(mergeJs, script.slice(mergeStart, script.indexOf("\nNODE_EOF", mergeStart)));
  const settings = path.join(root, "settings.json");
  const oldCommand = `'${runner}' >/dev/null 2>&1 &`.replace("run.sh", ".token-forest/run.sh");
  const tfRunner = runner.replace("run.sh", ".token-forest/run.sh");
  writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30, hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo other" }] }, { hooks: [{ type: "command", command: oldCommand }] }] } }));
  const merge = () => execFileSync(process.execPath, [mergeJs], { env: envOf({ TM_FILE: settings, TM_RUNNER: tfRunner }), encoding: "utf8" });
  const first = merge();
  const after = JSON.parse(readFileSync(settings, "utf8"));
  const commands = (event: string) => (after.hooks[event] as { hooks: { command: string }[] }[]).flatMap((g) => g.hooks.map((h) => h.command));
  check("settings merge rewrites the older hook command", first.includes("hook-added") && commands("SessionEnd").includes(`'${tfRunner}' --hook`) && !commands("SessionEnd").includes(oldCommand), after);
  check("settings merge keeps unrelated hooks and settings", commands("SessionEnd").includes("echo other") && after.cleanupPeriodDays === 30, after);
  check("settings merge adds the session start hook once", commands("SessionStart").length === 1 && commands("SessionStart")[0] === `'${tfRunner}' --hook`, after);
  const before = readFileSync(settings, "utf8");
  check("settings merge is idempotent", merge().includes("hook-exists") && readFileSync(settings, "utf8") === before);

  rmSync(root, { recursive: true, force: true });
  console.log(`PASS=${pass} FAIL=${fail}`);
  if (fail === 0) console.log("ALL PASS");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
