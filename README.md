# token-forest

팀 구성원의 AI 툴(Cursor, Claude Code, Codex, Copilot, …) 토큰 사용량을
통합 형식으로 수집·추적하는 셀프호스트 대시보드. 목적은 **팀이 AI를 얼마나, 어떻게 사용하는지 쉽게 보여주는 것**이다. 사용량만으로 역량·성과·AX 단계를 평가하지 않는다.

> Self-hostable, Apache-2.0. 한 조직 = 한 배포(멀티테넌시 없음). 각자 자기 인프라에서
> 돌리며, 사용량 데이터는 자기 DB를 벗어나지 않는다.

## 아키텍처

```
[Cursor Admin API]  ┐
[Anthropic Admin]   ├─ 폴러 (in-process cron, 매 정시) ───────┐
[Gemini Workspace] │                                         ├─→ MongoDB ─→ 웹 대시보드
[GitHub billing]   ┘                                         │        └──→ Slack 주간 리포트 (월 09:30 KST)
[로컬 업로더 CLI (Claude Code·Codex·Gemini·Grok·opencode)] ─┐   │
[수동 입력 폼 / CSV 임포트]                                 ─┴─ POST /api/ingest ┘
   (업로더는 세션 단위로 전송 — 서버가 필드별 최댓값으로 병합)
```

- 폴러·수동 입력 경로는 동일한 `UsageRow[]` 형식(`src/lib/types.ts`)으로
  `(date, tool, model, external_id)` 키에 **일일 총량을 멱등 upsert**한다.
- 업로더는 **세션 단위**로 보낸다(수집 v2). 서버는 같은 세션을 **필드별 최댓값으로
  병합**하므로, 여러 기기나 동기화로 복제된 세션도 한 번만 집계되고 겹치게 다시
  보내도 합계가 부풀지 않는다. 일 단위 합계는 세션에서 읽을 때 계산한다.
- `tool`은 자유 문자열 — 신규 툴은 스키마 변경 없이 추가된다.
- Copilot 과금량과 웹·앱 보고서는 `UsageReportRow[]`로 별도 보관한다. 토큰·호출 수 그래프에 자동 합산하지 않는다.
- 누락 지표는 null, 원천의 0은 0으로 유지하며 `fieldEvidence`와 일자 기준을 함께 보존한다. `/collection`에서 도구별 범위와 받은 보고서를 확인한다.
- 구성원 온보딩은 `/me`의 단계형 마법사가 안내(도구 선택 → 자동 연결 → 업로더 설치
  자동 감지). 완료 후엔 체크리스트로 전환, `/me?step=claude_code`로 단계 단독 재실행.
- 홈과 팀 분석은 **구성원별 사용 흐름·도구별 누적·전체 합계선**을 함께 제공한다. 범례의 사람 선택은 합계를 바꾸지 않는다.
- 홈 상단에 기존 성장형 숲(시간대별 배경·나무 단계·레벨·연속 기록·장식·동물)을 표시한다. 배치는 순위가 아니며 종합 성숙도 단계는 제공하지 않는다. 개인 게임 상세는 `/me`에서 펼쳐 본다.
- `/knowhow`의 업무 실험은 초안에서 시작해 공개 대상을 확인한 뒤 공유한다. 악화·판단 유보·중단과 타인의 적용 후기도 기록할 수 있다.

## 시작하기

```bash
pnpm install
cp .env.example .env   # MONGODB_URI·키 채우기 (없는 커넥터는 비워두면 비활성)
pnpm dev               # 대시보드 http://localhost:3100 (PORT env로 변경 가능)
```

### 포트

