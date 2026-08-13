import {
  cacheReuseRatio, contextYield, sessionDepth, requestAnatomy,
  cacheSavingsRate, toolEntropy, median, iqrBand, showBand,
  adoptionLeadDays, rampWeeks, weeklyTeamSeries,
} from "../lib/scorecard";
import type { ScoreSums } from "../lib/scorecard";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}
function close(a: number | null, b: number, msg: string) {
  assert(a != null && Math.abs(a - b) < 1e-9, `${msg} (got ${a})`);
}

const S = (p: Partial<ScoreSums>): ScoreSums => ({
  input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, sessions: 0, ...p,
});

// 효율 — 0/0 가드 전수
close(cacheReuseRatio(S({ cacheRead: 90, cacheCreation: 10 })), 9, "재사용 배율 9");
assert(cacheReuseRatio(S({})) === null, "재사용 0/0 → null");
close(contextYield(S({ output: 30, cacheCreation: 150 })), 0.2, "수율 output/cacheCreation 0.2");
assert(contextYield(S({ output: 30 })) === null, "수율 cacheCreation 0 → null");
close(sessionDepth(S({ requests: 40, sessions: 8 })), 5, "세션 깊이 5");
assert(sessionDepth(S({ requests: 40 })) === null, "sessions 0 → null");
const anat = requestAnatomy(S({ input: 100, cacheRead: 300, output: 50, requests: 10 }));
assert(anat !== null && anat.inputPerReq === 10 && anat.cachePerReq === 30 && anat.outputPerReq === 5, "요청 해부 10/30/5");
assert(requestAnatomy(S({ input: 5 })) === null, "requests 0 → null");
close(cacheSavingsRate(90, 210), 0.3, "절감률 90/(210+90)=0.3");
assert(cacheSavingsRate(0, 0) === null, "절감 0/0 → null");

// 확장 — 엔트로피 (정규화 0..1)
assert(toolEntropy({}) === null, "사용 0 → null");
close(toolEntropy({ claude_code: 100 }), 0, "단일 도구 → 0");
close(toolEntropy({ a: 50, b: 50 }), 1, "2도구 균등 → 1");
const skew = toolEntropy({ a: 90, b: 10 });
assert(skew !== null && skew > 0 && skew < 1, "치우침 → 0~1 사이");

// 집계 — 중앙값·IQR·8명 가드
assert(median([]) === null, "중앙값 빈배열 → null");
close(median([3, 1, 2]), 2, "중앙값 홀수");
close(median([1, 2, 3, 4]), 2.5, "중앙값 짝수");
const band = iqrBand([1, 2, 3, 4, 5, 6, 7, 8]);
assert(band !== null && band.p25 < band.p75, "IQR p25<p75");
assert(showBand(7) === false && showBand(8) === true, "밴드 가드 7/8 경계");

// D1 채택 리드타임
assert(adoptionLeadDays(["2026-07-01", "2026-07-03", "2026-07-10"], 5) === 9, "ceil(5/2)=3번째 07-10 → 9일");
assert(adoptionLeadDays(["2026-07-01"], 5) === null, "절반 미도달 → null");
assert(adoptionLeadDays([], 5) === null, "사용 0 → null");

// D3 램프업: 온보딩 후 주차별 활동일
const ramp = rampWeeks(["2026-07-01", "2026-07-02", "2026-07-09"], "2026-07-01", 4);
assert(JSON.stringify(ramp) === JSON.stringify([2, 1, 0, 0]), `램프 [2,1,0,0] (got ${ramp})`);

// weeklyTeamSeries — 풀드(자원 관점) vs 중앙값(사람 관점): 치우친 2인 데이터에서
// 한 명이 볼륨을 지배하면 두 값은 갈라져야 한다.
const cacheHit = (s: ScoreSums) =>
  s.input + s.cacheRead > 0 ? s.cacheRead / (s.input + s.cacheRead) : null;
const skewedWeek = weeklyTeamSeries(
  [
    { week: "2026-07-06", memberId: "a", sums: S({ input: 900, cacheRead: 100 }) },
    { week: "2026-07-06", memberId: "b", sums: S({ input: 10, cacheRead: 90 }) },
  ],
  cacheHit,
);
assert(skewedWeek.length === 1, "치우친 주 1개");
close(skewedWeek[0].pooled, 190 / 1100, "풀드 = 190/1100");
close(skewedWeek[0].median, 0.5, "중앙값 = (0.1+0.9)/2");
assert(
  skewedWeek[0].pooled !== null &&
    skewedWeek[0].median !== null &&
    Math.abs(skewedWeek[0].pooled - skewedWeek[0].median) > 0.01,
  "풀드 ≠ 중앙값 (치우침 노출)",
);

// weeklyTeamSeries — 8명 가드: 7명 주엔 밴드 없음, 8명 주엔 있음.
const membersOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    week: "2026-07-13",
    memberId: `m${i}`,
    sums: S({ input: 100 - i, cacheRead: i }),
  }));
const week7 = weeklyTeamSeries(membersOf(7), cacheHit);
const week8 = weeklyTeamSeries(membersOf(8), cacheHit);
assert(week7[0].p25 === undefined && week7[0].p75 === undefined, "7명 → 밴드 없음");
assert(week8[0].p25 !== undefined && week8[0].p75 !== undefined, "8명 → 밴드 있음");

console.log("ALL PASS");
