// AI 활용 스코어카드 — 순수 계산. 전 지표 0/0 가드(null 반환), 점수화·합산 없음.
// 스펙: docs/superpowers/specs/2026-07-26-ai-scorecard-design.md

export type ScoreSums = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requests: number;
  sessions: number;
};

export const EMPTY_SUMS: ScoreSums = {
  input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, sessions: 0,
};

export function addSums(a: ScoreSums, b: Partial<ScoreSums>): ScoreSums {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheCreation: a.cacheCreation + (b.cacheCreation ?? 0),
    requests: a.requests + (b.requests ?? 0),
    sessions: a.sessions + (b.sessions ?? 0),
  };
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

// A1 캐시 재사용 배율 — 캐시에 적재한 토큰이 몇 번 재사용되나.
export function cacheReuseRatio(s: ScoreSums): number | null {
  return ratio(s.cacheRead, s.cacheCreation);
}

// G4 컨텍스트 수율 — 새로 끌어온 컨텍스트(cacheCreation) 1토큰당 산출.
// 숲 성장 yieldBand(growth.ts)·/guide 정의와 동일 분모. cacheRead(재읽기)를
// 분모에 넣으면 에이전틱 툴에서 재읽기가 output의 수백 배라 항상 ~0% 됨(폐기).
export function contextYield(s: ScoreSums): number | null {
  return ratio(s.output, s.cacheCreation);
}

// G2 세션 깊이 — 세션당 에이전트 턴 수 (claude_code 합만 넣을 것). 무방향 지표.
export function sessionDepth(s: ScoreSums): number | null {
  return ratio(s.requests, s.sessions);
}

// G1 요청 해부 — 요청 1건당 평균 구성 3성분.
export function requestAnatomy(
  s: ScoreSums,
): { inputPerReq: number; cachePerReq: number; outputPerReq: number } | null {
  if (s.requests <= 0) return null;
  return {
    inputPerReq: s.input / s.requests,
    cachePerReq: s.cacheRead / s.requests,
    outputPerReq: s.output / s.requests,
  };
}

// A2 캐시 절감률 — 절감 가중치 / (실소비 + 절감). 가중치 산출은 쿼리 측에서
// rateFamily 로 계산해 넘긴다 (여긴 순수 비율만). % 가 아닌 0..1.
export function cacheSavingsRate(saved: number, spent: number): number | null {
  return ratio(saved, spent + saved);
}

// D2 도구 엔트로피 — 사용량 가중 Shannon, log2(k) 정규화 0..1. 단일 도구 = 0.
export function toolEntropy(byTool: Record<string, number>): number | null {
  const vals = Object.values(byTool).filter((v) => v > 0);
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  if (vals.length === 1) return 0;
  const h = vals.reduce((acc, v) => {
    const p = v / total;
    return acc - p * Math.log2(p);
  }, 0);
  return h / Math.log2(vals.length);
}

// --- 팀 집계 ---

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function iqrBand(xs: number[]): { p25: number; p75: number } | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { p25: quantile(s, 0.25), p75: quantile(s, 0.75) };
}

// 개인 특정 방지 — 활성 8명 미만이면 분포 밴드 미표시 (스펙).
export function showBand(activeMembers: number): boolean {
  return activeMembers >= 8;
}

// --- D1 신모델 채택 리드타임 ---
// firstDates: 멤버별 해당 모델 최초 사용일(정렬 불문). 전역 최초일부터
// ceil(teamSize/2)번째 멤버 도달일까지의 일수. 미도달 → null.
export function adoptionLeadDays(firstDates: string[], teamSize: number): number | null {
  if (firstDates.length === 0 || teamSize <= 0) return null;
  const sorted = [...firstDates].sort();
  const needed = Math.ceil(teamSize / 2);
  if (sorted.length < needed) return null;
  const first = Date.parse(sorted[0]);
  const half = Date.parse(sorted[needed - 1]);
  return Math.round((half - first) / 86_400_000);
}

// --- D3 온보딩 램프업 ---
// onboardedAt 기준 주차(0-index)별 활동일 수, weeks개 고정 길이.
export function rampWeeks(activeDates: string[], onboardedAt: string, weeks = 4): number[] {
  const start = Date.parse(onboardedAt);
  const out = new Array<number>(weeks).fill(0);
  for (const d of activeDates) {
    const idx = Math.floor((Date.parse(d) - start) / (7 * 86_400_000));
    if (idx >= 0 && idx < weeks) out[idx]++;
  }
  return out;
}

// --- 팀 주별 시리즈 조립 (풀드 + 중앙값 + IQR, 8명 가드) ---

export type WeeklySeriesPoint = {
  week: string; pooled: number | null; median: number | null;
  p25?: number; p75?: number;
};

export function weeklyTeamSeries(
  rows: Array<{ week: string; memberId: string; sums: ScoreSums; claudeOnly?: boolean }>,
  metric: (s: ScoreSums) => number | null,
): WeeklySeriesPoint[] {
  const byWeek = new Map<string, Map<string, ScoreSums>>();
  for (const r of rows) {
    const wk = byWeek.get(r.week) ?? new Map<string, ScoreSums>();
    wk.set(r.memberId, addSums(wk.get(r.memberId) ?? { ...EMPTY_SUMS }, r.sums));
    byWeek.set(r.week, wk);
  }
  return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, members]) => {
    const pooledSums = [...members.values()].reduce((a, b) => addSums(a, b), { ...EMPTY_SUMS });
    const vals = [...members.values()].map(metric).filter((v): v is number => v != null);
    const point: WeeklySeriesPoint = {
      week, pooled: metric(pooledSums), median: median(vals),
    };
    if (showBand(members.size)) {
      const band = iqrBand(vals);
      if (band) { point.p25 = band.p25; point.p75 = band.p75; }
    }
    return point;
  });
}

// 모델 다양성 주별 시리즈 — 멤버별 사용량 가중 엔트로피(toolEntropy 재사용)의
// 풀드(팀 합산 분포)+중앙값+IQR(8명 가드). weeklyTeamSeries와 동일 관점 구조지만
// 누적 단위가 ScoreSums가 아니라 모델→토큰 맵이다.
export function weeklyModelBreadthSeries(
  rows: Array<{ week: string; memberId: string; byModel: Record<string, number> }>,
): WeeklySeriesPoint[] {
  const byWeek = new Map<string, Map<string, Record<string, number>>>();
  for (const r of rows) {
    const wk = byWeek.get(r.week) ?? new Map<string, Record<string, number>>();
    const cur = wk.get(r.memberId) ?? {};
    for (const [m, t] of Object.entries(r.byModel)) cur[m] = (cur[m] ?? 0) + t;
    wk.set(r.memberId, cur);
    byWeek.set(r.week, wk);
  }
  return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, members]) => {
    const pooled: Record<string, number> = {};
    for (const map of members.values())
      for (const [m, t] of Object.entries(map)) pooled[m] = (pooled[m] ?? 0) + t;
    const vals = [...members.values()].map(toolEntropy).filter((v): v is number => v != null);
    const point: WeeklySeriesPoint = { week, pooled: toolEntropy(pooled), median: median(vals) };
    if (showBand(members.size)) {
      const band = iqrBand(vals);
      if (band) { point.p25 = band.p25; point.p75 = band.p75; }
    }
    return point;
  });
}
