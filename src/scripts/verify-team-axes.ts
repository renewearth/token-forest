// 팀 세 축 주간 집계(순수 계산) 검증. DB 접속 없음.
import { median, mondayOf, teamAxesWeekly } from "@/lib/team-axes";
import type { GrowthDay } from "@/lib/growth";

let failed = 0;
let passed = 0;
function assert(ok: boolean, label: string) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
}
const day = (date: string, tokens: number, families: string[], requests = 0): GrowthDay => ({ date, tools: ["t"], tokens, requests, families });

assert(mondayOf("2026-03-04") === "2026-03-02" && mondayOf("2026-03-08") === "2026-03-02" && mondayOf("2026-03-09") === "2026-03-09", "mondayOf: 월요일 시작");
assert(median([]) === null && median([3]) === 3 && median([1, 4]) === 2.5 && median([5, 1, 3]) === 3, "median");

// 2026-03-02(월) ~ 03-08(일) 한 주, 구성원 3명.
const a = [day("2026-03-02", 60_000, ["x"]), day("2026-03-03", 250_000, ["x", "y"]), day("2026-03-04", 1_200_000, ["y"]), day("2026-03-05", 60_000, ["x"]), day("2026-03-06", 60_000, ["z"])];
const b = [day("2026-03-02", 0, [], 12), day("2026-03-07", 5_000_000, ["x"])];
const c: GrowthDay[] = [];
const [w] = teamAxesWeekly([a, b, c], { from: "2026-03-04", today: "2026-03-08" });
assert(w.week === "2026-03-02" && w.countedDays === 7 && w.complete, "from이 속한 주의 월요일부터, 7일 완주");
assert(w.members === 3 && w.activeMembers === 2, "활동 인원 2/3");
assert(w.frequency === 2, `자주: [5,2,0]의 중간값 2 (got ${w.frequency})`);
// a 단계 [1,2,3,1,1] → 1, b 단계 [1(요청 12건), 4] → 2.5; 중간값 1.75
assert(w.volume === 1.75, `많이: 활동한 사람만, 요청 수 단계도 인정 (got ${w.volume})`);
assert(w.diversity === 2, `다양하게: a 3종·b 1종 → 2 (got ${w.diversity})`);

// 진행 중인 주 + 확인 중인 날은 분모에서 빠진다.
const weeks = teamAxesWeekly([a, b, [day("2026-03-11", 60_000, ["x"])]], { from: "2026-03-02", today: "2026-03-11", unconfirmed: new Set(["2026-03-10", "2026-03-11"]) });
assert(weeks.length === 2 && weeks[1].week === "2026-03-09", "주 두 개");
assert(weeks[1].countedDays === 1 && !weeks[1].complete, "오늘 이후·확인 중 제외 → 센 날 1일");
assert(weeks[1].frequency === 0 && weeks[1].activeMembers === 0 && weeks[1].volume === null && weeks[1].diversity === null, "확인 중인 날의 활동은 세지 않음, 활동자 없으면 많이·다양하게는 값 없음");

const none = teamAxesWeekly([a], { from: "2026-03-09", today: "2026-03-09", unconfirmed: new Set(["2026-03-09"]) });
assert(none[0].countedDays === 0 && none[0].frequency === null, "센 날이 없으면 값 없음(0으로 채우지 않음)");
assert(teamAxesWeekly([], { from: "2026-03-02", today: "2026-03-08" })[0].frequency === null, "구성원 0명 → 값 없음");

console.log(failed ? `${failed} FAILED` : `ALL PASS (${passed})`);
process.exit(failed ? 1 : 0);
