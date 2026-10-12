import { computeGrowth, diversityBonus, GP_RULES, levelFor, levelMinGp, streakEndingAt, usageBonus, volumeBonus, volumeStep } from "../lib/growth";
import type { GrowthDay } from "../lib/growth";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 활동 07-18/19/20. 사용량 4칸(+3) + 모델 계열 2가지(+1) = 사용 보너스 4.
const days: GrowthDay[] = [
  { date: "2026-07-18", tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"] },
  { date: "2026-07-19", tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"] },
  { date: "2026-07-20", tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"] },
];
assert(usageBonus(days[0]) === 4, "사용 보너스 07-18 = 4 (사용량 3 + 다양성 1)");

// GP: (10×1.0+4)+(10×1.0+4)+(round(10×1.2)+4)=14+14+16 = 44.
const g = computeGrowth(days, "2026-07-18", "2026-07-23");
assert(g.gp === 44, `GP=44 (got ${g.gp})`);
assert(g.level === 3, `level=3 — 44 GP는 Lv3(40)과 Lv4(90) 사이 (got ${g.level})`);
assert(g.toNextLevel === 46, `Lv4까지 46 (got ${g.toNextLevel})`);
assert(g.stage === "germinated" && g.stageLabel === "(씨)발아", "stage=(씨)발아");
assert(g.toNextStage === 56, `새싹까지 56 (got ${g.toNextStage})`);
assert(g.bestStreak === 3, `bestStreak=3 (got ${g.bestStreak})`);
assert(g.streakDays === 0, `현재 스트릭=0, 3일 유휴 (got ${g.streakDays})`);
assert(g.vitality === "dozing" && g.idleDays === 3, "졸음 · 유휴 3일");
assert(g.milestones.includes("streak_3") && g.milestones.includes("tools_2"), "언락 🌸·🍄");
assert(g.efficiencyBonusToday === 4, "efficiencyBonusToday 필드는 최신 활동일의 사용 보너스");

// 팀 epoch가 모든 활동일보다 이후 → eligible 없음 → 휴면.
const d0 = computeGrowth(days, "2027-01-01", "2027-01-01");
assert(d0.level === 0 && d0.stage === "dormant" && d0.stageEmoji === "🌰", "Lv0 휴면");

// 온보딩 후 활동 없음 → 휴면.
const d1 = computeGrowth([], "2026-07-18", "2026-07-23");
assert(d1.level === 0 && d1.stage === "dormant", "활동 0 → 휴면");

// 단일 휴식일은 스트릭 유지, 2연속은 종료.
const gap = new Set(["2026-07-10", "2026-07-11", "2026-07-13"]); // 12 쉼
assert(streakEndingAt(gap, "2026-07-13", "2026-07-10") === 3, "단일 갭 브릿지 → 3");
const gap2 = new Set(["2026-07-10", "2026-07-13"]); // 11,12 연속 쉼
assert(streakEndingAt(gap2, "2026-07-13", "2026-07-10") === 1, "2연속 갭 → 1");

// --- 사용량 칸: 토큰 경계 ---
const one = (o: Partial<GrowthDay>): GrowthDay => ({ date: "2026-07-18", tools: ["x"], tokens: 0, ...o });
const T = GP_RULES.tokenSteps, R = GP_RULES.requestSteps;
assert(JSON.stringify(T) === "[50000,200000,1000000,4000000,15000000]", "토큰 계단 5만/20만/100만/400만/1,500만");
assert(JSON.stringify(R) === "[10,50,250,850,2000]", "요청 계단 10/50/250/850/2,000");
assert(volumeStep(one({ tokens: 0 })) === 0 && volumeStep(one({ tokens: T[0] - 1 })) === 0, "토큰 5만 미만 → 0칸");
T.forEach((min, i) => {
  assert(volumeStep(one({ tokens: min })) === i + 1, `토큰 ${min} → ${i + 1}칸`);
  assert(volumeStep(one({ tokens: min - 1 })) === i, `토큰 ${min - 1} → ${i}칸`);
});
// --- 사용량 칸: 요청 수 경계 ---
assert(volumeStep(one({ requests: R[0] - 1 })) === 0, "요청 9 → 0칸");
R.forEach((min, i) => {
  assert(volumeStep(one({ requests: min })) === i + 1, `요청 ${min} → ${i + 1}칸`);
  assert(volumeStep(one({ requests: min - 1 })) === i, `요청 ${min - 1} → ${i}칸`);
});
// --- 둘 중 높은 쪽(더하지 않음) ---
assert(volumeStep(one({ tokens: 60_000, requests: 900 })) === 4, "토큰 1칸·요청 4칸 → 4칸");
assert(volumeStep(one({ tokens: 20_000_000, requests: 3 })) === 5, "토큰 5칸·요청 0칸 → 5칸");
assert(volumeStep(one({ tokens: 1_000_000, requests: 250 })) === 3, "같은 칸 둘 → 그 칸(합산 아님)");
assert(volumeStep(one({ tokens: Number.NaN, requests: undefined })) === 0, "비정상 값 → 0칸");
// --- 사용량 보너스 표: 0,0,1,2,3,4 ---
assert(
  JSON.stringify([0, T[0], T[1], T[2], T[3], T[4]].map((t) => volumeBonus(one({ tokens: t })))) === "[0,0,1,2,3,4]",
  "칸 0~5 → 사용량 보너스 0,0,1,2,3,4",
);
// --- 다양성: 센 계열 수 − 1, 상한 2 ---
assert(diversityBonus(one({})) === 0, "계열 정보 없음 → 0");
assert(diversityBonus(one({ families: ["opus"] })) === 0, "계열 1 → 0");
assert(diversityBonus(one({ families: ["opus", "gpt"] })) === 1, "계열 2 → 1");
assert(diversityBonus(one({ families: ["opus", "gpt", "gemini"] })) === 2, "계열 3 → 2");
assert(diversityBonus(one({ families: ["opus", "gpt", "gemini", "grok"] })) === 2, "계열 4 → 상한 2");
assert(diversityBonus(one({ families: ["opus", "opus"] })) === 0, "같은 계열 중복은 한 번");
assert(diversityBonus(one({ tools: ["a", "b", "c"] })) === 0, "도구 수는 다양성 보너스에 쓰지 않음");
// --- 합계 상한 5 ---
assert(usageBonus(one({ tokens: T[4], families: ["opus", "gpt", "gemini"] })) === 5, "사용량 4 + 다양성 2 = 상한 5");
assert(usageBonus(one({ tokens: T[3], families: ["opus", "gpt", "gemini"] })) === 5, "사용량 3 + 다양성 2 = 5");
assert(usageBonus(one({ tokens: 10, requests: 1 })) === 0, "아주 적은 사용 → 보너스 0 (기본 10 GP만)");

// --- Claude Code 없이 보고서로만 잡히는 사람도 GP·연속 기록을 받는다 ---
const reportOnly: GrowthDay[] = ["2026-09-01", "2026-09-02", "2026-09-03"].map((date) => ({
  date, tools: ["claude_cowork"], tokens: 300_000, requests: 60, families: ["sonnet"],
}));
const ro = computeGrowth(reportOnly, "2026-09-01", "2026-09-03");
assert(ro.activeDays === 3 && ro.streakDays === 3, `보고서만으로 활동 3일·연속 3일 (got ${ro.activeDays}/${ro.streakDays})`);
assert(ro.gp === 11 + 11 + 13, `2칸(+1) × 3일: 11+11+13 = 35 GP (got ${ro.gp})`);

// --- 확인 중인 날: 연속을 끊지 않고, 유휴로 세지 않고, GP도 주지 않는다 ---
const base: GrowthDay[] = ["2026-09-01", "2026-09-02", "2026-09-03"].map((date) => ({ date, tools: ["claude_code"], tokens: 60_000, requests: 30 }));
const confirmedGap = computeGrowth(base, "2026-09-01", "2026-09-06");
assert(confirmedGap.streakDays === 0 && confirmedGap.idleDays === 3, `확인된 결석 3일 → 연속 0·유휴 3 (got ${confirmedGap.streakDays}/${confirmedGap.idleDays})`);
const pending = new Set(["2026-09-04", "2026-09-05", "2026-09-06"]);
const frozen = computeGrowth(base, "2026-09-01", "2026-09-06", undefined, pending);
assert(frozen.streakDays === 3, `확인 중 3일 → 연속 3 유지 (got ${frozen.streakDays})`);
assert(frozen.idleDays === 0 && frozen.vitality === "lively", `확인 중은 유휴 아님 (got ${frozen.idleDays}/${frozen.vitality})`);
assert(frozen.gp === confirmedGap.gp && frozen.activeDays === 3, "확인 중인 날은 GP·활동일을 만들지 않음");
assert(frozen.ember === null, "확인 중인 꼬리에는 잔불을 띄우지 않음");
// 확인 중이던 날에 기록이 들어오면 평소대로 센다.
const arrived = computeGrowth([...base, { date: "2026-09-04", tools: ["claude_chat"], tokens: 60_000, requests: 30 }], "2026-09-01", "2026-09-06", undefined, pending);
assert(arrived.streakDays === 4 && arrived.activeDays === 4, `확인 중인 날에 기록 도착 → 연속 4 (got ${arrived.streakDays})`);
// 확인된 2일 결석은 그대로 끊긴다(확인 중 표시가 다른 날을 덮지 않음).
const broken = computeGrowth([...base, { date: "2026-09-10", tools: ["claude_code"], tokens: 60_000, requests: 30 }], "2026-09-01", "2026-09-10", undefined, new Set(["2026-09-11"]));
assert(broken.streakDays === 1 && broken.bestStreak === 3, `확인된 결석 6일 → 연속 1 (got ${broken.streakDays})`);
// 확인 중인 날은 연속 길이에 더해지지 않는다(멈춰 둘 뿐).
assert(streakEndingAt(new Set(["2026-09-01", "2026-09-03"]), "2026-09-03", "2026-09-01", new Set(["2026-09-02"])) === 2, "확인 중인 날은 세지 않음");

// --- 레벨: 필요한 GP = 10 × (L−1)², 올라갈수록 간격이 넓어진다 ---
assert(JSON.stringify([1, 2, 3, 4, 5, 10, 16, 22].map(levelMinGp)) === JSON.stringify([0, 10, 40, 90, 160, 810, 2250, 4410]), "레벨별 필요 GP");
for (const [gp, lv] of [[0, 1], [9, 1], [10, 2], [39, 2], [40, 3], [809, 9], [810, 10], [2249, 15], [2250, 16], [4500, 22]] as Array<[number, number]>) {
  assert(levelFor(gp) === lv, `GP ${gp} → Lv${lv} (got ${levelFor(gp)})`);
}
for (let gp = 0; gp <= 20000; gp += 7) {
  const lv = levelFor(gp);
  if (!(levelMinGp(lv) <= gp && gp < levelMinGp(lv + 1))) { console.error("FAIL: 레벨 경계 불일치", gp, lv); process.exit(1); }
}
console.log("ok: 0~20000 GP 전 구간에서 레벨 경계 일치");
assert(levelMinGp(3) - levelMinGp(2) < levelMinGp(17) - levelMinGp(16), "뒤로 갈수록 다음 레벨까지가 멀다");

// --- 숲 장식: 요즘 상태 (축마다 가장 높은 단계 하나) ---
// 위 픽스처: 3일 활동 뒤 3일 쉼 → 연속 0, 최근 활동 3일, 보너스 3일, 도구 2종.
assert(JSON.stringify(g.ornaments) === JSON.stringify(["recent_tools_2"]), `첫 단계에 못 미친 축은 장식 없음 (got ${g.ornaments})`);
assert(d0.ornaments.length === 0, "휴면 → 장식 없음");

const dayAt = (base: string, offset: number) => new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const run = (from: string, n: number, o: Partial<GrowthDay> = {}): GrowthDay[] =>
  Array.from({ length: n }, (_, i) => ({ date: dayAt(from, i), tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"], ...o }));

// 40일 연속(08-01~09-09), 오늘 = 마지막 활동일.
const steady = computeGrowth(run("2026-08-01", 40), "2026-07-18", "2026-09-09");
assert(steady.streakDays === 40, `40일 연속 (got ${steady.streakDays})`);
assert(
  JSON.stringify(steady.ornaments) === JSON.stringify(["streak_30", "recent_days_30", "recent_bonus_25", "recent_tools_2"]),
  `축마다 최고 단계 하나만 (got ${steady.ornaments})`,
);
assert(steady.milestones.includes("streak_3") && steady.milestones.includes("streak_30"), "누적 기록은 낮은 단계까지 그대로 보관");

// 같은 사람이 20일 쉬면 장식은 내려가고, 누적 기록은 남는다.
const rested = computeGrowth(run("2026-08-01", 40), "2026-07-18", "2026-09-29");
assert(
  JSON.stringify(rested.ornaments) === JSON.stringify(["recent_days_10", "recent_bonus_10", "recent_tools_2"]),
  `쉬면 장식이 내려감 — 창 30일 중 활동 10일 (got ${rested.ornaments})`,
);
assert(rested.milestones.includes("streak_30"), "쉬어도 누적 기록(30일 연속)은 남음");

// 보너스 3점 미만인 날은 보너스 축에 세지 않는다. 도구는 창 안에서 쓴 것만 센다.
const light = computeGrowth(
  [...run("2026-08-01", 5, { tools: ["a", "b", "c", "d", "e", "f"] }), ...run("2026-08-11", 30, { tokens: 0, requests: 0, families: [], tools: ["claude_code"] })],
  "2026-07-18", "2026-09-09",
);
assert(!light.ornaments.some((k) => k.startsWith("recent_bonus_")), `가벼운 사용만 → 보너스 장식 없음 (got ${light.ornaments})`);
assert(!light.ornaments.some((k) => k.startsWith("recent_tools_")), `창 밖 도구는 세지 않음 — 창 안 1종 (got ${light.ornaments})`);
assert(light.ornaments.includes("recent_days_30"), "창 30일 모두 활동 → 최근 활동 최고 단계");

// 확인 중인 날은 창에서 건너뛴다 — 보고서를 기다리는 날 때문에 만점 단계를 놓치지 않는다.
const waiting = computeGrowth(run("2026-08-01", 39), "2026-07-18", "2026-09-09", undefined, new Set(["2026-09-09"]));
assert(waiting.ornaments.includes("recent_days_30"), `오늘이 확인 중 → 그 전 30일로 판정 (got ${waiting.ornaments})`);
const unwaited = computeGrowth(run("2026-08-01", 39), "2026-07-18", "2026-09-09");
assert(unwaited.ornaments.includes("recent_days_25"), `오늘이 빈 날로 확정 → 29일 (got ${unwaited.ornaments})`);

// --- 결정성 ---
assert(JSON.stringify(computeGrowth(days, "2026-07-18", "2026-07-23")) === JSON.stringify(g), "같은 입력 → 같은 결과");
assert(JSON.stringify(computeGrowth([...days].reverse(), "2026-07-18", "2026-07-23")) === JSON.stringify(g), "입력 순서 무관");

console.log("ALL PASS");
