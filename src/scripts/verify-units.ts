// 환산 단위(토큰 / API 정가 환산 $ / 기준 모델 환산 토큰) — 순수 함수 검증. DB 불필요.
import { SEED_TABLE, type ModelPrice, type PriceTable } from "@/lib/pricing";
import {
  billableTokens,
  convert,
  defaultRefFamily,
  parseUnit,
  pricedFamilies,
  refRates,
  resolveUnitSelection,
  sumConverted,
  unitLabel,
  unpricedNote,
  REF_TOOLTIP,
  USD_DISCLAIMER,
} from "@/lib/units";

let checks = 0;
function assert(cond: boolean, msg: string) {
  checks++;
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

const D = "2026-09-30";
const M = 1_000_000;
const opusOut = { model: "claude-opus-4-8", tool: "claude_code", outputTokens: M };

// ---- raw: 기본 전체 처리량 + 기존 기준 재현 ------------------------
{
  const row = {
    model: "claude-opus-4-8",
    tool: "claude_code",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5000,
    cacheCreationTokens: 700,
  };
  const r = convert(SEED_TABLE, row, "raw", "sonnet", D);
  assert(r.value === 5820 && r.unpriced === false, "raw default = input+output+cache");
  const legacy = convert(SEED_TABLE, row, "raw", "sonnet", D, "legacy");
  assert(legacy.value === 120 && !legacy.unpriced, "raw legacy = input+output, cache excluded");
  const u = convert(SEED_TABLE, { model: "grok-4", tool: "grok", inputTokens: 3, outputTokens: 4 }, "raw", "sonnet", D);
  assert(u.value === 7 && u.unpriced === false, "raw never unpriced (unpriced model still counts raw)");
}

// ---- usd = 4종 × 단가 / 1e6 -----------------------------------------------------
{
  const r = convert(SEED_TABLE, opusOut, "usd", "sonnet", D);
  assert(near(r.value, 25) && !r.unpriced, "Opus 1M output → usd 25");
  const all = convert(
    SEED_TABLE,
    {
      model: "claude-sonnet-4-6",
      tool: "claude_code",
      inputTokens: M,
      outputTokens: M,
      cacheReadTokens: M,
      cacheCreationTokens: M,
    },
    "usd",
    "sonnet",
    D,
  );
  assert(near(all.value, 3 + 15 + 0.3 + 3.75), "usd sums all four kinds (sonnet 4.x: 3+15+0.3+3.75)");
}

// ---- ref = Σ 종류별(토큰 × 모델단가 ÷ 기준단가) ----------------------------------
{
  const s = convert(SEED_TABLE, opusOut, "ref", "sonnet", D);
  assert(near(s.value, (M * 25) / 15) && !s.unpriced, "Sonnet ref: Opus 1M output → 1M×25/15");
  const h = convert(SEED_TABLE, opusOut, "ref", "haiku", D);
  assert(near(h.value, (M * 25) / 5), "Haiku ref: Opus 1M output → 1M×25/5");
  assert(!near(h.value, s.value), "switching ref Sonnet→Haiku changes ref");
  const usdS = convert(SEED_TABLE, opusOut, "usd", "sonnet", D);
  const usdH = convert(SEED_TABLE, opusOut, "usd", "haiku", D);
  assert(usdS.value === usdH.value, "switching ref Sonnet→Haiku leaves usd unchanged");

  // 기준 모델 자신은 원본 4종 합과 같다(단가 ÷ 자기 단가 = 1).
  const self = convert(
    SEED_TABLE,
    { model: "claude-haiku-4-5", tool: "claude_code", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 },
    "ref",
    "haiku",
    D,
  );
  assert(near(self.value, 100), "ref of the ref model itself = its 4-kind token sum");

  // 종류별로 나눈다: input 1M + output 1M Opus → Sonnet 기준 1M×5/3 + 1M×25/15.
  const mix = convert(SEED_TABLE, { ...opusOut, inputTokens: M }, "ref", "sonnet", D);
  assert(near(mix.value, (M * 5) / 3 + (M * 25) / 15), "ref is per kind (input/3 + output/15)");
}

// ---- 기준 단가가 0인 종류 → usd_k / ref.input (raw 토큰을 그대로 더하지 않는다) ----
{
  // gpt5 기준(cacheWrite 0): Sonnet 4.x cacheWrite 1M = $3.75 → 3.75 / 1.25 × 1M = 3M.
  const w = convert(
    SEED_TABLE,
    { model: "claude-sonnet-4-6", tool: "claude_code", cacheCreationTokens: M },
    "ref",
    "gpt5",
    D,
  );
  assert(near(w.value, (M * 3.75) / 1.25), "gpt5 ref, cacheWrite 1M sonnet → usd_k / ref.input = 3M");
  assert(!near(w.value, M), "…not the raw 1M cacheWrite tokens");
  assert(Number.isFinite(w.value), "…and never Infinity");
  // 모델 단가도 0(gpt 계열 cacheWrite)이면 기여 0 — usd와 같은 규칙.
  const g = convert(SEED_TABLE, { model: "gpt-5.2", tool: "codex", cacheCreationTokens: M }, "ref", "gpt5", D);
  assert(g.value === 0 && !g.unpriced, "gpt cacheWrite tokens at model price 0 → ref 0 (as usd 0)");
  // 모든 단가가 0인 기준 → 환산 불가 = unpriced.
  const zero: PriceTable = {
    entries: [
      ...SEED_TABLE.entries,
      { ...SEED_TABLE.entries[0], family: "free", match: ["=free"], priority: 700, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ],
  };
  const z = convert(zero, opusOut, "ref", "free", D);
  assert(z.value === 0 && z.unpriced, "all-zero ref prices → value 0, unpriced");
}

// ---- 단가 미정 행 → value 0 · unpriced true -------------------------------------
{
  const row = { model: "grok-4", tool: "grok", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 };
  for (const unit of ["usd", "ref"] as const) {
    const r = convert(SEED_TABLE, row, unit, "sonnet", D);
    assert(r.value === 0 && r.unpriced === true, `unpriced row → ${unit} 0, unpriced true`);
  }
  const empty = convert(SEED_TABLE, { model: "grok-4", tool: "grok" }, "usd", "sonnet", D);
  assert(empty.value === 0 && !empty.unpriced, "row with no tokens is not unpriced");
  assert(billableTokens(row) === 115, "billableTokens = all four kinds");
}

// ---- 날짜별 단가 버전 -------------------------------------------------------------
{
  const v: ModelPrice = { ...SEED_TABLE.entries.find((e) => e.family === "sonnet")!, effectiveFrom: "2026-10-01", input: 6, output: 30 };
  const t: PriceTable = { entries: [...SEED_TABLE.entries, v] };
  const before = convert(t, opusOut, "ref", "sonnet", "2026-09-30");
  const after = convert(t, opusOut, "ref", "sonnet", "2026-10-01");
  assert(near(before.value, (M * 25) / 15) && near(after.value, (M * 25) / 30), "ref price = the ref family's version in effect on the date");
  assert(refRates(t, "sonnet", "2026-10-02")?.input === 6, "refRates picks the latest version <= date");
  // 기준 계열이 그 날짜에 아직 없으면 가장 이른 버전을 쓴다(기준이 비지 않게).
  const late: PriceTable = {
    entries: [...SEED_TABLE.entries, { ...v, family: "newref", match: ["=newref"], priority: 600, effectiveFrom: "2026-12-01", input: 2 }],
  };
  assert(refRates(late, "newref", "2026-09-30")?.input === 2, "ref family not yet effective → its earliest version");
  assert(refRates(late, "nope", D) === null, "unknown ref family → null");
  // gpt5 has "" (90) and codex (900) scopes — the "" one (lower priority) wins a tie.
  assert(refRates(SEED_TABLE, "gpt5", D)?.input === 1.25, "gpt5 ref rates");
}

// ---- 기본 기준 모델 = sonnet 계열 중 priority 최소, 동률이면 effectiveFrom 최신 ----
{
  assert(defaultRefFamily(SEED_TABLE) === "sonnet-5", "seed default ref = sonnet-5 (priority 25 < sonnet 30)");
  const noVersion: PriceTable = { entries: SEED_TABLE.entries.filter((e) => e.family !== "sonnet-5") };
  assert(defaultRefFamily(noVersion) === "sonnet", "without sonnet-5 → sonnet");
  // Same priority → latest effectiveFrom.
  const a: ModelPrice = { ...SEED_TABLE.entries[0], family: "sonnet-a", match: ["=a"], priority: 1, effectiveFrom: "2026-01-01" };
  const b: ModelPrice = { ...a, family: "sonnet-b", effectiveFrom: "2026-06-01" };
  assert(defaultRefFamily({ entries: [...SEED_TABLE.entries, a, b] }) === "sonnet-b", "priority tie → latest effectiveFrom");
  assert(defaultRefFamily({ entries: SEED_TABLE.entries.filter((e) => !e.family.startsWith("sonnet")) }) === "fable-5.1", "no sonnet family → first family by priority");
  assert(defaultRefFamily({ entries: [] }) === null, "empty table → null");
}

// ---- 드롭다운 = 단가 등록 계열 전부, 계열당 하나 ---------------------------------
{
  const fams = pricedFamilies(SEED_TABLE);
  assert(new Set(fams).size === fams.length, "one option per family");
  assert(fams.length === 13, `every seeded family listed (got ${fams.length}: ${fams.join(",")})`);
  assert(fams[0] === "fable-5.1" && fams.includes("gpt5") && fams.includes("cursor-default"), "ordered by priority, includes gpt5 and cursor-default");
}

// ---- URL 파라미터 해석 ------------------------------------------------------------
{
  assert(parseUnit("usd") === "usd" && parseUnit("ref") === "ref" && parseUnit("raw") === "raw", "parseUnit known values");
  assert(parseUnit(undefined) === "raw" && parseUnit("pct") === "raw", "parseUnit default raw (한도 % is not a unit here)");
  const s1 = resolveUnitSelection(SEED_TABLE, { unit: "ref", ref: "opus" });
  assert(s1.unit === "ref" && s1.ref === "opus", "?unit=ref&ref=opus kept");
  const s2 = resolveUnitSelection(SEED_TABLE, { unit: "ref", ref: "bogus" });
  assert(s2.ref === "sonnet-5", "unknown ?ref falls back to the default");
  const s3 = resolveUnitSelection({ entries: [] }, { unit: "ref" });
  assert(s3.unit === "raw", "no priced family → ref unavailable → raw");
  assert(s1.families.length === 13, "selection carries the dropdown families");
}

// ---- 합산·라벨 ----------------------------------------------------------------------
{
  const rows = [
    { date: "2026-09-29", tool: "claude_code", model: "claude-opus-4-8", outputTokens: M },
    { date: "2026-09-29", tool: "grok", model: "grok-4", inputTokens: 40, outputTokens: 2 },
    { date: "2026-09-30", tool: "claude_code", model: "claude-opus-4-8", outputTokens: M },
  ];
  const s = sumConverted(SEED_TABLE, rows, "usd", "sonnet", (r) => r.date);
  assert(near(s.totals.get("2026-09-29")!, 25) && near(s.totals.get("2026-09-30")!, 25), "sumConverted per key");
  assert(s.totals.has("2026-09-29") && s.unpricedTokens === 42, "unpriced tokens counted across the range");
  const raw = sumConverted(SEED_TABLE, rows, "raw", "sonnet", (r) => r.date);
  assert(raw.totals.get("2026-09-29") === M + 42 && raw.unpricedTokens === 0, "raw: no unpriced");

  assert(unitLabel("raw", "sonnet-5") === "토큰", "label raw");
  assert(unitLabel("usd", "sonnet-5") === "API 정가 환산 $", "label usd");
  assert(unitLabel("ref", "opus") === "opus 환산 토큰", "label ref");
  assert(REF_TOOLTIP === "토큰 종류별 단가 비율로 계산한 추정값이며 기준 모델에 따라 값이 달라집니다.", "tooltip text");
  assert(USD_DISCLAIMER === "공개 단가 추정값 · 청구 금액·구독료가 아닙니다.", "usd disclaimer");
  assert(unpricedNote("1,234") === "미환산 원본 1,234토큰 · 단가 미등록", "unpriced note");
}

console.log(`${checks} checks`);
console.log("ALL PASS");
