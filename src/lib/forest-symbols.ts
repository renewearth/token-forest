import { ORNAMENT_CATALOG, STAGE_CATALOG } from "@/lib/growth";

// 숲 기호 프레젠테이션 조합(엔진 규칙 없음). 카탈로그가 단일 소스.

export type SymbolItem = { emoji: string; label: string; threshold?: number };
export type MilestoneAxisGroup = {
  axis: string;
  axisLabel: string;
  meaning: string;
  tiers: SymbolItem[];
};
export type StateSymbol = { emoji: string; label: string; meaning: string };

// 단계: 휴면(🌰, 활동 없음) + STAGE_CATALOG(발아~고목).
export const STAGE_LEGEND: SymbolItem[] = [
  { emoji: "🌰", label: "부화 전 씨앗" }, // threshold 없음 = 활동 전
  ...STAGE_CATALOG.map((s) => ({ emoji: s.emoji, label: s.label, threshold: s.minGp })),
];

// 장식은 요즘 상태다 — 축마다 지금 해당하는 가장 높은 단계 하나만 달린다.
export const ORNAMENT_NOTE = "장식은 요즘 상태를 보여줍니다. 종류마다 지금 해당하는 것 하나만 달리고, 사용이 줄면 내려가고 다시 쓰면 올라갑니다.";

const AXIS_META: Record<string, { axisLabel: string; meaning: string }> = {
  streak: { axisLabel: "연속", meaning: "지금 며칠째 이어 쓰고 있는지 (주말·공휴일은 유지, 끊겨도 되살리기 가능)" },
  recent_days: { axisLabel: "최근 활동", meaning: "최근 30일 중 AI를 쓴 날 수" },
  recent_bonus: { axisLabel: "사용 보너스", meaning: "최근 30일 중 사용 보너스 3점 이상인 날 수 — 숲에선 나무 광채도 함께 표시" },
  recent_tools: { axisLabel: "도구", meaning: "최근 30일에 쓴 AI 도구 종류 수" },
};
const AXIS_ORDER = ["streak", "recent_days", "recent_bonus", "recent_tools"];

export function ornamentGroups(): MilestoneAxisGroup[] {
  return AXIS_ORDER.map((axis) => ({
    axis,
    axisLabel: AXIS_META[axis].axisLabel,
    meaning: AXIS_META[axis].meaning,
    tiers: ORNAMENT_CATALOG.filter((m) => m.axis === axis).map((m) => ({
      emoji: m.emoji,
      label: m.label,
      threshold: m.threshold,
    })),
  }));
}

export const STATE_LEGEND: StateSymbol[] = [
  { emoji: "🔥", label: "스트릭", meaning: "N일 연속 활동 중 (🔥N)" },
  { emoji: "🟠", label: "불씨", meaning: "끊긴 스트릭 — 유예창 안에 돌아오면 되살아남 (🟠N)" },
  { emoji: "🎟️", label: "복구 토큰", meaning: "못 돌아온 스트릭을 자동으로 되살리는 토큰 (🎟️N)" },
  { emoji: "💤", label: "휴면", meaning: "N일째 활동 없음 (💤N)" },
];
