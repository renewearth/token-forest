import { computeGrowth, computeRevival } from "../lib/growth";
import type { GrowthDay } from "../lib/growth";

// 윈백(불씨 되살리기) 엔진 AC 검증. 순수 함수라 DB 없이 합성 데이터로 돌린다.
// 달력(2026-08): 03 월 … 07 금 / 08·09 주말 / 10 월 … 14 금 / 15·16 주말 /
//               17 월 … 21 금 / 22·23 주말 / 24 월 … 28 금.
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 기본값: floor 충족(output 60k≥50k, req 30≥20), eff 0(cacheCreation 0). 단일 툴.
const day = (
  date: string,
  o: { tools?: string[]; output?: number; cc?: number; req?: number } = {},
): GrowthDay => ({
  date,
  tools: o.tools ?? ["claude_code"],
  input: 0,
  cacheRead: 0,
  output: o.output ?? 60_000,
  cacheCreation: o.cc ?? 0,
  requests: o.req ?? 30,
});
const highEff = (date: string) => day(date, { output: 300_000, cc: 1_000_000 }); // 수율0.3 → eff3
const filler = (date: string) => day(date, { output: 1_000, req: 2 }); // floor 미달
const EPOCH = "2026-08-01";

// ── AC1: 주말 브릿지(C2) — 금 활동 → 토·일 결석 → 월 활동(floor)이면 연속 ──
{
  const days = ["2026-08-17","2026-08-18","2026-08-19","2026-08-20","2026-08-21","2026-08-24"].map((d) => day(d));
  const g = computeGrowth(days, EPOCH, "2026-08-24");
  assert(g.streakDays === 8, `주말 브릿지: 17~24 연속 streak=8 (got ${g.streakDays})`);
  assert(g.activeDays === 6, `치유 결석일은 활동일 아님: activeDays=6 (got ${g.activeDays})`);
  assert(g.ember === null, "복구 완료 → 잔불 없음");
}

// ── AC2a: 복구 퀘스트(C1) — 평일 포함 결석, 유예창 내 자격 2일이면 복원 ──
{
  const days = ["2026-08-17","2026-08-18","2026-08-19","2026-08-24","2026-08-25"].map((d) => day(d));
  const g = computeGrowth(days, EPOCH, "2026-08-25");
  assert(g.streakDays === 9, `퀘스트 복원: 17~25 연속 streak=9 (got ${g.streakDays})`);
  assert(g.ember === null, "퀘스트 복구 완료 → 잔불 없음");
}

// ── AC2b: 복구 미달 & 유예창 열림 → 진행중 잔불(ember) 노출 ──
{
  const days = ["2026-08-17","2026-08-18","2026-08-19","2026-08-24"].map((d) => day(d));
  const g = computeGrowth(days, EPOCH, "2026-08-24");
  assert(g.ember !== null, "유예창 열림·미복구 → 잔불 존재");
  assert(g.ember?.length === 3, `잔불 길이=끊기기 직전 streak 3 (got ${g.ember?.length})`);
  assert(g.ember?.kind === "quest", "평일 포함 → quest");
  assert(g.ember?.needed === 2 && g.ember?.have === 1, `needed 2 / have 1 (got ${g.ember?.needed}/${g.ember?.have})`);
  assert(g.streakDays === 1, `미복구 → 현재 streak 1 (got ${g.streakDays})`);
}

// ── AC3: 품질 보너스 — 복구 완료 + 창 내 하루가 도구≥2(또는 eff≥3)면 GP +5 ──
{
  const q = ["2026-08-17","2026-08-18","2026-08-19"].map((d) => day(d))
    .concat(day("2026-08-24", { tools: ["claude_code", "codex"] }), day("2026-08-25"));
  assert(computeRevival(q, "2026-08-25").bonusGp === 5, "품질일 포함 복구 → 보너스 GP 5");
  const plain = ["2026-08-17","2026-08-18","2026-08-19","2026-08-24","2026-08-25"].map((d) => day(d));
  assert(computeRevival(plain, "2026-08-25").bonusGp === 0, "품질일 없음 → 보너스 0");
}

// ── AC4: 복구 토큰(C3) — 효율≥3 누적 5일당 1개, 출석 복구 실패 시 자동 소모 ──
{
  const withToken = ["2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07"]
    .map((d) => highEff(d)).concat(day("2026-08-11")); // 07→11 결석[08,09,10] quest, 창내 자격 1일
  const r = computeRevival(withToken, "2026-08-11");
  assert(r.healed.has("2026-08-10"), "토큰 자동 소모로 gap 치유");
  assert(r.restoreTokens === 0, `토큰 1개 적립·1개 소모 → 잔액 0 (got ${r.restoreTokens})`);

  const noToken = [day("2026-08-03")].concat( // 첫날 non-highEff → highEff 4개 < 5
    ["2026-08-04","2026-08-05","2026-08-06","2026-08-07"].map((d) => highEff(d)),
    day("2026-08-11"),
  );
  const r2 = computeRevival(noToken, "2026-08-11");
  assert(!r2.healed.has("2026-08-10"), "토큰 부족 → 미치유");
  assert(r2.ember !== null, "미치유 & 유예창 열림 → 잔불");
}

// ── AC5: floor — 복구 복귀일이 실사용 미달(필러)이면 출석 불인정 ──
{
  const days = ["2026-08-17","2026-08-18","2026-08-19","2026-08-20","2026-08-21"].map((d) => day(d))
    .concat(filler("2026-08-24")); // 월 복귀가 필러 → 자격 미달
  const g = computeGrowth(days, EPOCH, "2026-08-24");
  assert(g.streakDays === 1, `필러 복귀 → 브릿지 실패, streak 1 (got ${g.streakDays})`);
  assert(g.ember?.have === 0, `자격 활동 0 (got ${g.ember?.have})`);
}

// ── AC6: 빈 입력 안전 ──
{
  const r = computeRevival([], "2026-08-24");
  assert(r.healed.size === 0 && r.ember === null && r.restoreTokens === 0, "빈 입력 → 무해");
}

console.log("ALL PASS");
