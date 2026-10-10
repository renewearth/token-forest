#!/usr/bin/env node
// token-forest-upload — push local AI-tool token usage to a token-forest server.
//
// Scans each tool's local logs (Claude Code, Codex, Gemini, Grok, opencode), turns them
// into session-grained rows (collection v2) and POSTs them to
// {serverUrl}/api/ingest. Idempotent: the server max-merges session rows per
// (tool, sessionId, hour, model), so re-sending an overlap never inflates
// totals. The scan window comes from a change cursor (lib/cursor.mjs): all
// local logs on the first run and at least weekly, otherwise from one KST day
// before the last successful upload. Old servers get the v1 daily rows.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, resolveConfig, configPath } from "./config.mjs";
import * as claudeCode from "./parsers/claude-code.mjs";
import * as claudeLimits from "./parsers/claude-limits.mjs";
import * as codex from "./parsers/codex.mjs";
import * as gemini from "./parsers/gemini.mjs";
import * as grok from "./parsers/grok.mjs";
import * as opencode from "./parsers/opencode.mjs";
import { sendV2, sendLimits } from "./send.mjs";
import { buildAndSendDigest } from "./digest.mjs";
import { readCursor, writeCursor, decideWindow, applySinceFloor } from "./lib/cursor.mjs";
import { acquireRunLock } from "./lib/run-lock.mjs";
import { loadAttribution, saveAttribution } from "./lib/claude-attr.mjs";
import { stateDir } from "./lib/state-dir.mjs";
import { dropInvalidSessions } from "./lib/sessions.mjs";
import { loadHookLedger, parseHookInput, readLoginOrg, recordHookSession } from "./lib/claude-account.mjs";

// Usage parsers, in upload order. Each exports `tool` and
// `aggregate({ sinceDate, machineId, attribution })` →
// { rows, hourlyRows, sessions, health, stats }. Adding a tool = one line here.
// (`attribution` is the sticky Claude index; other parsers ignore it. opencode
// reads its local SQLite DB, never cross-device replicated, so it needs none.)
const PARSERS = [claudeCode, codex, gemini, grok, opencode];

// Sent as device.uploaderVersion so the server can tell uploader generations
// apart. The tarball ships package.json next to src/.
function uploaderVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const HELP = `token-forest-upload — upload local AI tool usage (Claude Code, Codex, Gemini, Grok, OpenCode) to token-forest

Usage:
  token-forest-upload [options]

Options:
  --server <url>     token-forest server base URL (e.g. https://meter.example.com)
  --token <token>    per-member ingest token (get it from your token-forest admin)
  --since <date>     only scan usage on/after this KST date (YYYY-MM-DD). Ignores
                     (and keeps) the change cursor. Default: the cursor decides —
                     everything on the first run and at least weekly, otherwise
                     from the day before the last successful upload.
  --full             send every local log now (a full resend; stamps the cursor)
  --device-label <name>
                     your own name for this machine (max 32 chars, e.g. "맥북"),
                     shown only on your /me. config.json "deviceLabel" works too.
                     Never filled in automatically.
  --machine-id <id>  override this machine's pseudonymous id (default: a random
                     device id persisted in the state dir).
  --claude-dir <dir> 추가 Claude config 디렉터리(여러 번 지정 가능). 여러
                     계정을 CLAUDE_CONFIG_DIR 프로필로 쓸 때 각 계정의 한도를
                     함께 추적합니다. env: TOKEN_FOREST_CLAUDE_DIRS(쉼표/콜론 구분)
  --limits-only      사용량 스캔 없이 한도 스냅샷만 빠르게 갱신
  --no-limits        skip the Claude/Codex plan rate-limit snapshot (see below)
  --no-digest        skip the daily digest draft (see README); config.json의
                     "digest": false 로도 끌 수 있습니다
  --hook             run as a Claude Code hook: record which Claude organization
                     the session is logged in to (organization id only, never
                     the email), then upload — a SessionStart call only records
  --dry-run          print per-tool session counts, token sums and parser
                     health; send nothing, leave the cursor alone
  -h, --help         show this help

By default the run also snapshots your Claude plan's rate-limit windows (5-hour,
7-day, ...) via an unofficial usage API, plus the Codex windows recorded in your
newest local Codex session logs, and uploads them as account-level limits rows.
Any failure there only warns; it never fails the upload.

Configuration (highest precedence first):
  1. CLI flags:  --server, --token, --machine-id, --device-label
  2. Env vars:   TOKEN_FOREST_URL, TOKEN_FOREST_TOKEN, TOKEN_FOREST_MACHINE_ID
  3. Config file: ~/.config/token-forest/config.json
                  { "serverUrl": "...", "token": "...", "deviceLabel": "..." }

State (device-id, cursor.json, claude-attr.json, claude-accounts.jsonl) lives in
~/.token-forest;
TOKEN_FOREST_STATE_DIR overrides the folder.

Examples:
  token-forest-upload --dry-run
  token-forest-upload --server https://meter.example.com --token tmk_xxx
  token-forest-upload --since 2026-07-01
`;

