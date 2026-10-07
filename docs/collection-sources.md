# 도구별 수집 운영

2026-10-07 구현. 코드 지원과 실제 계정 연결은 다르다. `/collection`은 도구별 경로·조건과 수신 보고서를 보여준다. 계정 키가 없는 상태를 0 사용으로 표시하지 않는다.

업로더 v4는 각 수치의 확인 근거를 함께 보낸다. 근거 없는 구버전 세션의 0은 unknown으로 유지하며 같은 버전으로 다시 보내도 확인값으로 바꾸지 않는다. 원천에서 확인된 0은 known으로 명시하여 보존한다. 과거 저장 자료를 일괄 수정하지는 않는다.

## 공식 보고서 가져오기

Claude Analytics의 Export spend report CSV를 사용한다. 계정은 조직을 식별하는 비밀 아닌 ID, 기간은 내보내기에서 선택한 범위, 시간대는 보고서의 실제 기준을 입력한다. `full`은 전체 사용량임을 확인했을 때만 선택하며 좌석형 플랜의 초과 과금 자료는 `overage`, 미확인은 `unknown`이다. API 접근과 CSV 내보내기 권한은 별개다. Analytics API는 Enterprise Primary Owner 활성화와 read:analytics 권한이 필요하다.

```sh
# 검증만. DB에 연결하거나 자료를 저장하지 않는다.
npx tsx src/scripts/import-usage-report.ts --file ./claude.csv --account company-workspace --from 2026-10-01 --to 2026-10-06 --timezone UTC --coverage unknown
# 검증된 보고서는 같은 명령에 --write를 추가해 저장한다. MONGODB_URI는 운영자가 명시한다.
```

필수 열: `product`, `model`, `total_requests`, `total_prompt_tokens`, `total_completion_tokens`, 그리고 `email` 또는 `account_uuid`. 이메일 별칭 `user_email`, `User's email`, `User email`도 받는다. `total_net_spend_usd`는 선택이다. 실제 CSV의 열 이름이 다르면 임의 변환하지 말고 원천 스키마와 대조한다. 빈 수치는 미제공으로 남고 명시적 0은 보존한다. 쉼표·줄바꿈·따옴표를 CSV 규칙대로 처리하며 형식 오류·중복 키는 저장 전에 거부한다.

기간 보고서는 그대로 저장한다. 같은 원천·계정·제품·사용자·모델·기간·시간대·포함 범위 자료를 다시 가져오면 교체한다. 다른 기간/포함 범위는 별도 자료로 남으며 서로 더하지 않는다. 내용·코드·전체 raw 응답은 저장하지 않는다.

## Copilot

`COPILOT_BILLING_SCOPE`는 `personal` 또는 `organization`으로 명시한다. 선택하지 않은 범위의 자격증명은 읽지 않는다. `COPILOT_BILLING_MODE`를 실제 플랜에 따라 `ai_credits` 또는 `premium_requests`로 설정한다. 새 AI credit 과금과 기존 연간 플랜 premium request는 서로 다른 단위다. 사용자별로 과금 방식이 섞이면 별도 실행 환경으로 대조해야 하며 자동 추정하지 않는다.

- 개인 청구: 기존 구성원의 암호화 PAT와 GitHub 식별자를 사용한다. 조직에서 청구하는 라이선스를 이 경로로 수집할 수 있다고 가정하지 않는다.
- 조직 청구: `COPILOT_BILLING_ORG`, `COPILOT_BILLING_ORG_TOKEN`. 조직 billing 읽기 권한 필요.
- `year/month/day`로 실제 UTC 사용일을 조회한다. API 실패 시 성공 커서를 남기지 않는다. 정상적인 빈 날과 일부 측정값이 함께 있으면 partial로 표시하고 다음 실행도 설정된 전체 창을 재조회한다.
- 과거 잘못 저장된 Copilot poller 요청 수는 원본을 지우지 않고 요청 집계에서 제외한다. 월 증분으로 남은 과거 날짜를 자동 재배치하지 않는다.

## Gemini Workspace

