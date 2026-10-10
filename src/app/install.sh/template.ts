// The one-command uploader installer, served as text by ./route.ts.
//
// `renderInstaller` injects the server origin as SERVER_URL so the installed
// config, download URL, and any *operational* references all point back at
// the server that served the script (the ingest host). It also injects
// DASHBOARD_URL — which may be a different, login-gated host — used only for
// the human-readable links in the completion banner. Both are embedded as
// single-quoted shell literals; any single quote is escaped so it cannot
// break out of the literal.
//
// The body below is plain bash. Inside this TS template literal only backticks
// and the two-character sequence `${` are special — the script deliberately
// avoids both (it uses `$(...)`, `"$VAR"`, and string concatenation instead) so
// it reads as ordinary shell. The single unavoidable `${TMPDIR:-/tmp}` is
// escaped as `\${...}`.

export function renderInstaller(serverUrl: string, dashboardUrl: string, backfillStart: string): string {
  const safe = serverUrl.replace(/'/g, "'\\''");
  const safeDashboard = dashboardUrl.replace(/'/g, "'\\''");
  const safeBackfill = backfillStart.replace(/'/g, "'\\''");
  return `#!/usr/bin/env bash
set -euo pipefail

# ─── injected by the server ─────────────────────────────────────────────
SERVER_URL='${safe}'
DASHBOARD_URL='${safeDashboard}'
# BACKFILL_START: v2 업로더부터 쓰지 않음(첫 실행이 로컬 기록 전체를 보냄). 호환용으로만 남김.
BACKFILL_START='${safeBackfill}'

# ─── 출력 헬퍼 (한글) ────────────────────────────────────────────────────
info() { printf '\\033[36m▶\\033[0m %s\\n' "$1"; }
ok()   { printf '\\033[32m✓\\033[0m %s\\n' "$1"; }
warn() { printf '\\033[33m!\\033[0m %s\\n' "$1" >&2; }
fail() { printf '\\033[31m✗ %s\\033[0m\\n' "$1" >&2; exit 1; }

# ─── 인자 파싱: 첫 위치 인자는 토큰, --keep-config 는 옵션 ────────────────
TOKEN=""
KEEP_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --keep-config) KEEP_CONFIG=1 ;;
    --*) fail "알 수 없는 옵션입니다: $arg" ;;
    *)
      if [ -z "$TOKEN" ]; then TOKEN="$arg"; else fail "인자가 너무 많습니다: $arg"; fi
      ;;
  esac
done

if [ -z "$TOKEN" ]; then
  fail "업로드 토큰이 없습니다. 대시보드 /me 의 '내 명령'에서 복사한 명령을 그대로 붙여넣어 주세요."
fi
case "$TOKEN" in
  tmk_*) : ;;
  *) fail "토큰 형식이 올바르지 않습니다 (tmk_ 로 시작해야 합니다). 대시보드 /me 에서 다시 복사해 주세요." ;;
esac

# 생성 파일(run.sh·훅·crontab)이 홈 경로를 작은따옴표 리터럴로 묻으므로,
# 경로에 작은따옴표가 있으면 안전하게 중단한다 (극히 드문 경우).
case "$HOME" in
  *"'"*) fail "홈 디렉터리 경로에 작은따옴표(')가 포함되어 있어 설치할 수 없습니다: $HOME" ;;
esac

# ─── 운영체제 감지 ───────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) fail "지원하지 않는 운영체제입니다: $OS (macOS 또는 Linux 가 필요합니다)." ;;
esac

# ─── Node.js (>= 18) 확인 ───────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  if [ "$PLATFORM" = "macos" ]; then
    fail "Node.js 가 설치되어 있지 않습니다. Homebrew 로 설치한 뒤 다시 실행해 주세요:  brew install node"
  else
    fail "Node.js(18 이상)가 설치되어 있지 않습니다. https://nodejs.org 에서 내려받거나 패키지 매니저(apt/dnf 등)로 설치한 뒤 다시 실행해 주세요."
  fi
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js 18 이상이 필요합니다 (현재: $("$NODE_BIN" -v)). 최신 LTS 로 업데이트한 뒤 다시 실행해 주세요."
fi
ok "Node.js 확인: $("$NODE_BIN" -v) ($PLATFORM)"

# ─── 내려받기 도구 ───────────────────────────────────────────────────────
download() { # download <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "curl 또는 wget 이 필요합니다."
  fi
}

# ─── 구 token-meter 설치 정리(이중 실행 방지) ───────────────────
if [ -f "$HOME/Library/LaunchAgents/com.token-meter.uploader.plist" ]; then
  launchctl unload -w "$HOME/Library/LaunchAgents/com.token-meter.uploader.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.token-meter.uploader.plist"
fi
if command -v crontab >/dev/null 2>&1; then
  crontab -l 2>/dev/null | grep -v '# token-meter-uploader' | crontab - 2>/dev/null || true
fi
rm -rf "$HOME/.token-meter" "$HOME/.config/token-meter" 2>/dev/null || true

# ─── 업로더 내려받기 & 설치 (멱등: 지우고 다시 전개) ─────────────────────
TM_DIR="$HOME/.token-forest"
UPLOADER_DIR="$TM_DIR/uploader"
RUNNER="$TM_DIR/run.sh"
CLI="$UPLOADER_DIR/src/cli.mjs"

info "업로더를 내려받는 중..."
mkdir -p "$TM_DIR"
TGZ="$(mktemp "\${TMPDIR:-/tmp}/token-forest-uploader.XXXXXX")"
trap 'rm -f "$TGZ"' EXIT
download "$SERVER_URL/uploader.tgz" "$TGZ"
rm -rf "$UPLOADER_DIR"
mkdir -p "$UPLOADER_DIR"
tar -xzf "$TGZ" -C "$UPLOADER_DIR" --strip-components=1
[ -f "$CLI" ] || fail "업로더 설치에 실패했습니다 ($CLI 를 찾을 수 없습니다)."
ok "업로더 설치 완료: $UPLOADER_DIR"

# ─── 설정 파일 (~/.config/token-forest/config.json, 0600) ─────────────────
CONFIG_DIR="$HOME/.config/token-forest"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_FILE" ] && [ "$KEEP_CONFIG" -eq 1 ]; then
  info "기존 설정 파일을 유지합니다 (--keep-config)."
else
  TM_FILE="$CONFIG_FILE" TM_URL="$SERVER_URL" TM_TOKEN="$TOKEN" TM_DASH="$DASHBOARD_URL" "$NODE_BIN" <<'NODE_EOF'
const fs = require("fs");
// dashboardUrl: 메뉴바 앱의 "숲 열기" 목적지 (수집 호스트와 다를 수 있음).
fs.writeFileSync(
  process.env.TM_FILE,
  JSON.stringify(
    {
      serverUrl: process.env.TM_URL,
      token: process.env.TM_TOKEN,
      dashboardUrl: process.env.TM_DASH || process.env.TM_URL,
    },
    null,
    2,
  ) + "\\n",
  { mode: 0o600 },
);
NODE_EOF
  chmod 600 "$CONFIG_FILE"
  ok "설정 저장: $CONFIG_FILE"
fi

# ─── 실행 래퍼: 마지막 성공 이후 바뀐 사용량을 업로드. 훅·예약·수동 실행이 모두 이걸 호출 ──
cat > "$RUNNER" <<RUNNER_EOF
#!/usr/bin/env sh
# token-forest 업로더 실행 래퍼 (install.sh 가 생성). 업로더의 변경 커서(~/.token-forest/cursor.json)가
# 범위를 정합니다 — 첫 실행·주 1회는 로컬 기록 전체, 그 외는 마지막 성공 전날부터.
NODE_BIN='$NODE_BIN'
CLI='$CLI'
exec "\\$NODE_BIN" "\\$CLI" "\\$@"
RUNNER_EOF
chmod +x "$RUNNER"

# ─── Claude Code SessionEnd 훅 병합 (기존 훅 보존, 중복 방지) ────────────
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"
HOOK_RESULT="$(TM_FILE="$SETTINGS" TM_RUNNER="$RUNNER" "$NODE_BIN" <<'NODE_EOF'
const fs = require("fs");
const file = process.env.TM_FILE;
const runner = process.env.TM_RUNNER;
const marker = ".token-forest/run.sh";
const command = "'" + runner + "' >/dev/null 2>&1 &";
let data = {};
try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (typeof data !== "object" || data === null || Array.isArray(data)) data = {};
if (typeof data.hooks !== "object" || data.hooks === null || Array.isArray(data.hooks)) data.hooks = {};
const list = Array.isArray(data.hooks.SessionEnd) ? data.hooks.SessionEnd : [];
const results = [];
if (JSON.stringify(list).includes(marker)) {
  results.push("hook-exists");
} else {
  list.push({ hooks: [{ type: "command", command }] });
  data.hooks.SessionEnd = list;
  results.push("hook-added");
}
// Claude Code prunes session transcripts after ~30 days by default, which
// permanently caps how far back usage can be re-collected. Extend retention
// so history survives — but never override a value the user already chose.
if (data.cleanupPeriodDays === undefined) {
  data.cleanupPeriodDays = 3650;
  results.push("retention-set");
}
if (results.includes("hook-added") || results.includes("retention-set")) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\\n");
}
process.stdout.write(results.join(","));
NODE_EOF
)"
case "$HOOK_RESULT" in
  *hook-added*) ok "Claude Code 세션 종료 훅을 등록했습니다: $SETTINGS" ;;
  *) info "세션 종료 훅이 이미 등록되어 있습니다 (건너뜀)." ;;
esac
case "$HOOK_RESULT" in
  *retention-set*) ok "Claude Code 세션 기록 보존기간을 연장했습니다 (과거 사용량 소급을 위해)." ;;
esac

# ─── 매시 정각 자동 실행 예약 ────────────────────────────────────────────
install_launchd() {
  local plist="$HOME/Library/LaunchAgents/com.token-forest.uploader.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  launchctl unload "$plist" >/dev/null 2>&1 || true
  cat > "$plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.token-forest.uploader</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$RUNNER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$TM_DIR/uploader.log</string>
  <key>StandardErrorPath</key>
  <string>$TM_DIR/uploader.log</string>
</dict>
</plist>
PLIST_EOF
  if launchctl load -w "$plist" >/dev/null 2>&1; then
    ok "매시 정각 자동 업로드를 등록했습니다 (launchd)."
  else
    warn "launchctl 등록에 실패했습니다. 세션 종료 훅으로는 계속 업로드됩니다."
  fi
}

install_cron() {
  if ! command -v crontab >/dev/null 2>&1; then
    warn "crontab 을 찾을 수 없어 자동 예약을 건너뜁니다. 세션 종료 훅으로는 계속 업로드됩니다."
    return 0
  fi
  local marker="# token-forest-uploader"
  local line="0 * * * * '$RUNNER' >/dev/null 2>&1 $marker"
  local current
  current="$(crontab -l 2>/dev/null | grep -v -F "$marker" || true)"
  if { [ -n "$current" ] && printf '%s\\n' "$current"; printf '%s\\n' "$line"; } | crontab -; then
    ok "매시 정각 자동 업로드를 등록했습니다 (crontab)."
  else
    warn "crontab 등록에 실패했습니다. 세션 종료 훅으로는 계속 업로드됩니다."
  fi
}

# ─── 지금 한 번 업로드 (출력 표시) ───────────────────────────────────────
# 커서가 없는 첫 실행 = 로컬 기록 전체 1회 전송(따로 소급 실행 없음). 예약(launchd
# RunAtLoad·cron)은 이 실행이 끝난 뒤에 등록해, 전체 스캔 두 개가 동시에 돌지 않게 한다.
echo
info "지금 한 번 업로드해 사용량을 확인합니다 (첫 실행은 로컬 기록 전체)..."
set +e
"$RUNNER"
RUN_STATUS=$?
set -e
if [ "$RUN_STATUS" -ne 0 ]; then
  warn "첫 업로드가 실패했습니다 (종료코드 $RUN_STATUS). 네트워크·토큰을 확인한 뒤 '$RUNNER' 를 직접 실행해 재시도할 수 있습니다."
fi

info "매시 정각 자동 업로드를 예약하는 중..."
if [ "$PLATFORM" = "macos" ]; then install_launchd; else install_cron; fi

# ─── 완료 안내 ───────────────────────────────────────────────────────────
echo
ok "설치가 완료되었습니다!"
cat <<DONE

  대시보드:    $DASHBOARD_URL
  설정 파일:   $CONFIG_FILE
  업로더:      $UPLOADER_DIR
  실행 래퍼:   $RUNNER

  · Claude Code 세션이 끝날 때마다 최근 사용량이 자동으로 업로드됩니다.
  · 매시 정각에도 자동으로 업로드됩니다 (사용 한도 스냅샷 포함).
  · 합산 확인: $DASHBOARD_URL/me 의 '수집 중인 기기'에 이 기기($(hostname -s 2>/dev/null || hostname))가 보이면 정상입니다.
  · 언제든 직접 실행:  $RUNNER
  · 제거 방법·문제 해결:  $DASHBOARD_URL/setup

DONE
`;
}