const V1_FALLBACK_DAYS = 30;

// KST date (YYYY-MM-DD) n days before `now`.
function kstDaysAgo(now, n) {
  return new Date(now.getTime() + 9 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);
}

function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

// --dry-run summary: per tool, distinct sessions, session rows and token sums,
// then each parser's health reading.
function printSessionSummary(sessions, health, { mode, sinceDate, machineId, deviceLabel }) {
  console.log(`machineId: ${machineId || "(none)"}  label: ${deviceLabel ?? "(none)"}`);
  console.log(`window: ${mode}${sinceDate ? ` since ${sinceDate} (KST)` : " (all local logs)"}`);
  const byTool = new Map();
  for (const s of sessions) {
    let t = byTool.get(s.tool);
    if (!t) {
      t = { ids: new Set(), rows: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reqs: 0 };
      byTool.set(s.tool, t);
    }
    t.ids.add(s.sessionId);
    t.rows++;
    t.input += s.inputTokens;
    t.output += s.outputTokens;
    t.cacheRead += s.cacheReadTokens;
    t.cacheCreate += s.cacheCreationTokens;
    t.reqs += s.requests;
  }
  if (byTool.size === 0) console.log("(no usage found for the selected window — a heartbeat would be sent)");
  const width = Math.max(4, ...[...byTool.keys()].map((k) => k.length));
  for (const [tool, t] of byTool) {
    console.log(
      `  ${tool.padEnd(width)}  ${fmtInt(t.ids.size)} session(s), ${fmtInt(t.rows)} row(s)  ` +
        `input ${fmtInt(t.input)}  output ${fmtInt(t.output)}  cacheRead ${fmtInt(t.cacheRead)}  ` +
        `cacheCreate ${fmtInt(t.cacheCreate)}  reqs ${fmtInt(t.reqs)}`,
    );
  }
  // Claude organization tags (lib/claude-account.mjs): how many request counts
  // carry which evidence. Organization ids are shortened; no email is involved.
  const tags = new Map();
  for (const s of sessions) {
    if (s.tool !== "claude_code") continue;
    const key = s.accountOrg ? `${s.accountEvidence} ${s.accountOrg.slice(0, 8)}` : "untagged";
    tags.set(key, (tags.get(key) ?? 0) + (s.requests ?? 0));
  }
  if (tags.size > 0) {
    console.log("claude_code organization tags (requests):");
    for (const [key, reqs] of [...tags].sort((x, y) => y[1] - x[1])) console.log(`  ${key.padEnd(22)}  ${fmtInt(reqs)}`);
  }
  console.log("parser health:");
  for (const h of health) {
    const err = h.error ? `  error=${h.error}` : "";
    console.log(
      `  ${h.parser.padEnd(width)}  filesScanned=${h.filesScanned} linesUnrecognized=${h.linesUnrecognized} ` +
        `sessionsEmitted=${h.sessionsEmitted}${err}`,
    );
  }
}