기본 개발 포트는 `3100`(`pnpm dev`, `PORT` env로 변경). Docker 배포는 `PORT`
env(예: 4700)로 서빙한다 — 아래 [배포](#배포-docker) 참고.

### 구성원 등록

```bash
pnpm member add --name "김OO" --email kim@example.com
# → ingest 토큰이 1회 출력됨 (업로더 CLI 사용자에게 전달)

# 툴별 ID 매핑 (커넥터가 주는 사용자 식별자 → 구성원)
pnpm member identity --email kim@example.com --tool cursor --external-id kim@example.com
pnpm member identity --email kim@example.com --tool copilot --external-id kim-github

# Copilot 개인 계정: "Plan: read" 권한 GitHub 토큰 등록
pnpm member github-token --email kim@example.com --token ghp_xxx
```

### 수동 동기화 / 리포트

```bash
pnpm sync                          # 전체 커넥터 증분 동기화
pnpm sync --tool cursor --since 2026-07-01   # 특정 툴 백필
pnpm report --dry-run              # 주간 슬랙 리포트 미리보기
```

## 구성원 온보딩 (셀프서비스)

구성원은 `app.<도메인>`으로 대시보드에 접속하면 신원인지 프록시(oauth2-proxy, Google
로그인)가 자동 식별하고, **`/me`(내 사용량)**에서 프로필 생성 → 연결 체크리스트를
스스로 완주한다. 관리자 개입 불필요:

1. 신원인지 프록시(oauth2-proxy)로 대시보드에 접속 → **회사 이메일로 로그인** →
   대시보드 접속 (프록시 구성은 아래 [배포](#배포-docker) 참고)
2. `/me`에서 프로필 생성(토큰 자동 발급)
3. 체크리스트 항목별 "연결": Claude Code는 표시된 한 줄 명령(`curl …/install.sh | bash -s -- 토큰`)을
   터미널에 붙여넣기(자동 예약·SessionEnd 훅까지 설정됨 — [설치 안내](/setup)), Copilot은
   GitHub PAT("Plan: read") 붙여넣기, 미매핑 기록은 "내 기록입니다" 클레임

> **VPN 없이 업로드 (권장 경로)**: 위 1번(신원인지 프록시)은 대시보드를 **브라우저로
> 볼 때만** 필요하다. 사용량 **업로드**는 공개 수집 엔드포인트로 이뤄지므로 VPN이
> 필요 없다 — 관리자가 `pnpm member add`로 발급한 설치 명령 한 줄
> (`curl https://<your-ingest-host>/install.sh | bash -s -- tmk_...`)을 받아 실행하면
> 끝이다. 상세는 아래 [배포](#배포-docker) 참고.

### 수집 커버리지 (Claude 계열은 Team 플랜 기준)

| 사용 형태 | 수집 | 경로 |
|---|---|---|
| Cursor 팀 | 지원 | 서버 폴러 — 관리자 키 필요 |
| OpenAI 직접 API | 미구현 | 기존 문서에만 있던 지원 표기를 정정. 공유 서비스 귀속·중복 범위 확인 후 추가 |
| Claude Code CLI·데스크톱 앱 (로컬 세션) | ✅ | 업로더 (세션 단위) |
| Codex CLI · Gemini CLI · Grok API 래퍼 | 지원 | 업로더 (로컬 세션 로그). Grok 웹 일반 수집 아님 |
| opencode (Copilot Pro+ 등 연결한 모든 공급자 포함) | ✅ | 업로더 — 로컬 `opencode.db`를 읽기 전용으로 조회 |
| 여러 기기 | ✅ | **모든 기기에 업로더 설치 권장.** 세션 단위 중복 제거라 같은 세션이 여러 기기에서 잡혀도 한 번만 집계 |
| 폰 Remote Control | ✅ | 세션이 도는 호스트 머신의 업로더 |
| Claude Code 웹 클라우드 세션 | ⚠️ | 로컬로 이어받은 세션만 |
| claude.ai 채팅·Cowork | 공식 CSV 가져오기 준비 | Enterprise API는 Primary Owner 활성화·권한 확인 필요. 전체/초과분·기간을 별도로 보존 |
| ChatGPT·Work·Codex 클라우드 | 미연결 | 실제 워크스페이스 Analytics API 스키마/권한 확인 필요 |
| Gemini 웹·Workspace | 활동 API 경로 준비 | 관리자 OAuth 필요. 능동 기능 사용만, 토큰 미제공 |
| Copilot 개인/조직 | 과금 보고서 | 개인은 /me PAT, 조직은 별도 billing 권한. AI credit/legacy 방식 지정 |

**중복 방지**: 업로더끼리는 세션 단위로 병합된다(위 표). 기존 일별 수집의 소스 우선순위(poller > uploader > manual)는 같은 도구·외부 ID·날짜·모델에만 적용된다. 서로 다른 계정·시간대의 동일성을 보장하지 않으므로 한 계정에 주 수집원 하나를 정한다. 신규 공식 보고서는 별도 보관하고 주 수집원 확정 전 자동 합산하지 않는다. `claude_limits`는 %지표라 사용량 합계에서 항상 제외.

**개인 계정 제외 (수집 경계 = 프로필)**: 사용량 스캔·다이제스트 재료는
**기본 프로필(`~/.claude`)만** 대상이다. 개인 계정을 별도
`CLAUDE_CONFIG_DIR` 프로필로 쓰면 그 사용량·작업 기록은 회사 집계에 포함되지
않는다(제외가 기본값). 개인 플랜의 한도 게이지만 원하면 `claudeDirs`에 그
프로필을 추가한다 — 한도 추적과 사용량 수집은 독립. 단, 같은 프로필에서
`/login` 전환으로 계정을 오가면 세션 기록에 계정 구분이 없어 분리 불가 —
반드시 프로필을 나눠야 한다.

### 일일 다이제스트 — ⛔ 폐기 (2026-07-20)

실험적 기능으로 판단되어 종료했다. 현재 `/api/digest`는 **410 Gone**을 반환하고,
업로더는 초안을 만들지 않으며(`config.mjs`의 `digest: false`), `/me`·`/team`에서
노출이 제거됐다. 설치된 구 업로더는 재료 수집·`claude -p` 호출 **이전에** 서버를
먼저 확인하므로, 410을 받으면 즉시 중단한다 — 구성원 Claude 한도를 소모하지 않는다.

코드 자산(`packages/uploader/src/digest.mjs`, `src/app/me/DigestCard.tsx`,
다이제스트 쿼리·모델·Slack 전송)과 기존 `digests` 데이터는 **삭제하지 않고 보존**했다.
필요 시 되살릴 수 있다.

이로써 서버로 나가는 데이터는 다시 **토큰 수(및 한도 %)뿐**이다.

### 업로더 (요약)

- **수집 창**: 마지막 성공 이후 바뀐 파일만 + **주 1회 전체 재전송**. 첫 실행은 로컬
  로그 전체 백필. 지금 전부 다시 보내려면 `--full`. 기기에 이름을 붙이려면
  `--device-label <이름>`(본인 `/me`에만 표시). 상태 폴더는 `TOKEN_FOREST_STATE_DIR`.
- 동시에 한 번에 하나만 실행(run lock). 보낼 세션이 없어도 기기 생존 신호(heartbeat)를
  보낸다. **구 서버**가 v2 형식을 거부하면 v1(일 단위) 형식으로 자동 전환한다.
- 옵션·환경변수 전체는 [`packages/uploader/README.md`](packages/uploader/README.md).

### `/me` 기기 표

기기별 이름표(`--device-label`), 마지막 업로드·마지막 수집일, 상태 경고를 보여준다.
**24시간 넘게 업로드가 없으면** 경고 배지가 붙고, 파서가 로그 형식을 못 읽거나
건너뛴 경우 파서 경고가 표시된다.

### 한도 게이지 (Claude·Codex)

한도는 사용량 합계와 별개 축(%)이다. Codex는 **5시간/주간** 창을 기기별로 보여준다
(Codex 로그인이 기기마다 다르기 때문). Claude는 계정별.

### 단가표 `/pricing`과 단위 전환

- `/pricing`: 모델 계열별 **공개 단가표**. 구성원 누구나 등록하되 **출처 URL(https)
  필수**. 계열은 버전별 단가를 가지며(과거 사용량엔 그 시점 단가 적용), 사용량이
  있는데 단가가 없는 모델은 **"단가 미정" 목록**에 뜬다.
- 등록 규칙: 기존 계열에 버전을 더하면 매칭 패턴을 그대로 상속한다. 새 계열은 패턴을
  직접 지정한다 — 부분 일치는 **3자 이상**, 정확히 일치는 `=이름`.
- 사용량 화면(`/`·`/me`·`/members`·구성원 상세·`/team`)에서 **집계 기준**과 **표시 단위**를 독립적으로 선택한다. 카드·차트·표에 같은 선택을 적용한다.
  - `basis=all` **전체 처리량(기본)**: 일반 입력 + 캐시 읽기 + 캐시 쓰기 + 출력
  - `basis=no-cache-read` **캐시 읽기 제외**: 일반 입력 + 캐시 쓰기 + 출력
  - `basis=output` **출력량**: 출력만
  - `basis=legacy` **기존 기준**: 일반 입력 + 출력
  - `basis=requests` **요청 수**: 수집된 요청 건수. 표시 단위는 항상 `건`이며 가격 환산하지 않는다.
  - `unit=raw` 토큰, `unit=usd` API 정가 환산 $, `unit=ref&ref=<계열>` 기준 모델 환산 토큰.
  - 모든 단위는 선택된 토큰 항목만 계산한다. 달러는 **실제 지출이 아닌 공개 단가 환산**이며, 기준 모델 토큰은 종류별 토큰 × 모델 단가 ÷ 기준 단가다.
  - `basis`·`unit`·`ref`·`days`는 기간 전환과 사용량 화면 이동 시 URL에 유지된다. 예: `/?basis=no-cache-read&unit=usd&days=7`.
  - 네 토큰 항목은 저장된 값을 그대로 두고 조회 때 계산한다. 누락 항목은 관측 상태로 구분하고 유효한 부분만 합산한다. 전부 미확인이면 `—`이며, 모든 항목이 미환산이면 환산값도 `—`다. 단가 미정은 선택된 항목의 원본 토큰으로 안내한다. 상세 표의 네 항목은 환산 전 토큰이다.
  - 표시 선택은 개인의 기존 성장 계산과 계정 한도 값을 바꾸지 않는다. 종합 성숙도 단계는 표시하지 않는다.
  - heartbeat는 과거 수집 완료 증거가 아니다. 실제 사용량 0과 미확인을 구분하며, 소스의 일자 기준(KST/UTC/미확인)을 함께 읽어야 한다.

### 관리자: 롤아웃·대사

- **롤아웃**: 서버를 먼저 배포한 뒤 업로더를 재설치한다. 구 업로더는 그대로 동작한다
  (v1 형식으로 계속 수집).
- `pnpm compare-sessions -- --member <email>`: 세션(v2)과 구 일 단위(legacy) 합계를
  도구 × 기기 × 날짜로 비교(읽기 전용, 5초 대기 후 조회).
- `node packages/uploader/src/scripts/audit-local.mjs`: 세션화 없이 이 기기 로컬 로그를
  도구 × 날짜로 독립 집계(읽기 전용, 숫자만 출력) — 서버 값과 대조용.

## 데이터 소스 (커넥터)

| tool | 소스 | 단위 | env |
|---|---|---|---|
| `cursor` | Admin API `daily-usage-data`(활동) + `filtered-usage-events`(모델별 토큰·비용) | 토큰+요청 | `CURSOR_API_KEY` |
| `claude_code` | Anthropic `usage_report/claude_code` (조직) **또는** 로컬 업로더 (개인) — 한도는 계정별(1:N), 여러 계정 동시 추적은 업로더 `--claude-dir` | 토큰+세션 | `ANTHROPIC_ADMIN_KEY` |
| OpenAI | 미구현 (워크스페이스 스키마/권한 확인 필요) | 확인 전 | 없음 |
| `copilot` | 개인/조직 `ai_credit/usage` 또는 `premium_request/usage`의 day 조회 | 과금 단위 · 별도 보고서 | `COPILOT_BILLING_MODE`, 개인 암호화 PAT 또는 조직 환경 설정 |
| `gemini_workspace` | Admin Reports `gemini_in_workspace_apps` 활동 | 능동 기능 사용 건수 · 별도 보고서 | `GEMINI_WORKSPACE_CUSTOMER_ID`, `GEMINI_WORKSPACE_ACCESS_TOKEN` |

> **주의**: 같은 사람이 Claude **조직** 계정(Anthropic 폴러)과 **개인** 업로더를 동시에 쓰면
> 같은 `(날짜, claude_code, 모델, 이메일)` 키에 서로 덮어쓴다. 한 사람당 한 경로만 사용할 것
> (조직 계정이면 업로더 불필요).

### 커넥터 추가하기 (OpenCode, Alibaba Cloud, …)

1. `src/connectors/<tool>.ts`에서 `Connector`(`src/connectors/types.ts`) 구현 —
   `fetchDaily(since)`가 일일 총량 `UsageRow[]` 반환
2. `src/connectors/index.ts` 레지스트리에 한 줄 등록

중앙 API가 없는 툴은 커넥터 대신 업로더 파서(`packages/uploader/src/parsers/`)나
수동 입력으로 커버한다.

## 성장형 메뉴바 (선택)

각 구성원은 macOS 메뉴바에서 자기 사용량을 **숲 성장** 게임으로 볼 수 있다. 서버가
크로스기기 집계에서 성장 포인트를 계산하므로 어느 기기에서 열어도 같은 나무다.

- 서버 엔드포인트: `GET /api/me/summary`(본인 `tmk_` 토큰 인증, 개인 데이터만).
- 기존 성장 규칙: 활동일·연속 기록에 게임 보너스를 더한다. 보너스에는 출력/캐시 쓰기와 도구 수, 복구에는 요청 수·출력량 조건이 있어 사용량과 완전히 무관하지 않다. 업무 성과 평가가 아니다. 엔진은 `src/lib/growth.ts`, 검증은 `src/scripts/verify-growth.ts`이며 이번 변경은 기존 계산·개인 summary API를 유지한다.

### 네이티브 앱 (macOS, 권장)

메뉴바 아이콘이 자기 스테이지 나무(+스트릭 🔥)를 보여주고, 클릭하면 밤낮·sway·동물이
있는 미니 장면과 GP 게이지, API 리밋 게이지, "숲 열기" 버튼이 뜬다.

**요구사항:** macOS 14+, 그리고 [uploader](#구성원-온보딩-셀프서비스)가 먼저 설치되어
있어야 한다 — 앱은 uploader가 만든 `~/.config/token-forest/config.json`을 그대로
재사용한다(추가 설정 없음).

**설치 (한 줄):**

```bash
curl -fsSL https://raw.githubusercontent.com/renewearth/token-forest/main/clients/macos/install.sh | bash
```

**미서명 앱 안내:** 이 앱은 Apple 개발자 서명이 없다(애드혹 서명만). 위 설치 스크립트는
`curl`로 받기 때문에 quarantine 속성이 붙지 않아 Gatekeeper 마찰 없이 바로 실행된다.
대신 브라우저로 릴리스의 `TokenForest.zip`을 직접 받아 설치한 경우 macOS가 실행을
막을 수 있다 — 이때는 **시스템 설정 → 개인정보 보호 및 보안**에서 "그래도 열기"를
눌러 실행을 허용한다.

**선택 설정:** 대시보드가 수집 서버와 다른 주소에 있다면 config.json에
`"dashboardUrl": "https://app.example.com"` 키를 추가한다(미설정 시 `serverUrl`로
폴백) — "숲 열기" 버튼이 이 주소를 연다.

### 경량 대안 (비macOS·xbar 사용자)

- 클라이언트: `clients/xbar/`(xbar/SwiftBar 플러그인, macOS/Linux 겸용). 설치는 그
  폴더 README 참고.

## 배포 (Docker)

```bash
cp .env.example .env   # 운영 키 입력
docker compose up -d --build
```

- compose가 **앱 + MongoDB**를 함께 띄운다. 앱은 compose 네트워크의
  `mongodb://mongo:27017/token-meter`에 붙고, 같은 DB가 호스트 루프백
  `127.0.0.1:27201`로도 공개돼 관리 CLI·백업이 접근한다. 앱 포트(4700)도
  루프백으로만 publish — 외부 노출은 항상 리버스프록시가 담당.
- **Coolify 배포**: 이 저장소를 Docker Compose 리소스로 등록하면 FQDN 지정·TLS
  (Let's Encrypt)·Traefik 라우팅이 자동이다. env는 Coolify UI에서 입력. Coolify는 compose
  리소스에서 서비스별로 Domains 필드를 따로 갖는다 — `https://app.carbonlink.world:4180`은
  반드시 **`dashboard-auth` 서비스의 Domains 필드**에 등록한다(공백 없이!). `token-forest`
  서비스에 붙이면 oauth2-proxy를 우회해 대시보드가 인증 없이 그대로 노출된다. env에는
  `OAUTH2_PROXY_CLIENT_ID`·`OAUTH2_PROXY_CLIENT_SECRET`·`OAUTH2_PROXY_COOKIE_SECRET`과
  `TOKEN_FOREST_IDENTITY_HEADER`·`TOKEN_FOREST_TRUST_IDENTITY_HEADERS`도 포함해야 한다.
- **대시보드 (`app.<도메인>`)**: oauth2-proxy(Google 로그인)가 앞단이다. compose의
  `dashboard-auth` 서비스가 인증 후 `X-Forwarded-Email`을 주입하고, 앱은
  `TOKEN_FOREST_IDENTITY_HEADER=x-forwarded-email` + `TOKEN_FOREST_TRUST_IDENTITY_HEADERS=1`로
  그 헤더를 신뢰한다. 다른 프록시(Authelia·Cloudflare Access·tailscale serve)도 이메일
  주입 헤더명만 맞추면 동작한다. **주의: 신뢰를 켜기 전에 프록시가 클라이언트가 보낸
  동명 헤더를 덮어쓰는지 확인할 것** — 그렇지 않으면 위조 가능하다. 검증:
  `scripts/verify-app-auth.sh`.
- 사용량 **수집 엔드포인트**는 공개 HTTPS로 노출할 수 있다 — 멤버가 VPN 없이
  업로드. 리버스프록시(Traefik 등)의 경로 화이트리스트로 `/api/ingest`·`/api/limits`·
  `/install.sh`·`/uploader.tgz`·`/api/me/summary` **5경로만** 통과시키고 나머지는
  차단한다(실제 인증은 앱의 `tmk_` 토큰이 담당). 화이트리스트는 **앱 내장
  미들웨어**(`src/middleware.ts`)가 수행한다 — env `INGEST_HOST=<공개 호스트>`만
  설정하면 그 호스트로 들어온 요청이 5경로 외 전부 403이 되고, 미설정 시 비활성.
  프록시 종류와 무관하게 동작한다. 검증:
  `HOST=<공개 호스트> bash scripts/verify-ingest-tunnel.sh`.
- cron(동기화·슬랙 리포트)은 서버 프로세스에 내장.
- 구성원 등록 등 관리 CLI는 호스트에서 `.env`의 URI로 실행하면 된다 (`pnpm member ...`).

### 기존 호스트 Mongo에서 이관

기존에 별도 MongoDB를 쓰고 있었다면 1회 이관:

```bash
mongodump --uri mongodb://127.0.0.1:<구포트>/token-meter --archive=/tmp/tf.dump
docker compose up -d mongo   # 호스트 포트(27201)가 비어 있는지 먼저 확인
mongorestore --uri mongodb://127.0.0.1:27201 --archive=/tmp/tf.dump
```

### 백업

별도 자동 백업이 없다면 주기적으로 mongodump를 권장:

```bash
mongodump --uri mongodb://127.0.0.1:27201/token-meter --archive=token-forest-$(date +%F).dump
```

`.env`의 `TOKEN_FOREST_SECRET`은 DB 백업과 **별도로** 안전하게 보관할 것 —
분실하면 구성원들의 암호화된 GitHub 토큰을 복호화할 수 없어 전원 재등록해야 한다.

## env

`.env.example` 참고. 필수: `TOKEN_FOREST_SECRET`(구성원 GitHub 토큰 암호화 키).
커넥터 키는 비워두면 해당 커넥터만 비활성화된다. `TOKEN_FOREST_DISABLE_CRON=1`로
내장 cron을 끌 수 있다(개발 시).


## 업무 실험의 공개 범위

- `TOKEN_FOREST_EXPERIMENTS_MODE=off|pilot|team` (기본 `off`): 새 실험 작성·공유의 활성화 범위.
- `TOKEN_FOREST_EXPERIMENTS_PILOT_IDS`: 쉼표로 구분한 등록 구성원 ID. 시범 공유 시 해당 목록을 고정 사본으로 저장한다.
- 시범 대상에 새 사람을 추가하거나 `team`으로 바꿔도 기존 글·후기를 자동 확대 공개하지 않는다. 원문과 후기의 작성자가 각각 다시 확인해야 한다.
- 비공개 초안과 철회한 글은 소유자만 읽는다. 기능을 꺼도 본인이 저장한 기록을 읽고 철회·삭제할 수 있다.
- 원문 수정과 후기 공유는 버전 검사를 거친다. 후기의 실제 적용 버전은 현재 원문의 버전으로 자동 덮어쓰지 않는다.
- 기존 일반 노하우와 `/api/knowhow` 자동 주입은 기존 경로를 사용한다. 실험 컬렉션을 갱신하거나 자동 공개하지 않는다.
- 실험·후기의 결과와 측정치는 자기 보고와 직접 측정을 구분하며, 개인 점수·작성률·조직 ROI로 합산하지 않는다.
