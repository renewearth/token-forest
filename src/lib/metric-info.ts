// 지표 툴팁 단일 소스 — 의미·목표·추세. /me·/team 공유.
// trend: "up"=높을수록/우상향 목표, "down"=낮을수록, "none"=무방향(목표값 없음).

export type MetricInfo = {
  label: string;
  meaning: string;
  target: string;
  trend: "up" | "down" | "none";
};

export const METRIC_INFO: Record<string, MetricInfo> = {
  cacheReuse: {
    label: "캐시 재사용 배율",
    meaning: "캐시에 적재한 토큰이 몇 번 재사용됐나 (cacheRead/cacheCreation).",
    target: "작업과 캐시 구조에 따라 달라지는 사용 특성입니다. 개인별 목표값을 두지 않습니다.",
    trend: "none",
  },
  contextYield: {
    label: "컨텍스트 수율",
    meaning: "새로 끌어온 컨텍스트 대비 생성량 (output/cacheCreation).",
    target: "생성 토큰과 캐시 쓰기의 비율입니다. 출력의 품질이나 업무 성과를 측정하지 않습니다.",
    trend: "none",
  },
  cacheSavings: {
    label: "캐시 절감률",
    meaning: "캐시가 없었을 경우 대비 아낀 가중 자원 비율.",
    target: "공개 단가로 환산한 상대치입니다. 실제 청구 비용이나 개인 역량의 척도가 아닙니다.",
    trend: "none",
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
    target: "세션의 대화 길이입니다. 길거나 짧다는 사실만으로 작업의 깊이·성공 여부를 판단하지 않습니다.",
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
    target: "도구 사용 분포입니다. 여러 도구를 사용할 목표를 두지 않습니다.",
    trend: "none",
  },
  modelBreadth: {
    label: "모델 다양성",
    meaning: "사용량 가중 모델 분산 (0=단일 모델, 1=완전 균등).",
    target: "모델 사용 분포입니다. 모델 수를 늘릴 목표를 두지 않습니다.",
    trend: "none",
  },
  streak: {
    label: "스트릭",
    meaning: "연속 활동일. 주말·공휴일은 쉬어도 유지되고, 끊겨도 유예창 안에 돌아오면 되살아납니다.",
    target: "기존 게임의 연속 기록입니다. 개인 일정·수집 누락·업무 성과를 평가하지 않습니다.",
    trend: "none",
  },
};