// Collect every plan rate-limit snapshot this machine can see: Claude (per
// config dir, via the unofficial usage API) and Codex (the newest rate_limits
// in local rollouts). Each source fails independently and only warns.
async function collectLimitSnapshots(config) {
  const snapshots = [];
  try {
    const { snapshots: claude, warnings } = await claudeLimits.snapshotAll({
      configDirs: config.claudeDirs,
    });
    for (const w of warnings) console.error(`warn: limits(${w})`);
    snapshots.push(...claude);
  } catch (err) {
    console.error(`warn: skipped Claude plan limits snapshot (${err.message}).`);
  }
  try {
    // organization "device:<sha1 tag of the pseudonymous device id>" keeps
    // this device's Codex plan apart from the member's other devices (R23).
    snapshots.push(...(await codex.snapshotLimits({ machineId: config.machineId })));
  } catch (err) {
    console.error(`warn: skipped Codex limits snapshot (${err.code ?? "read error"}).`);
  }
  return snapshots;
}

// Snapshot plan rate-limit windows (Claude + Codex) and either print them
// (dry-run) or upload them to /api/limits. Any failure — missing credential,
// changed/404 endpoint, network error — is downgraded to a warn line so it
// never fails the run.
async function runLimits(config, { dryRun }) {
  try {
    const snapshots = await collectLimitSnapshots(config);
    if (dryRun) {
      const accounts = [...new Set(snapshots.map((s) => s.accountEmail))].join(", ");
      console.log(
        `\nPlan limits for ${accounts || "(unknown account)"} (${snapshots.length} window(s), sending nothing):`,
      );
      for (const s of snapshots) {
        const resetsAt = s.resetsAt ? `  resets ${s.resetsAt}` : "";
        console.log(
          `  ${s.window.padEnd(22)} ${String(s.utilizationPct).padStart(3)}%${resetsAt}`,
        );
      }
      return;
    }
    if (snapshots.length === 0) {
      console.error("No plan limits snapshot to upload.");
      return;
    }
    if (!config.serverUrl || !config.token) {
      console.error("warn: skipped plan limits snapshot (no server URL/token).");
      return;
    }
    console.error(`Uploading ${snapshots.length} limits snapshot(s) ...`);
    const { upserted } = await sendLimits({
      serverUrl: config.serverUrl,
      token: config.token,
      snapshots,
    });
    console.log(
      `Done. Uploaded ${snapshots.length} limits snapshot(s); server upserted ${upserted}.`,
    );
  } catch (err) {
    console.error(`warn: skipped plan limits snapshot (${err.message}).`);
  }
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error(HELP);
    process.exit(2);
  }

  if (flags.help) {
    console.log(HELP);
    return;
  }

  // Called from a Claude Code hook: note which organization this session is
  // logged in to (lib/claude-account.mjs). A SessionStart call only records —
  // the upload itself runs at session end and on the hourly schedule.
  if (flags.hook) {
    const hook = parseHookInput(process.env.TOKEN_FOREST_HOOK_INPUT);
    if (hook) {
      try {
        recordHookSession(hook.sessionId, readLoginOrg());
      } catch {
        // Tagging is best-effort; never block the upload on it.
      }
      if (hook.event === "SessionStart") return;
    }
  }

  let config;
  try {
    config = await resolveConfig(flags);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }

  if (config.limitsOnly) {
    console.error("--limits-only: 사용량 스캔 없이 한도 스냅샷만 갱신합니다.");
    await runLimits(config, { dryRun: flags.dryRun ?? false });
    return;
  }

  // One state-writing run at a time per machine (Ruling R21): the hourly
  // schedule, the SessionEnd hook and manual runs can overlap. A dry-run only
  // reads state, so it never takes (or waits for) the lock.
  if (!flags.dryRun) {
    let lock = null;
    try {
      lock = acquireRunLock();
    } catch (err) {
      console.error(`warn: could not create run lock (${err.code ?? "fs error"}); continuing without it.`);
    }
    if (lock && !lock.acquired) {
      console.log("Another token-forest upload is already running on this machine — skipping this run.");
      return;
    }
    if (lock) {
      process.on("exit", lock.release);
      // Ctrl-C / kill: release the lock, exit with the conventional code.
      process.once("SIGINT", () => {
        lock.release();
        process.exit(130);
      });
      process.once("SIGTERM", () => {
        lock.release();
        process.exit(143);
      });
    }
  }

  // Scan window. Explicit --since wins (cursor ignored and kept); --full forces
  // a full resend; otherwise the cursor decides. TOKEN_FOREST_SINCE only raises
  // the start of a cursor window. The run's start time becomes the next
  // cursor, so lines written during the scan are re-read next run.
  const runStartedAt = new Date();
  const cursor = readCursor();
  const window = config.since
    ? { mode: "since", sinceDate: config.since }
    : applySinceFloor(
        config.full ? { mode: "full", sinceDate: null } : decideWindow(cursor, runStartedAt),
        config.sinceFloor,
      );

  console.error(`Machine: ${config.machineId || "(none)"}  (state: ${stateDir()})`);
  console.error(
    window.sinceDate
      ? `Scanning local logs (${window.mode}) for usage since ${window.sinceDate} (KST)...`
      : `Scanning all local logs (${window.mode})...`,
  );

  // Every parser is best-effort: a failure warns locally and reports a fixed
  // health code (never the raw message, which may carry paths) so the rest of
  // the run still uploads.
  const attribution = loadAttribution();
  const accountLedger = loadHookLedger();
  let attributionSeen = null; // key16s met by the claude parser (R20 prune set)
  let attributionScan = null; // that scan's { files, dirErrors }
  const rows = [];
  const hourlyRows = [];
  const sessions = [];
  const health = [];
  for (const parser of PARSERS) {
    try {
      // Rows the server schema would reject are dropped (and counted as
      // unrecognized) so one bad row can't 400 the whole upload (F4).
      const r = dropInvalidSessions(await parser.aggregate({
        sinceDate: window.sinceDate ?? undefined,
        machineId: config.machineId,
        attribution,
        accountLedger,
      }));
      rows.push(...r.rows);
      hourlyRows.push(...r.hourlyRows);
      if (r.attributionSeen) {
        attributionSeen = r.attributionSeen;
        attributionScan = { files: r.stats?.files ?? 0, dirErrors: r.stats?.dirErrors ?? 0 };
      }
      if (r.stats?.skippedPinnedAbsent > 0) {
        console.error(
          `${parser.tool}: ${fmtInt(r.stats.skippedPinnedAbsent)} message(s) pinned to a session whose ` +
            "file is gone — already uploaded under that session, not re-sent.",
        );
      }
      // Session rows carry this device's pseudonymous id (server machineIds).
      for (const s of r.sessions ?? []) sessions.push({ ...s, machineId: config.machineId });
      if (r.health) health.push(r.health);
      if (r.health?.filesScanned > 0 || (r.sessions?.length ?? 0) > 0) {
        console.error(
          `${parser.tool}: scanned ${fmtInt(r.health?.filesScanned ?? 0)} file(s), ` +
            `${fmtInt(r.sessions?.length ?? 0)} session row(s), ` +
            `${fmtInt(r.health?.linesUnrecognized ?? 0)} unrecognized line(s).`,
        );
      }
    } catch (err) {
      console.error(`warn: skipped ${parser.tool} scan (${err.message}).`);
      health.push({ parser: parser.tool, filesScanned: 0, linesUnrecognized: 0, sessionsEmitted: 0, error: "parser_failed" });
    }
  }
  console.error(
    `Collected ${fmtInt(sessions.length)} session row(s) ` +
      `(v1 fallback: ${rows.length} daily / ${hourlyRows.length} hourly row(s)).`,
  );

  const device = {
    machineId: config.machineId,
    ...(config.deviceLabel ? { label: config.deviceLabel } : {}),
    uploaderVersion: uploaderVersion(),
  };

  if (flags.dryRun) {
    console.error("--dry-run: printing a summary, sending nothing, cursor untouched.\n");
    printSessionSummary(sessions, health, {
      mode: window.mode,
      sinceDate: window.sinceDate,
      machineId: config.machineId,
      deviceLabel: config.deviceLabel,
    });
    console.log(`\n${rows.length} daily / ${hourlyRows.length} hourly row(s) would be sent only to an old (v1) server.`);
    if (config.limits) await runLimits(config, { dryRun: true });
    if (config.digest) console.log("digest: skipped (--dry-run — 초안을 생성하지 않습니다)");
    return;
  }

  if (!config.serverUrl || !config.token) {
    if (sessions.length === 0 && rows.length === 0) {
      console.log(
        "Nothing to upload — 이 기기에는 사용 기록이 아직 없습니다.\n" +
          "이 기기에서 AI 도구를 사용하면 자동으로 업로드되기 시작하고, 그때\n" +
          "대시보드 /me 의 '수집 중인 기기'에 이 기기가 나타납니다.",
      );
      return;
    }
    console.error(
      "\nerror: missing server URL and/or ingest token.\n" +
        "Provide them via --server/--token, TOKEN_FOREST_URL/TOKEN_FOREST_TOKEN,\n" +
        `or ${configPath()} { "serverUrl", "token" }.\n\n` +
        "Run with --dry-run to preview without credentials.",
    );
    process.exit(2);
  }

  // Pin this run's Claude attributions before sending (Ruling R6: the first
  // assignment wins forever, even if this upload fails part-way). Merged with
  // the on-disk index (R21). Only a truly full scan (no since bound at all)
  // prunes pins it did not see (R20); a partial scan can't know. A walk that
  // hit unreadable dirs, or found no files at all, is not trusted to prune.
  try {
    let prune = window.mode === "full" && !window.sinceDate && attributionSeen !== null;
    if (prune && (attributionScan.files === 0 || attributionScan.dirErrors > 0)) {
      console.error(
        `warn: claude scan incomplete (${attributionScan.files} file(s), ${attributionScan.dirErrors} unreadable dir(s)); ` +
          "keeping all attribution pins this run.",
      );
      prune = false;
    }
    saveAttribution(attribution, prune ? { seen: attributionSeen } : {});
  } catch (err) {
    console.error(`warn: could not save claude-attr index (${err.code ?? "write error"}).`);
  }

  // Cursor after a success: explicit --since leaves it alone (its window may
  // not cover what the cursor still owes); full/incremental advance it.
  // keepFull: the server took nothing of this full run (v1 server, nothing in
  // the v1 window), so the full resend is still owed.
  const commitCursor = ({ keepFull = false } = {}) => {
    if (window.mode === "since") return;
    try {
      writeCursor({
        lastSuccessAt: runStartedAt.toISOString(),
        lastFullAt: window.mode === "full" && !keepFull ? runStartedAt.toISOString() : cursor.lastFullAt,
        // keepFull: keep the old parserVersion too, so a full resend forced by
        // a parser bump (R19) is still owed after a v1-server run.
        ...(keepFull ? { parserVersion: cursor.parserVersion } : {}),
      });
    } catch (err) {
      console.error(`warn: could not save cursor (${err.code ?? "write error"}); the next run re-sends this window.`);
    }
  };

  // Old (v1) servers overwrite daily totals; never push more history there
  // than the pre-v2 uploader did (30 days) in a cursor-driven full run.
  const fallbackFloor = window.mode === "full" ? kstDaysAgo(runStartedAt, V1_FALLBACK_DAYS) : null;
  const fallbackRows = fallbackFloor ? rows.filter((r) => r.date >= fallbackFloor) : rows;
  const fallbackHourly = fallbackFloor
    ? hourlyRows.filter((h) => h.hour.slice(0, 10) >= fallbackFloor)
    : hourlyRows;

  if (sessions.length === 0) {
    // Nothing new: heartbeat so /me keeps this device fresh (Ruling R12).
    try {
      const r = await sendV2({ serverUrl: config.serverUrl, token: config.token, sessions, health, device, fallbackRows, fallbackHourly });
      if (r.mode === "v1-fallback") {
        console.log(`Done (v1-fallback). Uploaded ${fallbackRows.length} daily row(s); server upserted ${r.upserted}.`);
      } else if (r.mode === "heartbeat") {
        console.log("Nothing new to upload — sent a heartbeat (v2).");
      } else {
        console.log("Nothing new to upload.");
      }
      commitCursor();
    } catch (err) {
      console.error(`warn: heartbeat not delivered (${err.message}).`);
    }
  } else {
    console.error(`Uploading ${fmtInt(sessions.length)} session row(s) to ${config.serverUrl}/api/ingest ...`);
    try {
      const r = await sendV2({ serverUrl: config.serverUrl, token: config.token, sessions, health, device, fallbackRows, fallbackHourly });
      if (r.mode === "v1-empty") {
        console.log(
          `Server is v1 (does not accept sessions yet); nothing to send in the v1 window ` +
            `(last ${V1_FALLBACK_DAYS} days). Full resend still pending.`,
        );
        commitCursor({ keepFull: true });
        return finish(config);
      }
      if (r.mode === "v1-fallback") {
        console.log(
          `Done (v1-fallback — server does not accept sessions yet). Uploaded ${fallbackRows.length} daily row(s); ` +
            `server upserted ${r.upserted}${r.skipped ? ` (${r.skipped} skipped)` : ""}; ` +
            `${fallbackHourly.length} hourly row(s), upserted ${r.hourlyUpserted}.`,
        );
      } else {
        console.log(
          `Done (v2). Uploaded ${fmtInt(sessions.length)} session row(s) in ${r.requests} request(s); ` +
            `server upserted ${fmtInt(r.sessionsUpserted)}.`,
        );
      }
      commitCursor();
    } catch (err) {
      console.error(`\nupload failed: ${err.message}`);
      process.exit(1);
    }
  }

  await finish(config);
}