`GEMINI_WORKSPACE_CUSTOMER_ID`는 실제 customer ID다(`my_customer` 같은 별칭 대신 응답 범위와 대조할 ID). `GEMINI_WORKSPACE_ACCESS_TOKEN`은 Admin Reports `admin.reports.audit.readonly` 권한을 갖춘 OAuth 토큰이다. 토큰 갱신은 운영자가 관리해야 하며 만료 시 명시적으로 실패한다. 회사 플랜·관리자 접근은 아직 확인되지 않았다.

`gemini_in_workspace_apps`의 `feature_utilization` 중 active_conversations/generate/summarize/unspecified만 UTC 일별 `active_uses`에 기록한다. inactive/unknown은 제외한다. 이벤트 ID 중복 제거와 페이지 순회를 사용한다. 수치는 모델 호출·토큰이 아니며 자동 환산하지 않는다. 보고 지연과 새 계정 연결을 위해 설정된 전체 수집창을 매번 다시 조회한다(기본 최근 30일, TOKEN_FOREST_BACKFILL_START 설정 시 그 날짜부터). 큰 보고서는 짧은 기간으로 나눠 조회한다.

## 주 수집원과 알려진 한계

- 신규 웹·앱/과금 보고서는 `usagereportsnapshots`에만 보존하며 기존 토큰 그래프가 읽지 않는다. 같은 사용량이 로컬·공식 보고서 양쪽에 있어도 합계가 늘지 않는다.
- 기존 UsageDaily 우선순위는 동일 도구·외부ID·모델·일자 안에서만 작동한다. 다른 계정, UTC/KST, 제품 범위를 해결하는 일반 중복 제거가 아니다. 같은 계정에는 주 수집원 하나를 연결하고 보완 자료는 별도 보고서 경로를 쓴다.
- OpenAI 직접 API 커넥터는 원래 구현이 없었다. ChatGPT/Work/Codex 클라우드도 실제 enabled workspace API 스키마를 받은 후 구현한다.
- Claude 웹 API는 관리자 접근만으로 가능하지 않다. 사용자 확인: Claude 관리자 접근 가능, Enterprise 기능 제한. 실제 플랜과 내보내기 가능 범위는 확인 전이다.
- 프롬프트/응답 수집, 브라우저 확장 수집, 계정 자동 변경은 범위 밖이다. OTel은 선택적 보완 후보이며 현재 경로를 대체하지 않는다.

## 근거

- [Claude 보고서/Analytics 권한](https://support.claude.com/en/articles/12883420-view-usage-analytics-for-team-and-enterprise-plans)
- [GitHub billing usage](https://docs.github.com/en/rest/billing/usage)
- [Gemini 활동 항목](https://developers.google.com/workspace/admin/reports/v1/appendix/activity/gemini-in-workspace-apps)
- [Workspace activities.list](https://developers.google.com/workspace/admin/reports/reference/rest/v1/activities/list)
- [ChatGPT workspace analytics](https://learn.chatgpt.com/docs/enterprise/analytics-api)

정정된 보고서는 동일 수집 범위의 원자적 스냅샷으로 교체한다. 사라진 모델/사용자 행을 남기지 않으며, 정상적인 빈 API 응답은 빈 범위를 저장하되 사용량 0이나 최신 사용 증거를 만들지 않는다. 빈 날이 섞인 조회는 partial, 전체가 비었으면 empty로 기록한다. 조회가 끝난 날짜와 실제 측정값이 있는 날짜를 분리하며, 빈 날 때문에 정상적인 다음 수집이 멈추지 않는다. 웹 화면은 본인 이메일 또는 본인의 개인 Copilot 식별자에 연결된 행만 조회한다. 조직 과금 합계는 운영자 자료로 남기며 일반 구성원에게 공개하지 않는다.

Copilot·Gemini 보고서 수집은 증분 커서를 시작점으로 쓰지 않고 설정된 전체 수집창을 매번 조회한다. 새 개인 계정도 기존 사람의 커서를 상속하지 않는다. 요청 수를 줄이는 것보다 수집창 안의 누락·정정 반영을 우선한 선택이며, 규모가 커지면 계정별 조회 체크포인트로 확장한다. 설정 창 이전 자료와 원천 API 보존 기간 밖의 지연 자료는 보장하지 않는다. 실제 API 오류만 재시도 시작점을 고정한다.
