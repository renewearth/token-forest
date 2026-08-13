#!/usr/bin/env node
// token-forest-upload — push local Claude Code token usage to a token-forest server.
//
// Scans ~/.claude/projects/**/*.jsonl, aggregates daily per-model token totals,
// and POSTs them to {serverUrl}/api/ingest. Idempotent: the server upserts by
// (date, tool, model, member), so re-running never inflates totals.

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, resolveConfig, configPath } from "./config.mjs";
import * as claudeCode from "./parsers/claude-code.mjs";
import * as claudeLimits from "./parsers/claude-limits.mjs";
import * as codex from "./parsers/codex.mjs";
import * as gemini from "./parsers/gemini.mjs";
import { sendRows, sendLimits } from "./send.mjs";
import { buildAndSendDigest } from "./digest.mjs";

const HELP = `token-forest-upload — upload local Claude Code usage to token-forest

Usage:
  token-forest-upload [options]

Options:
  --server <url>     token-forest server base URL (e.g. https://meter.example.com)
  --token <token>    per-member ingest token (get it from your token-forest admin)
  --since <date>     only scan usage on/after this UTC date (YYYY-MM-DD).
                     Default: 30 days ago.
  --machine-id <id>  label this machine's usage (default: this host's short
                     name). Uploads from different machines add up instead of
                     overwriting, so give each machine a distinct id.
  --claude-dir <dir> 추가 Claude config 디렉터리(여러 번 지정 가능). 여러
                     계정을 CLAUDE_CONFIG_DIR 프로필로 쓸 때 각 계정의 한도를
                     함께 추적합니다. env: TOKEN_FOREST_CLAUDE_DIRS(쉼표/콜론 구분)
  --limits-only      사용량 스캔 없이 한도 스냅샷만 빠르게 갱신
  --no-limits        skip the Claude plan rate-limit snapshot (see below)
  --no-digest        skip the daily digest draft (see README); config.json의
                     "digest": false 로도 끌 수 있습니다
  --dry-run          print the aggregated rows and send nothing
  -h, --help         show this help

By default the run also snapshots your Claude plan's rate-limit windows (5-hour,
7-day, ...) via an unofficial usage API and uploads them as account-level
"claude_limits" rows. Any failure there only warns; it never fails the upload.

Configuration (highest precedence first):
  1. CLI flags:  --server, --token, --machine-id
  2. Env vars:   TOKEN_FOREST_URL, TOKEN_FOREST_TOKEN, TOKEN_FOREST_MACHINE_ID
  3. Config file: ~/.config/token-forest/config.json
                  { "serverUrl": "...", "token": "..." }

Examples:
  token-forest-upload --dry-run
  token-forest-upload --server https://meter.example.com --token tmk_xxx
  token-forest-upload --since 2026-07-01
`;

function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

// Render aggregated rows as a fixed-width table for --dry-run.
function printTable(rows, machineId) {
  console.log(`machineId: ${machineId || "(none)"}  (uploads from other machines add up)`);
  if (rows.length === 0) {
    console.log("(no usage found for the selected range)");
    return;
  }
  const headers = [
    "date",
    "tool",
    "model",
    "input",
    "output",
    "cacheRead",
    "cacheCreate",
    "reqs",
    "sess",
  ];
  const body = rows.map((r) => [
    r.date,
    r.tool,
    r.model,
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.cacheReadTokens),
    fmtInt(r.cacheCreationTokens),
    fmtInt(r.requests),
    fmtInt(r.sessions),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));

  const totals = rows.reduce(
    (t, r) => {
      t.input += r.inputTokens;
      t.output += r.outputTokens;
      t.cacheRead += r.cacheReadTokens;
      t.cacheCreate += r.cacheCreationTokens;
      t.reqs += r.requests;
      return t;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reqs: 0 },
  );
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  console.log(
    line([
      "TOTAL",
      "",
      `${rows.length} rows`,
      fmtInt(totals.input),
      fmtInt(totals.output),
      fmtInt(totals.cacheRead),
      fmtInt(totals.cacheCreate),
      fmtInt(totals.reqs),
      "",
    ]),
  );
}

