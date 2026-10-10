// Which Claude organization a Claude Code session ran under.
//
// A member can use a company (Team) organization and a personal plan on the
// same machine, and only the company organization shows up in the company's
// spend report. To tell the two apart the uploader tags session rows with the
// ORGANIZATION id (never the email) from exactly two kinds of evidence:
//
//   "transcript" — Remote Control sessions write `bridge-session` lines that
//                  carry ownerOrganizationUuid. Positional: a usage line takes
//                  the organization of the latest bridge-session line before
//                  it in the same file.
//   "hook"       — the SessionStart/SessionEnd hook runs on the machine the
//                  session ran on and appends { session, organization } to
//                    $STATE_DIR/claude-accounts.jsonl
//                  from that moment's login (.claude.json oauthAccount).
//
// There is deliberately no "whoever is logged in when the upload runs" guess:
// transcripts replicated from another machine, or an account switched since,
// would be tagged wrong. No evidence = no tag.
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { statePath, writeStateFile } from "./state-dir.mjs";

const FILE = "claude-accounts.jsonl";
// A session seen under two organizations by same-rank evidence.
export const MIXED_ORG = "mixed";
// Compact once the ledger passes this size, keeping the newest lines.
const MAX_LEDGER_BYTES = 1_000_000;
const KEEP_LINES = 5_000;

// Organization ids are UUIDs today; accept any short id-like token so a format
// change degrades to "still tagged" rather than "silently dropped".
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;
export function cleanOrg(value) {
  return typeof value === "string" && ORG_RE.test(value) && value !== MIXED_ORG ? value : null;
}

// The organization of the login in a Claude config dir. Claude Code keeps the
// login in `.claude.json` — inside CLAUDE_CONFIG_DIR when that is set, else in
// the home directory.
export function readLoginOrg(env = process.env) {
  const dir = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  const file = dir ? path.join(dir, ".claude.json") : path.join(homedir(), ".claude.json");
  try {
    return cleanOrg(JSON.parse(readFileSync(file, "utf8"))?.oauthAccount?.organizationUuid);
  } catch {
    return null;
  }
}

// Append one hook observation. Returns true when a line was written.
export function recordHookSession(sessionId, org, now = new Date()) {
  const o = cleanOrg(org);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200 || !o) return false;
  const file = statePath(FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ s: sessionId, o, t: now.toISOString() }) + "\n", { mode: 0o600 });
  compactLedger(file);
  return true;
}

function compactLedger(file) {
  try {
    if (statSync(file).size <= MAX_LEDGER_BYTES) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeStateFile(FILE, lines.slice(-KEEP_LINES).join("\n") + "\n");
  } catch {
    // Compaction is best-effort; an oversized ledger still reads fine.
  }
}

// → Map<sessionId, organization | MIXED_ORG>. Missing/corrupt lines are skipped.
export function loadHookLedger() {
  const map = new Map();
  let text;
  try {
    text = readFileSync(statePath(FILE), "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const o = cleanOrg(entry?.o);
    if (typeof entry?.s !== "string" || !entry.s || !o) continue;
    const prior = map.get(entry.s);
    map.set(entry.s, prior === undefined || prior === o ? o : MIXED_ORG);
  }
  return map;
}

// Parse the hook payload Claude Code passes on stdin (the run wrapper hands it
// over in TOKEN_FOREST_HOOK_INPUT). → { sessionId, event } or null.
export function parseHookInput(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const json = JSON.parse(raw);
    const sessionId = typeof json?.session_id === "string" ? json.session_id : "";
    if (!sessionId) return null;
    return { sessionId, event: typeof json.hook_event_name === "string" ? json.hook_event_name : "" };
  } catch {
    return null;
  }
}

const RANK = { hook: 1, transcript: 2 };
// Fold one event's { accountOrg, accountEvidence } into a row. Stronger
// evidence replaces weaker; two organizations at the same rank become MIXED.
export function mergeAccount(row, org, evidence) {
  const rank = RANK[evidence];
  if (!rank || (org !== MIXED_ORG && !cleanOrg(org))) return;
  const current = RANK[row.accountEvidence] ?? 0;
  if (rank > current) {
    row.accountOrg = org;
    row.accountEvidence = evidence;
  } else if (rank === current && row.accountOrg !== org) {
    row.accountOrg = MIXED_ORG;
  }
}
