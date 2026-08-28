import { milestoneGroups, STAGE_LEGEND, STATE_LEGEND } from "../lib/forest-symbols";
import { STREAK_CATALOG, MILESTONE_CATALOG } from "../lib/growth";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

const groups = milestoneGroups();
assert(groups.length === 4, `4축 (got ${groups.length})`);
assert(groups.map((g) => g.axis).join(",") === "streak,active_days,efficiency,tools", "축 순서");
const counts = groups.map((g) => g.tiers.length);
assert(JSON.stringify(counts) === JSON.stringify([5, 5, 2, 3]), `티어 개수 5·5·2·3 (got ${counts})`);
for (const g of groups) {
  assert(g.axisLabel.length > 0 && g.meaning.length > 0, `${g.axis} 라벨·의미 존재`);
  for (const t of g.tiers) {
    const cat = MILESTONE_CATALOG.find((m) => m.emoji === t.emoji);
    assert(!!cat && cat.threshold === t.threshold, `${t.emoji} threshold 정합`);
  }
}
assert(STAGE_LEGEND.length === 7, `단계 7개 (got ${STAGE_LEGEND.length})`);
assert(STAGE_LEGEND[0].emoji === "🌰" && STAGE_LEGEND[0].threshold === undefined, "첫 단계 🌰 threshold 없음");
const stageThr = STAGE_LEGEND.slice(1).map((s) => s.threshold as number);
assert(stageThr.every((t, i) => i === 0 || t > stageThr[i - 1]), `단계 minGp 오름차순 (got ${stageThr})`);
assert(
  STATE_LEGEND.length === 4 &&
    ["🔥", "🟠", "🎟️", "💤"].every((e) => STATE_LEGEND.some((s) => s.emoji === e)),
  "상태 🔥·🟠·🎟️·💤",
);
assert(STREAK_CATALOG.length === 5, `STREAK_CATALOG 5 (got ${STREAK_CATALOG.length})`);
const days = STREAK_CATALOG.map((s) => s.days).sort((a, b) => a - b);
assert(JSON.stringify(days) === JSON.stringify([3, 7, 14, 30, 60]), `스트릭 days {3,7,14,30,60} (got ${days})`);
assert(STREAK_CATALOG.every((s) => s.mult > 0), "mult 양수");

console.log("ALL PASS");
