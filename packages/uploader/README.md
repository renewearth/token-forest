# @token-forest/uploader

## Protocol 3 reliability preview

The existing command still uses collection v2. Protocol 3 is selected only with
`--reliable`; it sends source records to `/api/ingest/records`, persists an
atomic local outbox, and never falls back to older ingest endpoints. The server
acknowledges each exact record key and digest. Conflicted or rejected entries
remain in the outbox for review. The machine ID is the same persisted random
UUID used by the existing uploader; record identity never includes that ID.

For a local, read-only inventory run:

```sh
token-forest-upload --reliable-manifest --source-root /path/to/synthetic-or-local-home
```

This prints only keys, digests, timestamps, numeric counters, evidence, and
source health. It does not read uploader config or credentials, create device
state, call an API, or query usage limits. `--opencode-db /path/to/opencode.db`
selects a read-only SQLite fixture. Codex checks both `.codex/sessions` and
`.codex/archived_sessions` under the source root; repeat `--codex-dir /path`
for other explicit rollout directories. The manifest reports checked and
present location counts without revealing paths. Do not put credentials in the command line
when generating a manifest. A source without an explicit account namespace is
reported as `unverified:default`; it cannot support a fully verified cutover.

Configure each source's stable logical account namespace with repeated
`--account claude_code=account-id` flags, or `reliableAccounts` in
`~/.config/token-forest/config.json`. The namespace must describe the logical
source account consistently across machines; it must not contain a host, path,
or device ID. Use `--reliable-reconcile` with server credentials to compare a
read-only local manifest to stored key/digest receipts. This comparison is
limited to the selected local records and makes no global completeness claim.

```sh
token-forest-upload --reliable --server https://meter.example.com --token TOKEN
```

The reliable scan emits Claude message/request events, OpenCode message events,
Codex and Gemini cumulative observations, and Grok wrapper events. Codex and
Gemini send raw cumulative total input (including cached input) and cached
input separately. The server derives uncached input in source order. Their
request counts are unknown because snapshots do not prove them. Grok lines
without native IDs use an explicit unverified line fallback; line insertion
can change those IDs. Claude's native message/request pair identifies an event
when its account namespace is configured. Its event chain is stable across fork
copies; the original session attribution remains unknown and no session count
is claimed from those event chains.
The local outbox and receipt files live
in `TOKEN_FOREST_STATE_DIR` (default `~/.token-forest`).
Reliable upload requires Python 3 with the standard `fcntl` module on macOS
or Linux. A small helper holds a kernel file lock while the Node uploader runs;
the kernel releases it after normal exit or process death.

The uploader package ships its protocol hash implementation inside
`src/reliable/records.mjs`. The server imports that same source through
`packages/protocol/records.mjs`, keeping installed tarballs self-contained.
Version 0.3.0 sends a source build hash and parser health with each run. A
10-minute launchd template is in `examples/reliable-10-minute.plist`. It has
placeholders for absolute Node and CLI paths and does not install or enable a
schedule. Review source account mapping and protocol 3 receipts before using it.

Local uploader CLI for [token-forest](../../). It reads your on-disk **Claude
Code** transcripts (`~/.claude/projects/**/*.jsonl`), **Codex CLI** rollouts
(`~/.codex/sessions/**/rollout-*.jsonl`), **Gemini CLI**, **Grok** and
**opencode** (`$XDG_DATA_HOME/opencode/opencode.db`, else
`~/.local/share/opencode/opencode.db`; read-only; any provider
you connected, e.g. Copilot Pro+) logs, builds **session-grained** rows and
pushes them to a token-forest server. The server max-merges each field per
session, so a session seen on several machines (or replicated by a sync tool)
counts once. Install the uploader on every machine you use.

Use this if you run Claude Code and/or Codex CLI on a **personal** account —
there's no central API to poll, so each member uploads their own usage.

- Dependency-free: plain Node 22 ESM, no build step, no `npm install`.
- Idempotent: the server merges session rows per field (max), so re-sending an
  overlap never double-counts.
- One run at a time per state dir (run lock); a run with nothing to send still
  sends a heartbeat so `/me` knows the device is alive.
- Old servers: if the server rejects the v2 format, the uploader switches to
  the v1 daily format automatically.
- Reads transcripts as streams and skips malformed lines, so it's safe to run
  over a large `~/.claude` directory.

## Setup

> **No VPN required.** The server URL is a public HTTPS endpoint (Cloudflare
> Tunnel) that authenticates purely by your ingest token — you do **not** need
> Tailscale or any company VPN to upload. Nothing but per-model token counts
> leaves your machine, for both Claude Code and Codex CLI (`--dry-run` shows
> exactly what is sent).

1. Ask your token-forest admin for your personal **ingest token** (looks like
   `tmk_...`) and the **server URL**.
2. Configure credentials one of three ways (highest precedence first):

   **CLI flags**
   ```bash
   npx token-forest-upload --server https://meter.example.com --token tmk_xxx
   ```

   **Environment variables**
   ```bash
   export TOKEN_FOREST_URL=https://meter.example.com
   export TOKEN_FOREST_TOKEN=tmk_xxx
   ```

   **Config file** — `~/.config/token-forest/config.json`
   ```json
   { "serverUrl": "https://meter.example.com", "token": "tmk_xxx" }
   ```