// Snapshot Claude plan rate-limit windows and either print them (dry-run) or
// upload them. Any failure — missing credential, changed/404 endpoint, network
// error — is downgraded to a single warn line so it never fails the run.
async function runLimits(config, { dryRun }) {
  try {
    const { snapshots, warnings } = await claudeLimits.snapshotAll({
      configDirs: config.claudeDirs,
    });
    for (const w of warnings) console.error(`warn: limits(${w})`);
    if (dryRun) {
      const accounts = [...new Set(snapshots.map((s) => s.accountEmail))].join(", ");
      console.log(
        `\nClaude plan limits for ${accounts || "(unknown account)"} (${snapshots.length} window(s), sending nothing):`,
      );
      for (const s of snapshots) {
        const resetsAt = s.resetsAt ? `  resets ${s.resetsAt}` : "";
        console.log(
          `  ${s.window.padEnd(22)} ${String(s.utilizationPct).padStart(3)}%${resetsAt}`,
        );
      }
      return;
    }
    if (!config.serverUrl || !config.token) {
      console.error("warn: skipped Claude plan limits snapshot (no server URL/token).");
      return;
    }
    console.error(`Uploading ${snapshots.length} Claude limits snapshot(s) ...`);
    const { upserted } = await sendLimits({
      serverUrl: config.serverUrl,
      token: config.token,
      snapshots,
    });
    console.log(
      `Done. Uploaded ${snapshots.length} limits snapshot(s); server upserted ${upserted}.`,
    );
  } catch (err) {
    console.error(`warn: skipped Claude plan limits snapshot (${err.message}).`);
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

  const config = await resolveConfig(flags);

  if (config.limitsOnly) {
    console.error("--limits-only: 사용량 스캔 없이 한도 스냅샷만 갱신합니다.");
    await runLimits(config, { dryRun: flags.dryRun ?? false });
    return;
  }

  console.error(`Machine: ${config.machineId || "(none)"}`);
  console.error(`Scanning ~/.claude/projects for usage since ${config.since} (UTC)...`);
  const {
    rows: claudeRows,
    hourlyRows: claudeHourly,
    stats,
  } = await claudeCode.aggregate({
    sinceDate: config.since,
    machineId: config.machineId,
  });
  console.error(
    `Scanned ${stats.files} files, ${fmtInt(stats.linesRead)} lines: ` +
      `${fmtInt(stats.counted)} counted, ${fmtInt(stats.duplicates)} duplicate, ` +
      `${fmtInt(stats.synthetic)} synthetic, ${fmtInt(stats.malformed)} malformed lines skipped.`,
  );

  // Codex CLI usage (~/.codex/sessions). Best-effort like the limits/digest
  // blocks: any failure warns and degrades to empty so it never blocks the
  // claude_code upload. (Missing dir is already handled inside the parser.)
  let codexRows = [];
  let codexHourly = [];
  try {
    const codexResult = await codex.aggregate({
      sinceDate: config.since,
      machineId: config.machineId,
    });
    codexRows = codexResult.rows;
    codexHourly = codexResult.hourlyRows;
    if (codexResult.stats.files > 0) {
      console.error(
        `Codex: scanned ${codexResult.stats.files} rollout file(s), ` +
          `${fmtInt(codexResult.stats.events)} usage event(s).`,
      );
    }
  } catch (err) {
    console.error(`warn: skipped Codex scan (${err.message}).`);
  }

  // Gemini CLI usage (~/.gemini/tmp/**/chats). Best-effort, same as Codex.
  let geminiRows = [];
  let geminiHourly = [];
  try {
    const geminiResult = await gemini.aggregate({
      sinceDate: config.since,
      machineId: config.machineId,
    });
    geminiRows = geminiResult.rows;
    geminiHourly = geminiResult.hourlyRows;
    if (geminiResult.stats.files > 0) {
      console.error(
        `Gemini: scanned ${geminiResult.stats.files} session file(s), ` +
          `${fmtInt(geminiResult.stats.events)} usage event(s).`,
      );
    }
  } catch (err) {
    console.error(`warn: skipped Gemini scan (${err.message}).`);
  }

  const rows = [...claudeRows, ...codexRows, ...geminiRows];
  const hourlyRows = [...claudeHourly, ...codexHourly, ...geminiHourly];
  console.error(
    `Aggregated into ${rows.length} daily row(s) and ${hourlyRows.length} hourly row(s).`,
  );

  if (flags.dryRun) {
    console.error("--dry-run: printing rows, sending nothing.\n");
    printTable(rows, config.machineId);
    console.log(`\n${hourlyRows.length} hourly row(s) would be sent (usage_hourly mirror).`);
    if (config.limits) await runLimits(config, { dryRun: true });
    if (config.digest) console.log("digest: skipped (--dry-run — 초안을 생성하지 않습니다)");
    return;
  }

  if (rows.length === 0) {
    console.log(
      "Nothing to upload — 이 기기에는 Claude Code 사용 기록이 아직 없습니다.\n" +
        "이 기기에서 Claude Code를 사용하면 자동으로 업로드되기 시작하고, 그때\n" +
        "대시보드 /me 의 '수집 중인 기기'에 이 기기가 나타납니다. (다른 기기에서의\n" +
        "사용량은 그 기기의 업로더가 담당합니다 — 중복 집계되지 않습니다.)",
    );
  } else if (!config.serverUrl || !config.token) {
    console.error(
      "\nerror: missing server URL and/or ingest token.\n" +
        "Provide them via --server/--token, TOKEN_FOREST_URL/TOKEN_FOREST_TOKEN,\n" +
        `or ${configPath()} { "serverUrl", "token" }.\n\n` +
        "Run with --dry-run to preview without credentials.",
    );
    process.exit(2);
  } else {
    console.error(`Uploading ${rows.length} row(s) to ${config.serverUrl}/api/ingest ...`);
    try {
      const { batches, upserted, skipped, hourlyUpserted } = await sendRows({
        serverUrl: config.serverUrl,
        token: config.token,
        rows,
        hourly: hourlyRows,
      });
      const skippedNote =
        skipped > 0
          ? ` (${skipped} skipped — already covered by a higher-priority source, e.g. a central poller)`
          : "";
      const hourlyNote =
        hourlyRows.length > 0
          ? ` Sent ${hourlyRows.length} hourly row(s); server upserted ${hourlyUpserted}.`
          : "";
      console.log(
        `Done. Uploaded ${rows.length} row(s) in ${batches} batch(es); server upserted ${upserted}${skippedNote}.${hourlyNote}`,
      );
    } catch (err) {
      console.error(`\nupload failed: ${err.message}`);
      process.exit(1);
    }
  }

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

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
