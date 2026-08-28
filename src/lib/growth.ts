import { addBusinessDays, addDays, isWeekend } from "./date";

// 하루치 활동 재료(툴별 합산은 호출측에서 끝냄).
export type GrowthDay = {
  date: string; // YYYY-MM-DD (UTC)
  tools: string[]; // 그날 활동한 distinct 툴
  input: number; // 에이전틱 툴(claude_code·codex) input 합 (참고용)
  cacheRead: number; // 에이전틱 툴 cacheRead 합 (참고용)
  output: number; // 에이전틱 툴 output 합 (수율 분자)
  cacheCreation: number; // 에이전틱 툴 cacheCreation 합 (수율 분모)
  requests?: number; // 에이전틱 툴 요청 수 합 (복구 출석 플로어용). 없으면 0.
};

export type GrowthState = {
  gp: number;
  level: number; // 0 = 발아 전(휴면)
  stage: string; // dormant | germinated | seedling | sapling | young | mature | ancient
  stageEmoji: string;
  stageLabel: string;
  toNextLevel: number | null; // 다음 레벨까지 GP (고목 상한 도달 시 null)
  toNextStage: number | null;
  activeDays: number;
  streakDays: number;
  bestStreak: number;
  streakMultiplier: number;
  efficiencyBonusToday: number; // 최신 활동일 기준
  vitality: "lively" | "neutral" | "dozing";
  idleDays: number;
  milestones: string[];
  nextMilestone: { axis: string; label: string; remaining: number } | null;
  // 윈백(불씨 되살리기): 지금 되살릴 수 있는 잔불(유예창 진행중)과 복구 토큰 잔액.
  ember: Ember | null;
  restoreTokens: number;
};

// 끊긴 streak가 유예창 안에서 되살릴 수 있는 상태. length = 끊기기 직전 길이.
// kind "bridge"=주말유발(영업일 1회 복구) · "quest"=일반(활동 2일 복구).
export type Ember = {
  length: number;
  breakDate: string; // 끊김을 유발한 결석 스트레치의 마지막 날
  graceEndsAt: string; // 이 날(포함)까지 복구 가능
  kind: "bridge" | "quest";
  needed: number; // 복구에 필요한 자격 활동일 수
  have: number; // 유예창 안에서 지금까지 채운 자격 활동일 수
};

// ── 윈백 상수 (스펙 확정판, 2026-08-28) ──
const GRACE_BUSINESS_DAYS = 2; // 유예창: 끊긴 뒤 2 영업일 종료까지
const REVIVAL_ATTENDANCE = 2; // C1 복구 퀘스트: 자격 활동 2일
const BRIDGE_ATTENDANCE = 1; // C2 월요일 브릿지(주말유발): 영업일 1회
const QUALITY_BONUS_GP = 5; // C1 품질 보너스(소량 GP)
const TOKEN_CAP = 2; // C3 복구 토큰 잔액 상한
const TOKEN_EARN_PER = 5; // 효율보너스 ≥3 누적 N일당 토큰 1개
const FLOOR_REQUESTS = 20; // 복구 출석 실사용 플로어
const FLOOR_OUTPUT = 50_000; // (agentic req≥20 OR output≥50k)

// 복구 출석으로 인정되는 "실작업일" 판정 — 필러/핑 하루 배제(안티게이밍).
function meetsActivityFloor(d: GrowthDay): boolean {
  return (d.requests ?? 0) >= FLOOR_REQUESTS || (d.output ?? 0) >= FLOOR_OUTPUT;
}

// 단계: [key, emoji, label, minGP]. 마지막이 상한(무한).
const STAGES: Array<[string, string, string, number]> = [
  ["germinated", "🌱", "(씨)발아", 0],
  ["seedling", "🌿", "새싹", 50],
  ["sapling", "🪴", "묘목", 150],
  ["young", "🌳", "어린나무", 350],
  ["mature", "🌲", "큰나무", 700],
  ["ancient", "🌳✨", "고목", 1300],
];

// 연속일 → 배수 (내림차순 매칭).
const STREAK_TIERS: Array<[number, number]> = [
  [60, 2.5],
  [30, 2.0],
  [14, 1.8],
  [7, 1.5],
  [3, 1.2],
  [0, 1.0],
];

function streakMultiplier(days: number): number {
  for (const [min, mult] of STREAK_TIERS) if (days >= min) return mult;
  return 1.0;
}

