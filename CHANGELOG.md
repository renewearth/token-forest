# Changelog

Notable changes to token-forest. Follows [Keep a Changelog](https://keepachangelog.com)
and [Semantic Versioning](https://semver.org). Policy: [VERSIONING.md](./VERSIONING.md).

## [1.2.0] — 2026-10-13

성장 규칙과 숲 표시를 다시 짠 개편. 1.1은 팀 공지로만 나갔고 이 문서와 태그에는 남기지 않았다.

### 수집
- Claude 일별 지출 보고서의 사용량(웹·앱 대화, Cowork 등)을 사용량 합계와 그래프에 반영. Claude Code는 사람·날짜마다 업로더 기록과 보고서 중 큰 쪽만 센다.
- 업로더 0.4.2: Claude Code 세션에 조직 표시, 쓰지 않은 날의 OpenCode를 고장으로 보고하던 문제와 줄 구분 문자(U+2028·U+2029)가 든 줄을 잘라 읽던 문제 수정.

### 나무 성장 (GP)
- 사용 보너스를 사용량 단계 + 모델 계열 다양성으로 교체(하루 최대 5). 모든 수집 도구와 일별 보고서를 합쳐서 본다.
- 성장 기준일을 구성원별 가입일에서 팀 시작일로 통일.
- 나무 단계 경계를 0 / 100 / 400 / 1,000 / 2,200 / 4,500 GP로 확대.
- 레벨에 필요한 GP를 `10 × (L−1)²`로 변경 — 올라갈수록 간격이 넓어진다.

### 숲
- 장식을 누적 달성 전부에서 요즘 상태로 변경: 연속·최근 활동·사용 보너스·도구 네 종류가 하나씩, 한 그루에 최대 4개.

### 팀 분석
- 팀 지표를 성장 점수와 같은 세 축(쓴 날 수·사용량 단계·모델 계열 수)의 주간 중간값으로 교체.

## [1.0.0] — 2026-08-08

First stable release. Deployed at `app.carbonlink.world`, in daily team use. Baseline
that consolidates all work shipped under the untracked `0.1.0`.

### 수집
- 팀 AI 툴 사용량 수집: Cursor·OpenAI·Copilot 서버 폴러 + Claude Code·Codex 로컬 업로더.
- Codex CLI 토큰 수집·성장 반영, `/me` 연결 체크리스트 행, openai/codex 중복집계 가드.
- KST 집계 타이밍, machineId 익명화.

### 나무 성장 (GP)
- 성장 엔진: 활동일·스트릭·툴 다양성 + 효율 보너스(볼륨 중립).
- 효율 보너스를 캐시히트율에서 **컨텍스트 수율**(`output/cacheCreation`) 밴드로 교체 — 밀도 기반, 전 기간 소급 재계산.

### 노하우 공유 (`/knowhow`)
- 인앱 작성(글/링크, 본인 편집·삭제) + 인제스트 API(`POST /api/knowhow`, Claude 생성 글 주입).
- 리액션(고정 이모지), react-markdown + GFM 표 렌더, 인라인 접기/펼치기, 글별 공유 딥링크.

### 운영
- 소유자 renewearth 이관, Coolify 배포.

[1.2.0]: https://github.com/renewearth/token-forest/releases/tag/v1.2.0
[1.0.0]: https://github.com/renewearth/token-forest/releases/tag/v1.0.0