// After the usage upload: limits snapshot, then the (retired) digest.
async function finish(config) {
  if (config.limits) await runLimits(config, { dryRun: false });

  // Daily digest draft (see README "일일 다이제스트"): builds yesterday's
  // topic-level draft locally and uploads it as a PRIVATE draft. Best-effort —
  // any failure is a single warning line and never fails the run.
  if (config.digest && config.serverUrl && config.token) {
    try {
      const result = await buildAndSendDigest({
        serverUrl: config.serverUrl,
        token: config.token,
        // Default profile ONLY — same boundary as the usage scan. Extra
        // claudeDirs profiles exist for limit tracking and may hold a
        // PERSONAL account whose session titles must not reach the company
        // digest. Extra work repos are added explicitly via digestRepos.
        configDirs: [join(homedir(), ".claude")],
        machineId: config.machineId,
        extraRepoDirs: config.digestRepos,
      });
      if (result.uploaded) console.log(`digest: uploaded draft for ${result.date}`);
      else if (result.merged) console.log(`digest: merged this machine into ${result.date}`);
      else if (result.skipped) console.log(`digest: skipped (${result.skipped})`);
      else if (result.failed) console.error(`digest: failed — ${result.failed}`);
    } catch (err) {
      console.error(`digest: failed — ${err.message}`);
    }
  }
}

const argv = process.argv.slice(2);
const run = argv.some((arg) => ["--reliable", "--reliable-manifest", "--reliable-reconcile"].includes(arg))
  ? import("./reliable/cli.mjs").then(({ runReliable }) => runReliable(argv))
  : main();
run.catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