## Usage

Preview what would be sent (no credentials or network needed):

```bash
npx token-forest-upload --dry-run
```

Upload (default window = change cursor: every local log on the first run and
at least weekly, otherwise from one KST day before the last successful upload;
state in `~/.token-forest/cursor.json`, folder overridable with
`TOKEN_FOREST_STATE_DIR`):

```bash
npx token-forest-upload
```

Limit the scan to a start date (KST; ignores and keeps the cursor):

```bash
npx token-forest-upload --since 2026-07-01
```

First run = full backfill of all local logs. `TOKEN_FOREST_SINCE=YYYY-MM-DD`
(optional, team-wide) only raises the lower bound of the window.

### Options

| Flag | Description |
|------|-------------|
| `--server <url>` | token-forest server base URL |
| `--token <token>` | per-member ingest token |
| `--since <YYYY-MM-DD>` | only scan usage on/after this KST date (default: the change cursor decides) |
| `--full` | resend every local log now (stamps the cursor's weekly full resend) |
| `--device-label <name>` | your own name for this machine (≤32 chars), shown only on your /me; or `"deviceLabel"` in config.json. Never auto-filled |
| `--machine-id <id>` | override this machine's pseudonymous id (default: the random device-id UUID persisted at `~/.token-forest/device-id`; the host name is never used or sent) |
| `--claude-dir <dir>` | extra Claude config dir (repeatable) — track limits for multiple accounts kept in per-account `CLAUDE_CONFIG_DIR` profiles; env: `TOKEN_FOREST_CLAUDE_DIRS` (comma/colon-separated); or `"claudeDirs": ["~/.claude-team"]` in config.json (survives cron/hook runs) |
| `--limits-only` | refresh only the plan-limit snapshot, skipping the usage scan (fast) |
| `--no-limits` | skip the Claude plan rate-limit snapshot |
| `--dry-run` | print per-tool session counts, token sums and parser health; send nothing, cursor untouched |
| `-h`, `--help` | show help |

### Machine identity (multi-machine safe)

Each upload carries a **machineId** (a random per-device id kept in the state
dir; `--device-label` is only a display name). Sessions are deduplicated by
session, so the same session on two machines is counted once, while different
sessions add up.

- The default machineId is a random id persisted at `<state dir>/device-id`
  (the hostname is never sent).
- Override it with `--machine-id <id>` or `TOKEN_FOREST_MACHINE_ID` for
  ephemeral hosts (CI, containers). Keep it stable and distinct per machine.
- State folder (`device-id`, `cursor.json`, `claude-attr.json`, `run.lock`):
  `~/.token-forest`, or `TOKEN_FOREST_STATE_DIR`.

### Claude plan limits (unofficial API)

By default each run also snapshots your Claude plan's **rate-limit windows**
(e.g. 5-hour, 7-day, and model-specific windows when active) and uploads them as
account-level `claude_limits` rows — `model` is the window name and `requests`
is the integer utilization percent (0–100). These rows are **account-level**
(empty machineId), so two of your machines don't create duplicate limit rows.

This reads the OAuth token that Claude Code stores at
`~/.claude/.credentials.json` and calls an **unofficial** usage endpoint that
Claude's own clients use. That endpoint is undocumented and may change or
disappear without notice, so it's best-effort: **any failure** (no credential,
endpoint changed/404, rate-limited, offline) prints a single warning and never
fails the usage upload. Disable it entirely with `--no-limits`. The access
token is never logged or included in uploaded data.

**Auto-refresh for idle profiles**: an extra `--claude-dir` profile that exists
only for limit tracking is never used by Claude Code itself, so its access
token would expire (~8h) and kill the snapshot. Before each snapshot the
uploader renews an expired/expiring token via the same OAuth token endpoint
Claude Code uses, and writes the rotated credentials back **atomically to the
same file** (`.credentials.json`, mode 0600) — this is the uploader's only
write inside a Claude config dir, and tokens still never leave the machine.
If Claude Code updates the file concurrently, its version wins. A failed
refresh degrades to the usual per-dir warning.

### 일일 다이제스트 (Daily digest) — ⛔ 폐기 (2026-07-20)

**이 기능은 종료됐습니다.** 서버 `/api/digest`는 410을 반환하고, 업로더는 초안을
만들지 않습니다(`config.mjs`의 `digest: false`). `digest.mjs`와 플래그 배선은
되살릴 수 있도록 보존돼 있습니다. 아래 설명은 이력 보존용입니다.

<details>
<summary>폐기 전 동작 (참고)</summary>


기본 실행은 하루 1회, **어제**의 작업 다이제스트 **초안**을 만들어 서버에
올립니다(이미 그 날짜의 다이제스트가 있으면 아무것도 하지 않음 — 여러 기기를
써도 첫 기기만 생성).

**무엇이 전송되나** — 주제 수준의 재료만:

- 세션 제목(트랜스크립트의 `ai-title` 레코드)과 프로젝트 이름
- 본인 git 커밋 **제목**(리포별 최대 20건)과 커밋이 건드린 **파일 경로**
  (리포별 최대 100개 — 충돌 감지용, 내용 없음)
- 위 재료를 요약한 한국어 불릿(아래 LLM 참고)

**대화 원문(프롬프트·응답)은 읽지도, 보내지도 않습니다.** 업로드 전에
시크릿 패턴(`sk-`, `tmk_`, `ghp_`, `AKIA`, 긴 hex/base64 등)이 보이는 줄은
통째로 제거됩니다.

**초안은 비공개입니다.** 서버에 draft 상태로 저장되어 **본인만** 조회·수정할
수 있고, 팀 노출(Slack + /team)은 오직 본인이 /me에서 [팀에 공유]를 눌러야만
일어납니다. 자동 공유 경로는 없습니다. 본인이 수정했거나 공유/건너뛰기한
날짜는 업로더가 다시 덮어쓰지 않습니다.

**요약 LLM**: 본인 Claude 계정으로 `claude -p`(Haiku)를 하루 최대 1회
호출합니다. 실패하면(미설치·한도 등) 재료 불릿 그대로 초안이 됩니다.

**여러 기기**: 초안은 기기별로 **병합**됩니다 — 먼저 실행된 기기가 초안을
만들고, 다른 기기는 자기 재료를 합쳐 재요약합니다(본인이 수정/공유한 뒤에는
합치지 않음). 재료에는 `[기기: 이름]` 표시가 남습니다.

**Claude Code 밖의 작업**: 트랜스크립트가 없는 작업(Cursor·일반 터미널)의
커밋은 자동으로 잡히지 않습니다 — 포함하려면 config.json에 리포 목록을
지정하세요: `"digestRepos": ["~/work/my-repo"]`.

**개인 계정 분리**: 사용량 스캔과 다이제스트 재료는 **기본 프로필
(`~/.claude`)만** 봅니다. 개인 계정을 별도 `CLAUDE_CONFIG_DIR` 프로필로
쓰면 그쪽 세션은 회사 집계·다이제스트에 포함되지 않습니다. `claudeDirs`는
**한도 스냅샷 전용**이라, 개인 플랜 한도 게이지를 원할 때만 추가하면 됩니다
(사용량과 무관). 같은 프로필에서 `/login` 전환은 분리 불가 — 프로필을
나누세요.

**끄기**: `~/.config/token-forest/config.json`에 `"digest": false`를 넣거나
실행 시 `--no-digest`를 붙이면 이 기기에서 초안을 만들지 않습니다.

</details>

### What gets sent

One row per `(tool, session, hour, model)`: `input` / `output` / `cacheRead` /
`cacheCreation` tokens and request count. `tool` is `claude_code`, `codex`,
`gemini`, `grok` or `opencode`; all are scanned in the same run. Your identity is taken from the ingest token —
`externalId` is filled in by the server (your member email), so nothing
personally identifying beyond model/token counts leaves your machine — with one
addition for Claude Code, described next.

## Which Claude organization a session ran under

A member may use a company organization and a personal plan on the same
machine, and a company spend report only covers the company organization. To
tell them apart, Claude Code session rows can carry `accountOrg` (the Claude
**organization id** — never the email or account name) and `accountEvidence`:

- `transcript` — Remote Control sessions write the owning organization into the
  session log; usage after such a line takes that organization.
- `hook` — the installer's `SessionStart`/`SessionEnd` hook runs
  `run.sh --hook`, which notes the session id and the organization of that
  moment's login in `~/.token-forest/claude-accounts.jsonl` on the machine the
  session ran on.

There is no "whoever is logged in when the upload runs" guess: logs replicated
from another machine or an account switched since would be tagged wrong. A row
with neither evidence is sent untagged, and one bucket that saw two
organizations is tagged `mixed`. `--dry-run` prints how many requests carry
which tag. Sessions that ended before the hook was installed stay untagged
unless their log has Remote Control lines.

## Auto-upload on session end (optional)

Claude Code fires a `SessionEnd` hook when a session closes. Add this to
`~/.claude/settings.json` to upload automatically (set the env vars above so no
secrets sit in the hook):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx --yes token-forest-upload >/dev/null 2>&1 &"
          }
        ]
      }
    ]
  }
}
```

The trailing `&` backgrounds the upload so it never delays your shell. The
change cursor keeps each run small, and the run lock makes overlapping runs
harmless.

## Reconciliation

`node packages/uploader/src/scripts/audit-local.mjs` tallies this machine's
local logs per tool x KST date without sessionizing (read-only, numbers only)
to compare against server values.

## Adding another tool

Each tool's parser is isolated in its own file under `src/parsers/` and
exports `{ tool, aggregate }` (`claude-code`, `codex`, `gemini`, `grok`,
`opencode`). `cli.mjs` runs all of them and merges their session rows. Adding
another tool means adding a sibling parser file and one line to `PARSERS` in
`cli.mjs`.
