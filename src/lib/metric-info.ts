// 지표 툴팁 단일 소스 — 의미·목표·추세. /me·/team 공유.
// trend: "up"=높을수록/우상향 목표, "down"=낮을수록, "none"=무방향(목표값 없음).

export type MetricInfo = {
  label: string;
  meaning: string;
  target: string;
  trend: "up" | "down" | "none";
};

export const METRIC_INFO: Record<string, MetricInfo> = {
  cacheHit: {
    label: "캐시 적중률",
    meaning: "읽은 컨텍스트 중 캐시로 재사용한 비율.",
    target: "높을수록 좋음 (75%+ 정착권). 세션 이어가기·컨텍스트 재사용 습관이 올립니다.",
    trend: "up",
  },
  cacheReuse: {
    label: "캐시 재사용 배율",
    meaning: "캐시에 적재한 토큰이 몇 번 재사용됐나 (cacheRead/cacheCreation).",
    target: "높을수록 캐시 투자 회수가 좋음 — 새로 적재한 컨텍스트를 여러 번 재사용.",
    trend: "up",
  },
  contextYield: {
    label: "컨텍스트 수율",
    meaning: "새로 끌어온 컨텍스트 대비 생성량 (output/cacheCreation).",
    target: "높을수록 좋음 — 새로 읽힌 컨텍스트 1토큰당 더 많은 산출을 뽑아냄.",
    trend: "up",
  },
  cacheSavings: {
    label: "캐시 절감률",
    meaning: "캐시가 없었을 경우 대비 아낀 가중 자원 비율.",
    target: "높을수록 좋음. 달러가 아니라 모델 단가 가중 상대치입니다.",
    trend: "up",
  },
  premiumShare: {
    label: "프리미엄 모델 비중",
    meaning: "프리미엄(Opus/Fable급) 모델이 차지하는 토큰 비중.",
    target: "무방향 — 높다고 나쁜 게 아니라 작업 난이도의 반영일 수 있습니다.",
    trend: "none",
  },
  sessionDepth: {
    label: "세션 깊이",
    meaning: "세션당 에이전트 턴 수 (requests/sessions, Claude Code 한정).",
    target: "무방향 — 높으면 딥워크, 낮으면 잦은 확인. 작업 스타일이라 목표값이 없습니다.",
    trend: "none",
  },
  requestAnatomy: {
    label: "요청 해부",
    meaning: "요청 1건당 평균 구성 — 신규 입력·캐시 읽기·생성 토큰.",
    target: "무방향 — 에이전트 루프 1턴의 무게 구조를 보는 프로파일입니다.",
    trend: "none",
  },
  toolBreadth: {
    label: "도구 다양성",
    meaning: "사용량 가중 도구 분산 (0=단일 도구, 1=완전 균등).",
    target: "넓을수록 좋음 — 상황별로 맞는 도구를 골라 쓰는 성숙도.",
    trend: "up",
  },
  streak: {
    label: "스트릭",
    meaning: "연속 활동일 (주 1회 휴식 허용).",
    target: "꾸준할수록 좋음 — 습관 정착의 신호.",
    trend: "up",
  },
};
