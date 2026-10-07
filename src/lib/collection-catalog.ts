export type CollectionTool = { id: string; name: string; group: "개발 도구" | "웹·앱"; method: string; metrics: string; note: string; sourceId?: string };
export const COLLECTION_TOOLS: CollectionTool[] = [
  { id: "claude_code", name: "Claude Code", group: "개발 도구", method: "로컬 업로더 / Console 조직 API", metrics: "입력·출력·캐시 토큰, 관측된 호출·세션", note: "로컬 기록의 범위와 조직 보고서 범위를 대조합니다. 선택한 주 수집원만 합산합니다." },
  { id: "codex", name: "Codex 로컬", group: "개발 도구", method: "로컬 세션 업로더", metrics: "입력·출력·캐시 읽기, 관측된 모델 호출", note: "로컬 세션에 기록된 사용량입니다. 클라우드 실행은 별도 연결이 필요합니다." },
  { id: "cursor", name: "Cursor", group: "개발 도구", method: "팀 관리자 API · 매시간", metrics: "제공되는 토큰·요청", note: "사용 이벤트가 시간 단위로 제공됩니다. 과금 단위와 호출 수는 구분합니다." },
  { id: "opencode", name: "OpenCode", group: "개발 도구", method: "로컬 DB 읽기 전용 업로더", metrics: "제공되는 토큰·모델 호출", note: "모델 공급자는 도구와 별도 속성입니다. 같은 사용량을 공급자별로 다시 더하지 않습니다." },
  { id: "gemini", name: "Gemini CLI", group: "개발 도구", method: "로컬 세션 업로더", metrics: "제공되는 토큰·모델 호출", note: "공식 텔레메트리는 보완 후보입니다. 활성화할 때 프롬프트 기록을 꺼야 합니다." },
  { id: "grok", name: "Grok API 래퍼", group: "개발 도구", method: "지정 래퍼 사용량 로그", metrics: "입력·출력·API 호출", note: "grok-q/grok-web 래퍼에 한정됩니다. Grok 웹·앱 전체 사용량이 아닙니다." },
  { id: "copilot", name: "GitHub Copilot", group: "개발 도구", method: "개인 / 조직 일별 과금 API", metrics: "AI 크레딧 또는 프리미엄 요청 과금량", note: "플랜별 과금 방식을 선택해야 합니다. 토큰·실제 호출 수로 환산하지 않습니다.", sourceId: "github-copilot-billing" },
  { id: "claude_web", name: "Claude 웹·앱 / Cowork", group: "웹·앱", method: "공식 CSV 가져오기 · API는 권한 확인 후", metrics: "보고서가 제공하는 토큰·호출·비용", note: "Analytics API는 Enterprise의 Primary Owner가 활성화합니다. 관리자 접근만으로 API 사용 가능 여부를 판단하지 않습니다. 좌석형 보고서는 초과 사용분만 포함할 수 있습니다.", sourceId: "claude-spend-csv" },
  { id: "chatgpt", name: "ChatGPT / Work / Codex 클라우드", group: "웹·앱", method: "워크스페이스 Analytics API 확인 필요", metrics: "실제 제공 항목 확인 전", note: "플랜·API 활성화·관리자 권한·실제 응답 스키마를 확인해야 연결할 수 있습니다. 현재 자동 수집 경로가 없습니다." },
  { id: "gemini_workspace", name: "Gemini 웹·앱 / Workspace", group: "웹·앱", method: "Workspace 활동 보고서 API", metrics: "능동 기능 사용 건수 · 토큰 미제공", note: "관리자 읽기 권한과 OAuth 연결이 필요합니다. 보고는 2~3일 늦을 수 있으며 수동적 노출은 제외합니다.", sourceId: "gemini-workspace-activity" },
];
