import "./env";
import mongoose from "mongoose";
import {
  RATES,
  SEED_PRICES,
  SEED_TABLE,
  estimateWeight,
  estimateWeightWith,
  matchPrice,
  newFamilyPriority,
  priceFor,
  type ModelPrice,
  type PriceTable,
  type Rates,
} from "@/lib/pricing";
import { deletePrice, listUnpriced, loadPriceTable, priceInputSchema, registerPrice } from "@/lib/price-table";
import { addDays, todayKst } from "@/lib/date";
import { closeDb, connectDb, ModelPrice as ModelPriceModel, UsageDaily } from "@/lib/db";

let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log("ok:", msg);
  else {
    failed++;
    console.error("FAIL:", msg);
  }
}

// ---- frozen oracle: rateFamily() as it was before prices moved to the DB ----
// (copied verbatim from src/lib/pricing.ts @ 80379e1 — do not "fix" it; it is
// the reference the seeded table must reproduce).
function legacyRateFamily(model: string, tool: string): keyof typeof RATES {
  const m = model.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("composer")) return "composer";
  if (m.includes("codex")) return "gptCodex";
  if (m.includes("gpt-5.5") || m.includes("gpt-5.6")) return "gpt55";
  if (m.includes("gpt-4o")) return "gpt4o";
  if (m.includes("gpt-") || /^o\d/.test(m)) return "gpt5";
  return tool === "codex" ? "gpt5" : "sonnet";
}

const sameRates = (a: Rates | null, b: Rates) =>
  a !== null &&
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite;

// Every model name from verify-codex-pricing.ts and the pricing.ts comments,
// plus one representative per keyword family, with the tool it arrives under.
const LEGACY_CASES: Array<[model: string, tool: string]> = [
  ["gpt-5.3-codex", "codex"],
  ["gpt-5.3-codex-high-fast", "codex"],
  ["gpt-5.5", "codex"],
  ["", "codex"],
  ["", "cursor"],
  ["default", "cursor"],
  ["premium", "cursor"],
  ["auto", "cursor"], // R9: Cursor placeholders from the NON_MODEL_NAMES set
  ["unknown", "cursor"],
  ["claude-opus-4-8-thinking-high", "cursor"],
  ["claude-4.6-sonnet-medium-thinking", "cursor"],
  ["claude-haiku-4-5-20251001", "claude_code"],
  ["gpt-5.2", "copilot"],
  ["claude-fable-5", "claude_code"],
  ["claude-mythos-preview", "claude_code"],
  ["claude-opus-4-8", "claude_code"],
  ["claude-sonnet-4-5", "claude_code"],
  ["claude-sonnet-4-6", "claude_code"],
  ["composer-1", "cursor"],
  ["gpt-5.6-pro", "codex"],
  ["gpt-4o-mini", "copilot"],
  ["o3", "codex"],
  ["o4-mini", "copilot"],
  ["GPT-5.1-Codex-Max", "codex"],
  // codex tool, no keyword → legacy per-tool fallback gpt5 (kept as an
  // explicit codex-scoped seed entry).
  ["some-unlisted-model", "codex"],
];

