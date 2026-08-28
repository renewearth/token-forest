import { MILESTONE_CATALOG, STAGE_CATALOG } from "@/lib/growth";

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

const AXIS_META: Record<string, { axisLabel: string; meaning: string }> = {
  streak: { axisLabel: "스트릭", meaning: "며칠 연달아 활동했는지 (주말·공휴일은 유지, 끊겨도 되살리기 가능)" },
  active_days: { axisLabel: "활동일", meaning: "팀 추적 시작 이후 활동한 날 누적" },
  efficiency: { axisLabel: "효율", meaning: "컨텍스트 수율 높은 날 — 숲에선 나무 광채로 표시" },
  tools: { axisLabel: "도구", meaning: "사용한 AI 도구 종류 수" },
};
const AXIS_ORDER = ["streak", "active_days", "efficiency", "tools"];

export function milestoneGroups(): MilestoneAxisGroup[] {
  return AXIS_ORDER.map((axis) => ({
    axis,
    axisLabel: AXIS_META[axis].axisLabel,
    meaning: AXIS_META[axis].meaning,
    tiers: MILESTONE_CATALOG.filter((m) => m.axis === axis).map((m) => ({
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
