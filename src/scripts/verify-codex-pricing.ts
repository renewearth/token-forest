import { RATES, SEED_TABLE, matchPrice, priceFor } from "@/lib/pricing";
import { toolLabel, toolSlot } from "@/app/_lib/ui";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

// 단가는 DB 단가표(modelprices)로 옮겨졌다 — 여기서는 그 시드(SEED_TABLE)로 확인.
const D = "2026-09-30";
const family = (model: string, tool: string) => matchPrice(SEED_TABLE, model, tool, D)?.family;
const same = (a: ReturnType<typeof priceFor>, b: (typeof RATES)[keyof typeof RATES]) =>
  !!a && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

// codex 모델명은 gptCodex로.
assert(family("gpt-5.3-codex", "codex") === "gptCodex", "gpt-5.3-codex -> gptCodex");
assert(family("gpt-5.3-codex-high-fast", "codex") === "gptCodex", "codex-high-fast -> gptCodex");
// codex CLI가 gpt-5.5를 쓰면 gpt55.
assert(family("gpt-5.5", "codex") === "gpt55", "gpt-5.5 -> gpt55");
// 빈 모델(model breakdown 없음)인 codex 행은 sonnet이 아니라 gpt5로 fallback.
assert(family("", "codex") === "gpt5" && same(priceFor(SEED_TABLE, "", "codex", D), RATES.gpt5), "empty codex model -> gpt5 (not sonnet)");
// codex 폴백은 codex 도구에만 (over-broaden 방지 가드): cursor 빈 모델은 기존대로
// sonnet 단가(명시 시드 항목 cursor-default), 그 밖의 도구는 단가 미정.
assert(same(priceFor(SEED_TABLE, "", "cursor", D), RATES.sonnet), "empty cursor model -> sonnet rates (unchanged)");
assert(priceFor(SEED_TABLE, "", "copilot", D) === null, "empty copilot model -> unpriced (codex fallback not broadened)");

// codex는 대시보드에서 고유 라벨·고유 색 슬롯을 가져야 한다(Copilot과 색 충돌 방지).
assert(toolLabel("codex") === "Codex", "toolLabel codex -> Codex");
assert(toolSlot("codex") !== toolSlot("copilot"), "codex slot != copilot slot");

// opencode: 고유 라벨·색 슬롯(기존 도구 전부와 겹치지 않음).
assert(toolLabel("opencode") === "OpenCode", "toolLabel opencode -> OpenCode");
for (const t of ["cursor", "claude_code", "codex", "copilot", "anthropic", "gemini", "grok"])
  assert(toolSlot("opencode") !== toolSlot(t), `opencode slot != ${t} slot`);

console.log("ALL PASS");