function pureTests() {
  // (1) seed reproduces RATES[rateFamily()] for every legacy case
  for (const [model, tool] of LEGACY_CASES) {
    const want = RATES[legacyRateFamily(model, tool)];
    const got = priceFor(SEED_TABLE, model, tool, "2026-09-30");
    check(sameRates(got, want), `seed priceFor(${JSON.stringify(model)}, ${tool}) == legacy ${legacyRateFamily(model, tool)}`);
    // the seed covers the whole past too (old constants applied to every date)
    check(sameRates(priceFor(SEED_TABLE, model, tool, "2025-01-01"), want), `seed covers past dates for ${JSON.stringify(model)}/${tool}`);
  }
  // R11: current Claude versions carry their own list prices (2026-09-30
  // platform.claude.com pricing) — these intentionally differ from RATES.
  const VERSIONED: Array<[model: string, family: string, rates: Rates]> = [
    ["claude-opus-5-5", "opus-5.5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    ["claude-opus-5.5-thinking", "opus-5.5", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    ["claude-sonnet-5-5", "sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["claude-sonnet-5", "sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["claude-sonnet-5.5", "sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
    ["claude-fable-5-1", "fable-5.1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
    ["claude-fable-5.1", "fable-5.1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ];
  for (const [model, fam, want] of VERSIONED) {
    for (const tool of ["claude_code", "cursor"]) {
      check(matchPrice(SEED_TABLE, model, tool, "2026-09-30")?.family === fam, `${model}/${tool} → version family ${fam}`);
      check(sameRates(priceFor(SEED_TABLE, model, tool, "2026-09-30"), want), `${model}/${tool} → ${JSON.stringify(want)}`);
    }
  }
  // older versions stay on the family entries
  for (const [model, fam] of [
    ["claude-sonnet-4-5", "sonnet"],
    ["claude-4.6-sonnet-medium-thinking", "sonnet"],
    ["claude-sonnet-4-6", "sonnet"],
    ["claude-opus-4-8", "opus"],
    ["claude-opus-5", "opus"],
    ["claude-fable-5", "fable"],
    ["claude-haiku-4-5-20251001", "haiku"],
  ] as const) {
    check(matchPrice(SEED_TABLE, model, "claude_code", "2026-09-30")?.family === fam, `${model} stays on family ${fam}`);
  }
  for (const e of SEED_PRICES.filter((x) => ["opus-5.5", "sonnet-5", "fable-5.1"].includes(x.family))) {
    check(
      e.sourceUrl === "https://platform.claude.com/docs/en/about-claude/pricing" &&
        e.checkedAt === "2026-09-30" &&
        e.note === "버전별 단가(2026-09-30 확인)",
      `version seed ${e.family} source/checkedAt/note`,
    );
    const base = SEED_PRICES.find((x) => x.family === e.family.split("-")[0])!;
    check(e.priority < base.priority, `version seed ${e.family} (${e.priority}) matches before family ${base.family} (${base.priority})`);
  }
  check(SEED_PRICES.filter((x) => ["opus-5.5", "sonnet-5", "fable-5.1"].includes(x.family)).length === 3, "three version seed entries");

  check(LEGACY_CASES.length >= 20, `at least 20 legacy cases (${LEGACY_CASES.length})`);

  // family names stay stable for the tier chart
  check(matchPrice(SEED_TABLE, "gpt-5.3-codex", "codex", "2026-09-30")?.family === "gptCodex", "gpt-5.3-codex family gptCodex");
  check(matchPrice(SEED_TABLE, "", "codex", "2026-09-30")?.family === "gpt5", "empty codex model family gpt5");
  check(matchPrice(SEED_TABLE, "claude-opus-4-8", "claude_code", "2026-09-30")?.family === "opus", "opus family");

  // seed metadata
  for (const e of SEED_PRICES) {
    check(/^https:\/\//.test(e.sourceUrl), `seed ${e.family}/${e.provider || "*"} has https sourceUrl`);
    check(e.registeredBy === "seed", `seed ${e.family} registeredBy seed`);
  }
  const composer = SEED_PRICES.find((e) => e.family === "composer");
  check(composer?.note === "공개 단가 없음 — Sonnet 급 가정(기존 정책)", "composer note = 기존 정책");
  const nonModel = SEED_PRICES.find((e) => e.provider === "cursor");
  check(nonModel?.note === "공개 단가 없음 — Sonnet 급 가정(기존 정책)", "cursor non-model note = 기존 정책");
  check(SEED_PRICES.filter((e) => e.provider === "").every((e) => e.family === "composer" || e.note === "2026-07-18 코드 상수 이관" || e.note === "버전별 단가(2026-09-30 확인)"), "other seeds note = 2026-07-18 코드 상수 이관");
  const prios = SEED_PRICES.map((e) => e.priority);
  check(prios.every((p, i) => i === 0 || p > prios[i - 1]), "seed priorities strictly ascending (legacy rule order, version entries just before their family)");

  // (2) unknown models → null (sonnet fallback removed)
  check(priceFor(SEED_TABLE, "grok-4.2", "grok", "2026-09-30") === null, "grok-4.2 (grok) → null");
  check(priceFor(SEED_TABLE, "grok-4.2", "copilot", "2026-09-30") === null, "grok-4.2 (copilot) → null");
  check(priceFor(SEED_TABLE, "kimi-k2", "opencode", "2026-09-30") === null, "kimi-k2 (opencode) → null");
  check(priceFor(SEED_TABLE, "gemini-2.5-pro", "copilot", "2026-09-30") === null, "gemini-2.5-pro (copilot) → null");
  // non-model placeholders are cursor-scoped only
  check(priceFor(SEED_TABLE, "default", "copilot", "2026-09-30") === null, "default (copilot) → null");
  // explicit provider overrides tool for scope
  check(priceFor(SEED_TABLE, "", "cursor", "2026-09-30", "anthropic") === null, "provider arg overrides tool scope");

  // (3) effectiveFrom versions
  const base: Omit<ModelPrice, "effectiveFrom" | "input"> = {
    family: "testfam", match: ["testfam"], provider: "", priority: 500,
    output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    sourceUrl: "https://example.com/pricing", checkedAt: "2026-09-30", note: "", registeredBy: "t@example.com",
  };
  const versioned: PriceTable = {
    entries: [
      { ...base, effectiveFrom: "2026-07-01", input: 3 },
      { ...base, effectiveFrom: "2026-10-01", input: 4 },
    ],
  };
  check(priceFor(versioned, "testfam-1", "x", "2026-09-30")?.input === 3, "09-30 → $3 (07-01 version)");
  check(priceFor(versioned, "testfam-1", "x", "2026-10-01")?.input === 4, "10-01 → $4 (effective same day)");
  check(priceFor(versioned, "testfam-1", "x", "2026-10-02")?.input === 4, "10-02 → $4 (10-01 version)");
  check(priceFor(versioned, "testfam-1", "x", "2026-06-30") === null, "before first effectiveFrom → null");
  // empty match → family name itself
  const emptyMatch: PriceTable = { entries: [{ ...base, match: [], effectiveFrom: "2026-07-01", input: 3 }] };
  check(priceFor(emptyMatch, "my-TESTFAM-x", "x", "2026-09-30")?.input === 3, "empty match falls back to family substring (case-insensitive)");

  // R10: new-family priority = 600 − longest literal pattern (cap 100)
  check(newFamilyPriority(["grok"]) === 596, "newFamilyPriority([grok]) = 596");
  check(newFamilyPriority(["grok", "grok-4-fast"]) === 589, "longest literal wins (grok-4-fast → 589)");
  check(newFamilyPriority(["=kimi-k2"]) === 593, "=exact counts its literal length");
  check(newFamilyPriority(["x".repeat(300)]) === 500, "length capped at 100 → 500");
  check(newFamilyPriority(["x".repeat(300)]) < 900, "user families stay below codex fallback (900)");
  // #6: only non-regex patterns are lowercased
  const parsedMatch = priceInputSchema.shape.match.parse("/^O\\D/, GROK-4");
  check(JSON.stringify(parsedMatch) === JSON.stringify(["/^O\\D/", "grok-4"]), `regex pattern case preserved (${JSON.stringify(parsedMatch)})`);

  // (4) unpriced rows
  const w = estimateWeightWith(SEED_TABLE, { model: "kimi-k2", tool: "opencode", date: "2026-09-30", inputTokens: 1_000_000, outputTokens: 1_000_000 });
  check(w.usd === 0 && w.unpriced === true, "unpriced row → usd 0, unpriced true");
  const z = estimateWeightWith(SEED_TABLE, { model: "kimi-k2", tool: "opencode", date: "2026-09-30" });
  check(z.usd === 0 && z.unpriced === false, "zero-token unknown row → not counted as unpriced");
  const p = estimateWeightWith(SEED_TABLE, { model: "claude-sonnet-4-6", tool: "claude_code", date: "2026-09-30", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 });
  check(Math.abs(p.usd - (3 + 15 + 0.3 + 3.75)) < 1e-9 && p.unpriced === false, "priced row usd = Σ tokens × rate");
  check(estimateWeight({ model: "kimi-k2", tool: "opencode", inputTokens: 1_000_000 }) === 0, "sync estimateWeight: unpriced → 0");
  check(Math.abs(estimateWeight({ model: "claude-opus-4-8", tool: "claude_code", inputTokens: 1_000_000 }) - 5) < 1e-9, "sync estimateWeight: seed-based opus = 5");
}

async function dbTests() {
  const uri = process.env.MONGODB_URI ?? "";
  const dbName = uri.replace(/[?#].*$/, "").split("/").pop() ?? "";
  if (!dbName.startsWith("tf-v2-test")) {
    console.error(`REFUSING: DB name "${dbName}" does not start with tf-v2-test`);
    process.exit(1);
  }
  await connectDb();
  if (!mongoose.connection.name.startsWith("tf-v2-test")) {
    console.error(`REFUSING: connected DB "${mongoose.connection.name}" does not start with tf-v2-test`);
    process.exit(1);
  }
  await ModelPriceModel.deleteMany({});

  // seed on first load — concurrent first loads must not duplicate
  const [t1, t2] = await Promise.all([loadPriceTable(), loadPriceTable()]);
  const count = await ModelPriceModel.countDocuments();
  check(count === SEED_PRICES.length, `seeded once (${count} == ${SEED_PRICES.length})`);
  check(t1.entries.length === SEED_PRICES.length && t2.entries.length === SEED_PRICES.length, "both concurrent loads see the full seed");
  const t3 = await loadPriceTable();
  check((await ModelPriceModel.countDocuments()) === SEED_PRICES.length, "second load does not reseed");
  for (const [model, tool] of LEGACY_CASES) {
    check(sameRates(priceFor(t3, model, tool, "2026-09-30"), RATES[legacyRateFamily(model, tool)]), `DB table priceFor(${JSON.stringify(model)}, ${tool}) == legacy`);
  }

  // Registrations run against a fixed "today" (the backdate limit is relative).
  const TODAY = "2026-09-30";
  const reg = (i: unknown, by: string) => registerPrice(i, by, { today: TODAY });

  // (5) registration requires an https source URL
  const good = {
    family: "grok", match: "grok", provider: "", effectiveFrom: "2026-07-15",
    input: "3", output: "15", cacheRead: "0.75", cacheWrite: "0",
    checkedAt: "2026-09-30", note: "",
  };
  const noSrc = await reg({ ...good }, "t@example.com");
  check(noSrc.ok === false && !!noSrc.errors?.sourceUrl, "missing sourceUrl → rejected");
  const httpSrc = await reg({ ...good, sourceUrl: "http://docs.x.ai/pricing" }, "t@example.com");
  check(httpSrc.ok === false && !!httpSrc.errors?.sourceUrl, "http:// sourceUrl → rejected");
  const junkSrc = await reg({ ...good, sourceUrl: "https://" }, "t@example.com");
  check(junkSrc.ok === false && !!junkSrc.errors?.sourceUrl, "bare https:// → rejected");
  check((await ModelPriceModel.countDocuments({ family: "grok" })) === 0, "rejected registrations stored nothing");
  const ok = await reg({ ...good, sourceUrl: "https://docs.x.ai/docs/models" }, "t@example.com");
  check(ok.ok === true, `valid registration accepted (${JSON.stringify(ok)})`);
  const stored = await ModelPriceModel.findOne({ family: "grok" }).lean();
  check(stored?.registeredBy === "t@example.com", "registeredBy = viewer email");
  check(stored?.sourceUrl === "https://docs.x.ai/docs/models", "sourceUrl stored");
  check(stored?.priority === 596, `new family priority = 600 − 4 (${stored?.priority})`);

  // R10: new-family pattern rules
  const src = { sourceUrl: "https://example.com/pricing" };
  const regexNew = await reg({ ...good, ...src, family: "kimi", match: "/kimi/" }, "t@example.com");
  check(regexNew.ok === false && !!regexNew.errors?.match, "new family /regex/ → rejected");
  const shortNew = await reg({ ...good, ...src, family: "kimi", match: "ki" }, "t@example.com");
  check(shortNew.ok === false && !!shortNew.errors?.match, "new family 2-char substring → rejected");
  const emptyAll = await reg({ ...good, ...src, family: "blank", match: "=", provider: "" }, "t@example.com");
  check(emptyAll.ok === false && !!emptyAll.errors?.match, "provider \"\" + empty-matching pattern (=) → rejected");
  const shortFamily = await reg({ ...good, ...src, family: "ab", match: "" }, "t@example.com");
  check(shortFamily.ok === false && !!shortFamily.errors?.match, "blank match + 2-char family name → rejected");
  const scopedEmpty = await reg({ ...good, ...src, family: "grok-empty", match: "=", provider: "grok" }, "t@example.com");
  check(scopedEmpty.ok === true, "provider-scoped = (empty model) → accepted");
  const exactNew = await reg({ ...good, ...src, family: "kimi", match: "=kimi-k2", input: "0.6" }, "t@example.com");
  check(exactNew.ok === true, "new family =exact → accepted");
  check((await ModelPriceModel.countDocuments({ family: { $in: ["blank", "ab"] } })) === 0, "rejected new families stored nothing");
  // more specific pattern wins over a shorter one
  const fast = await reg({ ...good, ...src, family: "grok-fast", match: "grok-4-fast", input: "0.2" }, "t@example.com");
  check(fast.ok === true, "grok-fast registered");

  // R10: existing family inherits match/provider/priority; differing match rejected
  const differ = await reg({ ...good, ...src, family: "sonnet", match: "sonnet, claude", effectiveFrom: "2026-11-01" }, "t@example.com");
  check(differ.ok === false && !!differ.errors?.match, "existing family with differing match → rejected");
  const wrongProvider = await reg({ ...good, ...src, family: "sonnet", match: "", provider: "copilot", effectiveFrom: "2026-11-01" }, "t@example.com");
  check(wrongProvider.ok === false && !!wrongProvider.errors?.provider, "existing family with a new provider scope → rejected");
  // #3: blank match on an existing family (gptCodex) inherits and re-prices codex rows
  const codexV2 = await reg({ ...good, ...src, family: "gptCodex", match: "", effectiveFrom: "2026-10-01", input: "2", output: "16", cacheRead: "0.2", cacheWrite: "0" }, "t@example.com");
  check(codexV2.ok === true, `new gptCodex version with blank match accepted (${JSON.stringify(codexV2)})`);
  const codexDoc = await ModelPriceModel.findOne({ family: "gptCodex", effectiveFrom: "2026-10-01" }).lean();
  check(JSON.stringify(codexDoc?.match) === JSON.stringify(["codex"]) && codexDoc?.priority === 60 && codexDoc?.provider === "", "gptCodex v2 inherited match [codex], priority 60, provider \"\"");
  // cursor-default: blank provider inherits the only scope (cursor)
  const cursorV2 = await reg({ ...good, ...src, family: "cursor-default", match: "", provider: "", effectiveFrom: "2026-10-01" }, "t@example.com");
  check(cursorV2.ok === true, "cursor-default new version accepted");
  const cursorDoc = await ModelPriceModel.findOne({ family: "cursor-default", effectiveFrom: "2026-10-01" }).lean();
  check(cursorDoc?.provider === "cursor" && cursorDoc?.priority === 910, "cursor-default v2 inherited provider cursor, priority 910");
  const dup = await reg({ ...good, sourceUrl: "https://docs.x.ai/docs/models" }, "t@example.com");
  check(dup.ok === false, "duplicate (provider, family, effectiveFrom) → rejected");
  // a new version of an existing family inherits its priority
  const sonnetV2 = await reg({ ...good, family: "sonnet", match: "SONNET", effectiveFrom: "2026-10-01", input: "4", sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing" }, "t@example.com");
  check(sonnetV2.ok === true, "new sonnet version accepted");
  const t4 = await loadPriceTable();
  check(priceFor(t4, "grok-4.2", "grok", "2026-09-30")?.input === 3, "registered grok now priced");
  check(priceFor(t4, "grok-4-fast-reasoning", "grok", "2026-09-30")?.input === 0.2, "more specific grok-4-fast (589) beats grok (596)");
  check(priceFor(t4, "kimi-k2", "opencode", "2026-09-30")?.input === 0.6, "=kimi-k2 exact priced");
  check(priceFor(t4, "kimi-k2-thinking", "opencode", "2026-09-30") === null, "=kimi-k2 does not match kimi-k2-thinking");
  check(priceFor(t4, "gpt-5.3-codex", "codex", "2026-09-30")?.input === 1.75, "gpt-5.3-codex before gptCodex v2 → 1.75");
  check(priceFor(t4, "gpt-5.3-codex", "codex", "2026-10-01")?.input === 2, "gpt-5.3-codex from gptCodex v2 effectiveFrom → 2");
  check(priceFor(t4, "auto", "cursor", "2026-10-02")?.input === 3 && priceFor(t4, "auto", "cursor", "2026-10-02")?.output === 15, "cursor auto → cursor-default v2");
  check(priceFor(t4, "claude-sonnet-4-6", "claude_code", "2026-09-30")?.input === 3, "sonnet 09-30 still $3");
  check(priceFor(t4, "claude-sonnet-4-6", "claude_code", "2026-10-02")?.input === 4, "sonnet 10-02 → $4");
  check(priceFor(t4, "claude-sonnet-5-5", "claude_code", "2026-10-02")?.input === 2, "new sonnet family version does not touch sonnet-5 family");
  // If the 10-01 version had landed at the default priority (500) instead of
  // sonnet's, the 07-01 sonnet entry (priority 30) would still win here.
  check(priceFor(t4, "claude-4.6-sonnet-medium-thinking", "cursor", "2026-10-02")?.input === 4, "sonnet version inherits sonnet priority (beats later rules)");

  // F2 / Ruling R25: effectiveFrom may be at most 90 days before today (KST)
  const tooOld = await reg({ ...good, ...src, family: "oldfam", match: "oldfam", effectiveFrom: "2026-07-01" }, "t@example.com");
  check(tooOld.ok === false && /2026-07-02/.test(tooOld.errors?.effectiveFrom ?? ""), `effectiveFrom 91 days back → rejected with the earliest date (${JSON.stringify(tooOld)})`);
  check((await ModelPriceModel.countDocuments({ family: "oldfam" })) === 0, "too-old registration stored nothing");
  const edge = await reg({ ...good, ...src, family: "edgefam", match: "edgefam", effectiveFrom: "2026-07-02" }, "t@example.com");
  check(edge.ok === true, "effectiveFrom exactly 90 days back → accepted");
  const liveOld = await registerPrice({ ...good, ...src, family: "liveold", match: "liveold", effectiveFrom: addDays(todayKst(), -91) }, "t@example.com");
  check(liveOld.ok === false && !!liveOld.errors?.effectiveFrom, "default today = todayKst(): 91 days back → rejected");

  // F2: members delete only their OWN non-seed entries
  const delKey = { provider: "", family: "edgefam", effectiveFrom: "2026-07-02" };
  const byOther = await deletePrice(delKey, "other@example.com");
  check(byOther.ok === false && (await ModelPriceModel.countDocuments(delKey)) === 1, "another member cannot delete it");
  const noViewer = await deletePrice(delKey, "");
  check(noViewer.ok === false && (await ModelPriceModel.countDocuments(delKey)) === 1, "no viewer email → not deleted");
  const byOwner = await deletePrice(delKey, "t@example.com");
  check(byOwner.ok === true && (await ModelPriceModel.countDocuments(delKey)) === 0, `registrant deletes own entry (${JSON.stringify(byOwner)})`);
  const again = await deletePrice(delKey, "t@example.com");
  check(again.ok === false, "deleting a missing entry → not ok");
  const seedOpus = SEED_PRICES.find((e) => e.family === "opus")!;
  const seedKey = { provider: seedOpus.provider, family: seedOpus.family, effectiveFrom: seedOpus.effectiveFrom };
  for (const who of ["t@example.com", "seed"]) {
    const r = await deletePrice(seedKey, who);
    check(r.ok === false && (await ModelPriceModel.countDocuments(seedKey)) === 1, `seed entry not deletable (viewer ${who})`);
  }

  // listUnpriced: distinct usage models with no price, tokens > 0
  // (qwen3-coder, not kimi-k2 — kimi-k2 was registered above)
  const X = "verify-price-table";
  await UsageDaily.deleteMany({ externalId: X });
  const row = (date: string, tool: string, model: string, inputTokens: number) => ({
    date, tool, model, externalId: X, machineId: "", memberId: null,
    inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    requests: 1, sessions: null, costEstimateCents: null, source: "manual", raw: null,
  });
  await UsageDaily.insertMany([
    row("2026-09-10", "opencode", "qwen3-coder", 100),
    row("2026-09-12", "opencode", "qwen3-coder", 50),
    row("2026-09-11", "copilot", "gemini-2.5-pro", 500),
    row("2026-09-11", "claude_code", "claude-sonnet-5", 999), // priced
    row("2026-09-11", "claude_code", "<synthetic>", 0), // no tokens → not listed
    row("2026-09-11", "codex", "mystery", 10), // codex fallback → priced
  ]);
  const unpriced = await listUnpriced({ from: "2026-09-01", to: "2026-09-30" });
  const mine = unpriced.filter((u) => ["qwen3-coder", "gemini-2.5-pro", "claude-sonnet-5", "<synthetic>", "mystery"].includes(u.model));
  check(mine.length === 2, `listUnpriced lists exactly the 2 unpriced models (${JSON.stringify(mine)})`);
  const qwen = mine.find((u) => u.model === "qwen3-coder");
  check(qwen?.firstSeen === "2026-09-10" && qwen?.tokens === 150 && qwen?.tool === "opencode" && qwen?.provider === "opencode", "qwen3-coder firstSeen 09-10, tokens 150, tool/provider opencode");
  check(mine[0]?.model === "gemini-2.5-pro", "sorted by tokens desc");
  const narrow = await listUnpriced({ from: "2026-09-11", to: "2026-09-30" });
  check(narrow.find((u) => u.model === "qwen3-coder")?.firstSeen === "2026-09-12", "range-bounded firstSeen");
  await UsageDaily.deleteMany({ externalId: X });
  await ModelPriceModel.deleteMany({});
}

async function main() {
  pureTests();
  await dbTests();
  await closeDb();
  if (failed) {
    console.error(`FAILED: ${failed}`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