// 효율 보너스(하루, 상한 +5): 컨텍스트 수율 밴드(0..3) + 다양성(distinct툴−1, 상한2).
// 수율 = output/cacheCreation("새 컨텍스트당 산출"). cacheCreation<1M은 신호 부족으로
// 0(비penalty). 밴드 임계는 프로덕션 일별 분포 사분위 교정 — 스펙 참조.
export function efficiencyBonus(day: GrowthDay): number {
  const yieldBonus = yieldBand(day);
  const diversityBonus = Math.min(2, Math.max(0, day.tools.length - 1)); // 0..2
  return Math.min(5, yieldBonus + diversityBonus);
}

// 새 컨텍스트당 산출 밴드. cacheCreation 플로어 1M 미만이면 신호 부족 → 0.
function yieldBand(day: GrowthDay): number {
  if (!(day.cacheCreation >= 1_000_000)) return 0; // <1M 또는 비유한 → 신호 부족
  const y = day.output / day.cacheCreation;
  if (y < 0.07) return 0;
  if (y < 0.14) return 1;
  if (y < 0.24) return 2;
  return 3;
}

// 트레일링 7일에 미활동 1일까지 허용(굴러가는 창), 그 이상이면 스트릭 종료.
// cursor 기준 [cursor, cursor+6] 창의 미스가 2 이상이면 끊긴다.
export function streakEndingAt(
  active: Set<string>,
  end: string,
  earliest: string,
): number {
  let streak = 0;
  const misses: string[] = [];
  let cursor = end;
  while (cursor >= earliest) {
    if (active.has(cursor)) {
      streak++;
    } else {
      misses.push(cursor);
      const windowEnd = addDays(cursor, 6);
      const inWindow = misses.filter((m) => m >= cursor && m <= windowEnd).length;
      if (inWindow > 1) break;
    }
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export type RevivalResult = {
  healed: Set<string>; // streak 연속으로 취급할(치유된) 결석일
  bonusGp: number; // C1 품질 보너스 GP 합
  restoreTokens: number; // 오늘 기준 복구 토큰 잔액
  ember: Ember | null; // 진행중(유예창 열림·미복구) 잔불 — 없으면 null
};

// 끊긴 gap(결석 2일+)을 유예창 규칙으로 되살린다. 순수·결정론적 — 입력은 정렬된
// 활동일과 today뿐이며 사용자 액션·영속 상태가 없다(computeGrowth와 동일 철학).
//   · C2 브릿지: gap이 전부 주말이면 유예창 내 영업일 1회(자격) 활동으로 복원
//   · C1 퀘스트: 그 외엔 유예창 내 자격 활동 2일로 복원(+품질일 있으면 보너스 GP)
//   · C3 토큰: 위 실패 & 잔액>0이면 자동 1개 소모로 복원(최후 보루)
// 치유된 결석일은 streak만 이어줄 뿐 GP는 소급하지 않는다(호출측이 GP 미가산).
export function computeRevival(eligible: GrowthDay[], today: string): RevivalResult {
  const empty: RevivalResult = { healed: new Set(), bonusGp: 0, restoreTokens: 0, ember: null };
  if (eligible.length === 0) return empty;

  const earliest = eligible[0].date;
  const active = new Set(eligible.map((d) => d.date));
  const qualifies = new Set(eligible.filter(meetsActivityFloor).map((d) => d.date));
  const qualityDates = new Set(
    eligible.filter((d) => efficiencyBonus(d) >= 3 || d.tools.length >= 2).map((d) => d.date),
  );

  const healed = new Set<string>();
  let bonusGp = 0;
  let ember: Ember | null = null;

  // 토큰: 효율보너스≥3 활동일 누적으로 적립, gap을 시간순으로 소모.
  let cumHighEff = 0;
  let tokensConsumed = 0;

  for (let i = 0; i < eligible.length; i++) {
    if (i >= 1) {
      const prev = eligible[i - 1].date;
      const cur = eligible[i].date;
      const gapDays: string[] = [];
      for (let c = addDays(prev, 1); c < cur; c = addDays(c, 1)) gapDays.push(c);
      // 결석 2일+ 만 끊김(단일 결석은 기존 규칙이 이미 브릿지).
      if (gapDays.length >= 2) {
        const breakDate = gapDays[gapDays.length - 1];
        const graceEndsAt = addBusinessDays(breakDate, GRACE_BUSINESS_DAYS);
        const allRest = gapDays.every(isWeekend);
        const needed = allRest ? BRIDGE_ATTENDANCE : REVIVAL_ATTENDANCE;
        const windowQual = eligible.filter(
          (d) => d.date >= cur && d.date <= graceEndsAt && qualifies.has(d.date),
        );
        const have = windowQual.length;

        let healedGap = false;
        if (have >= needed) {
          healedGap = true;
          if (windowQual.some((d) => qualityDates.has(d.date))) bonusGp += QUALITY_BONUS_GP;
        } else {
          const balance = Math.min(TOKEN_CAP, Math.floor(cumHighEff / TOKEN_EARN_PER) - tokensConsumed);
          if (balance > 0) {
            tokensConsumed++;
            healedGap = true;
          }
        }

        if (healedGap) {
          for (const g of gapDays) healed.add(g);
        } else if (graceEndsAt >= today) {
          // 유예창이 아직 열려있고 미복구 → 진행중 잔불(복귀했으나 needed 미달).
          const length = streakEndingAt(new Set([...active, ...healed]), prev, earliest);
          ember = { length, breakDate, graceEndsAt, kind: allRest ? "bridge" : "quest", needed, have };
        }
      }
    }
    if (efficiencyBonus(eligible[i]) >= 3) cumHighEff++;
  }

  // 꼬리 잔불: 마지막 활동일 이후 오늘까지 결석 2일+ 이고 유예창이 열려있으면,
  // 아직 복귀하지 않은 이탈자에게도 되살릴 불씨를 보여준다(윈백의 핵심 순간).
  const last = eligible[eligible.length - 1].date;
  const tail: string[] = [];
  for (let c = addDays(last, 1); c <= today; c = addDays(c, 1)) tail.push(c);
  if (tail.length >= 2) {
    const secondMiss = tail[1];
    const graceEndsAt = addBusinessDays(secondMiss, GRACE_BUSINESS_DAYS);
    if (graceEndsAt >= today) {
      const allRest = tail.every(isWeekend);
      const length = streakEndingAt(new Set([...active, ...healed]), last, earliest);
      ember = {
        length,
        breakDate: tail[tail.length - 1],
        graceEndsAt,
        kind: allRest ? "bridge" : "quest",
        needed: allRest ? BRIDGE_ATTENDANCE : REVIVAL_ATTENDANCE,
        have: 0,
      };
    }
  }

  const restoreTokens = Math.max(
    0,
    Math.min(TOKEN_CAP, Math.floor(cumHighEff / TOKEN_EARN_PER) - tokensConsumed),
  );
  return { healed, bonusGp, restoreTokens, ember };
}

function stageFor(gp: number): [string, string, string, number, number | null] {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) if (gp >= STAGES[i][3]) idx = i;
  const [key, emoji, label, min] = STAGES[idx];
  const nextMin = idx + 1 < STAGES.length ? STAGES[idx + 1][3] : null;
  return [key, emoji, label, min, nextMin];
}

// 마일스톤 축: [threshold, label] — count가 threshold 이상이면 언락.
const MILESTONES = {
  streak: [
    [3, "🌸"], [7, "🦋"], [14, "🐝"], [30, "🌈"], [60, "⭐"],
  ] as Array<[number, string]>,
  active_days: [
    [10, "💧"], [30, "🐦"], [100, "🦌"], [200, "🦉"], [365, "🏞️"],
  ] as Array<[number, string]>,
  efficiency: [
    [7, "☀️"], [30, "🌞"],
  ] as Array<[number, string]>,
  tools: [
    [2, "🍄"], [3, "🌾"], [4, "🌻"],
  ] as Array<[number, string]>,
};

// --- 표시용 카탈로그 (UI 전용 파생 — 엔진 로직과 단일 소스) ---

const AXIS_LABEL: Record<string, (n: number) => string> = {
  streak: (n) => `${n}일 연속`,
  active_days: (n) => `누적 활동 ${n}일`,
  efficiency: (n) => `효율 보너스 ${n}일`,
  tools: (n) => `도구 ${n}종`,
};

export const MILESTONE_CATALOG = Object.entries(MILESTONES).flatMap(([axis, tiers]) =>
  tiers.map(([threshold, emoji]) => ({
    key: `${axis}_${threshold}`,
    axis,
    emoji,
    label: AXIS_LABEL[axis](threshold),
    threshold,
  })),
);

export const STAGE_CATALOG = STAGES.map(([stage, emoji, label, minGp]) => ({
  stage,
  emoji,
  label,
  minGp,
}));

// 스트릭 배수표(도감 표시용 단일 소스). base(0일)는 제외.
export const STREAK_CATALOG = STREAK_TIERS
  .filter(([days]) => days > 0)
  .map(([days, mult]) => ({ days, mult }));

function collectMilestones(counts: Record<string, number>): {
  unlocked: string[];
  next: { axis: string; label: string; remaining: number } | null;
} {
  const unlocked: string[] = [];
  let next: { axis: string; label: string; remaining: number } | null = null;
  for (const axis of Object.keys(MILESTONES) as Array<keyof typeof MILESTONES>) {
    const count = counts[axis] ?? 0;
    for (const [th, label] of MILESTONES[axis]) {
      if (count >= th) unlocked.push(`${axis}_${th}`);
      else {
        const remaining = th - count;
        if (!next || remaining < next.remaining) next = { axis, label, remaining };
        break; // 축별 다음 미달 티어에서 멈춤
      }
    }
  }
  return { unlocked, next };
}

// today: 표시 기준 오늘(KST). teamEpoch: 팀 추적 시작일 YYYY-MM-DD — GP는 개인
// 온보딩일이 아니라 이 팀 공통 기준일부터 누적한다(등록 시점 무관 공정).
export function computeGrowth(
  days: GrowthDay[],
  teamEpoch: string,
  today: string,
): GrowthState {
  const DORMANT: GrowthState = {
    gp: 0, level: 0, stage: "dormant", stageEmoji: "🌰", stageLabel: "부화 전 씨앗",
    toNextLevel: 0, toNextStage: 0, activeDays: 0, streakDays: 0, bestStreak: 0,
    streakMultiplier: 1.0, efficiencyBonusToday: 0, vitality: "dozing", idleDays: 0,
    milestones: [], nextMilestone: null, ember: null, restoreTokens: 0,
  };

  // 팀 epoch 이후 활동일만. 활동이 없으면(위저드 완료와 무관) 휴면.
  const eligible = days
    .filter((d) => d.date >= teamEpoch)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (eligible.length === 0) return DORMANT;

  const active = new Set(eligible.map((d) => d.date));
  const earliest = eligible[0].date;

  // 윈백(불씨 되살리기): 치유된 결석일은 streak 연속으로 취급 → 복구 시 배수도 복원.
  const revival = computeRevival(eligible, today);
  const activeOrHealed = revival.healed.size
    ? new Set([...active, ...revival.healed])
    : active;

  // GP 누적: 각 활동일의 그 시점 스트릭 배수 × 10 + 효율보너스. 치유된 결석일 자체는
  // GP를 받지 않는다(eligible에 없음) — streak만 이어준다.
  let gp = 0;
  let highEffDays = 0;
  for (const d of eligible) {
    const s = streakEndingAt(activeOrHealed, d.date, earliest);
    const eff = efficiencyBonus(d);
    if (eff >= 3) highEffDays++;
    gp += Math.round(10 * streakMultiplier(s)) + eff;
  }
  gp += revival.bonusGp; // C1 품질 보너스

  const [stage, stageEmoji, stageLabel, , nextStageMin] = stageFor(gp);
  const level = Math.floor(gp / 50) + 1;
  const toNextLevel = 50 - (gp % 50);
  const toNextStage = nextStageMin === null ? null : nextStageMin - gp;

  const streakDays = streakEndingAt(activeOrHealed, today, earliest);
  const latest = eligible[eligible.length - 1].date;
  let bestStreak = 0;
  for (const d of eligible) bestStreak = Math.max(bestStreak, streakEndingAt(activeOrHealed, d.date, earliest));

  const distinctTools = new Set<string>();
  for (const d of eligible) for (const t of d.tools) distinctTools.add(t);

  const { unlocked, next } = collectMilestones({
    streak: bestStreak,
    active_days: eligible.length,
    efficiency: highEffDays,
    tools: distinctTools.size,
  });

  // 활력: 최신 활동일과 today 차이(일).
  const idleDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`)) / 86400000,
  );
  const vitality = idleDays <= 0 ? "lively" : idleDays >= 3 ? "dozing" : "neutral";

  return {
    gp, level, stage, stageEmoji, stageLabel,
    toNextLevel,
    toNextStage,
    activeDays: eligible.length,
    streakDays, bestStreak,
    streakMultiplier: streakMultiplier(streakDays),
    efficiencyBonusToday: efficiencyBonus(eligible[eligible.length - 1]),
    vitality, idleDays: Math.max(0, idleDays),
    milestones: unlocked, nextMilestone: next,
    ember: revival.ember, restoreTokens: revival.restoreTokens,
  };
}
