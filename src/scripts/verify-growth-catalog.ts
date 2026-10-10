import { computeGrowth, MILESTONE_CATALOG, STAGE_CATALOG } from "../lib/growth";
import type { GrowthDay } from "../lib/growth";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 카탈로그 형태
assert(MILESTONE_CATALOG.length === 15, `마일스톤 15개 (got ${MILESTONE_CATALOG.length})`);
assert(new Set(MILESTONE_CATALOG.map((m) => m.key)).size === 15, "키 중복 없음");
assert(
  MILESTONE_CATALOG.every((m) => m.key === `${m.axis}_${m.threshold}` && m.emoji && m.label),
  "키 = axis_threshold, emoji·label 채워짐",
);
assert(STAGE_CATALOG.length === 6, `스테이지 6단계 (got ${STAGE_CATALOG.length})`);
assert(
  JSON.stringify(STAGE_CATALOG.map((s) => s.minGp)) === JSON.stringify([0, 50, 150, 350, 700, 1300]),
  "임계값 0/50/150/350/700/1300",
);

// 엔진이 뱉는 unlocked 키가 전부 카탈로그에 존재 (verify-growth.ts 픽스처 재사용)
const days: GrowthDay[] = [
  { date: "2026-07-18", tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"] },
  { date: "2026-07-19", tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"] },
  { date: "2026-07-20", tools: ["claude_code", "codex"], tokens: 4_000_000, requests: 300, families: ["opus", "gpt"] },
];
const g = computeGrowth(days, "2026-07-18", "2026-07-23");
const keys = new Set(MILESTONE_CATALOG.map((m) => m.key));
assert(g.milestones.length > 0, "픽스처에서 언락 존재");
assert(g.milestones.every((k) => keys.has(k)), `언락 키 전부 카탈로그에 존재 (${g.milestones})`);

console.log("ALL PASS");
