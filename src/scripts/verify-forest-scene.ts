import { timeBand, hash32, treeLayout, pickAnimal, ornamentsFor, vitalityView } from "../lib/forest-scene";
import { ORNAMENT_CATALOG } from "../lib/growth";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 시간밴드 경계 (KST hour)
assert(timeBand(4) === "night", "04시 밤");
assert(timeBand(5) === "dawn", "05시 새벽");
assert(timeBand(7) === "dawn", "07시 새벽");
assert(timeBand(8) === "day", "08시 낮");
assert(timeBand(16) === "day", "16시 낮");
assert(timeBand(17) === "dusk", "17시 노을");
assert(timeBand(19) === "dusk", "19시 노을");
assert(timeBand(20) === "night", "20시 밤");
assert(timeBand(23) === "night", "23시 밤");

// 배치: 결정성 + 입력 순서 무관 + GP 무상관(gp를 아예 안 받음 — 시그니처가 ids만)
const ids = ["m-aaa", "m-bbb", "m-ccc", "m-ddd", "m-eee"];
const l1 = treeLayout(ids);
const l2 = treeLayout([...ids].reverse());
assert(JSON.stringify(l1) === JSON.stringify(l2), "입력 순서 무관 — 같은 출력");
assert(JSON.stringify(treeLayout(ids)) === JSON.stringify(l1), "결정적 — 같은 입력 같은 출력");
assert(l1.length === 5 && new Set(l1.map((p) => p.id)).size === 5, "전원 배치");
assert(l1.every((p) => p.xPct >= 5 && p.xPct <= 95), `x 5~95% 범위 (got ${l1.map((p) => p.xPct)})`);
assert(l1.every((p) => p.swayDur >= 3.6 && p.swayDur <= 6.0), "sway 주기 3.6~6.0초");
assert(new Set(l1.map((p) => p.swayDur)).size >= 3, "주기 분산(전부 동일 아님)");
// x 좌표는 id 해시로만 결정 — 정렬 후 인접 간격이 슬롯 기반인지
const xs = l1.map((p) => p.xPct).sort((a, b) => a - b);
assert(xs.every((x, i) => i === 0 || x - xs[i - 1] > 3), "나무 겹침 없음(간격 >3%)");

// 동물: 시드 결정성 + 밴드별 후보군
assert(pickAnimal(7, "day") === pickAnimal(7, "day"), "같은 시드 같은 동물");
assert(["🐿️", "🐇"].includes(pickAnimal(0, "day")) && ["🐿️", "🐇"].includes(pickAnimal(1, "dawn")), "낮·새벽 = 🐿️/🐇");
assert(["🦌", "🦉"].includes(pickAnimal(0, "night")) && ["🦌", "🦉"].includes(pickAnimal(1, "night")), "밤 = 🦌/🦉");
assert(["🐿️", "🐇"].includes(pickAnimal(2, "dusk")), "노을 = 낮 후보군");

// --- 장식 매핑 (요즘 상태 — 축마다 하나) ---
const CATALOG_KEYS = ORNAMENT_CATALOG.map((m) => m.key);
const full = ornamentsFor(CATALOG_KEYS);
assert(full.length === CATALOG_KEYS.length, `카탈로그의 모든 키에 장식이 있음 (got ${full.length}/${CATALOG_KEYS.length})`);
assert(
  full.every((o) => ORNAMENT_CATALOG.find((m) => m.key === o.key)!.emoji === o.emoji),
  "장식 이모지 = 카탈로그 이모지",
);
const ZONE_OF: Record<string, string> = { streak: "air", recent_days: "ground", recent_bonus: "aura", recent_tools: "flora" };
assert(
  full.every((o) => ZONE_OF[ORNAMENT_CATALOG.find((m) => m.key === o.key)!.axis] === o.zone),
  "축마다 zone 하나 (연속=air·활동=ground·보너스=aura·도구=flora)",
);
assert(full.filter((o) => o.zone === "aura").every((o) => !!o.glow), "aura 장식은 광채 클래스를 가짐");
assert(full.filter((o) => o.zone !== "aura").every((o) => o.glow === undefined), "aura 밖에는 광채 없음");

// 결정성 — 입력 순서 뒤집어도 동일 출력
assert(
  JSON.stringify(ornamentsFor([...CATALOG_KEYS].reverse())) === JSON.stringify(full),
  "장식 매핑 입력순서 무관 — 동일 출력",
);

// 실제 나무: 축마다 하나 → zone마다 index 0 하나
const tree = ornamentsFor(["streak_60", "recent_days_25", "recent_bonus_15", "recent_tools_4"]);
assert(tree.length === 4 && tree.every((o) => o.index === 0), "축마다 하나 → 4개, 전부 index 0");
assert(tree.map((o) => o.emoji).join("") === "⭐🦌🌞🌻", `이모지 (got ${tree.map((o) => o.emoji).join("")})`);
assert(tree.find((o) => o.key === "recent_bonus_15")!.glow === "glow-strong", "보너스 15일 → 강한 광채");

// 매핑에 없는 키·빈 배열 → 빈 리스트, 예외 없음. 옛 누적 키는 장식이 아니다.
assert(ornamentsFor([]).length === 0, "빈 입력 → 빈 리스트");
assert(ornamentsFor(["bogus_9", "streak_999", "active_days_100", "tools_4"]).length === 0, "미지 키·옛 누적 키 무시");

// 활력 뷰
assert(vitalityView("dozing").sleepEmoji === "💤", "dozing → 💤");
assert(vitalityView("dozing").swayClass === "fs-vital-dozing", "dozing → dozing 클래스");
assert(vitalityView("lively").sleepEmoji === null, "lively → 💤 없음");
assert(vitalityView("lively").swayClass === "fs-vital-lively", "lively → lively 클래스");
assert(vitalityView("neutral").sleepEmoji === null && vitalityView("neutral").swayClass === "", "neutral → 빈 클래스·null");

console.log("ALL PASS");
