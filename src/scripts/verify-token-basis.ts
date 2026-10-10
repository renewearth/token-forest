// Deterministic display-basis regression checks. No DB, network, or seed prices.
import assert from "node:assert/strict";
import { convert, parseBasis, resolveUnitSelection, selectedTokens, sumConverted, type TokenBasis, type Unit } from "@/lib/units";
import { groupUsage, projectUsage, type UsageFact } from "@/lib/usage-display";
import type { ModelPrice, PriceTable } from "@/lib/pricing";
import { formatUsage } from "@/app/_lib/usage-format";
import { usageHref } from "@/app/_lib/usage-url";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`ok: ${name}`); }
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
const price: ModelPrice = {
  family: "fixture", match: ["=fixture-model"], provider: "", priority: 1,
  effectiveFrom: "2026-01-01", input: 2, output: 10, cacheRead: 0.5, cacheWrite: 4,
  sourceUrl: "https://example.invalid/test-fixture", checkedAt: "2026-01-01",
  note: "Synthetic values for tests; not public model prices", registeredBy: "test",
};
const ref: ModelPrice = { ...price, family: "reference", match: ["=reference"], priority: 2,
  input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1 };
const table: PriceTable = { entries: [price, ref,
  { ...price, effectiveFrom: "2026-02-01", input: 4, output: 20, cacheRead: 1, cacheWrite: 8 },
  { ...ref, effectiveFrom: "2026-03-01", input: 2, output: 4, cacheRead: 0.5, cacheWrite: 2 },
] };
const row: UsageFact = { date: "2026-01-31", tool: "tool-a", model: "fixture-model", memberId: "member-a",
  externalId: "", machineId: "machine-a", hour: "09", requests: 1,
  inputTokens: 100, cacheReadTokens: 1000, cacheCreationTokens: 200, outputTokens: 50 };
// Independent arithmetic: do not derive the oracle from implementation kinds.
const expected: Record<TokenBasis, Record<Unit, number>> = {
  all: { raw: 1350, usd: 0.002, ref: 3250 },
  "no-cache-read": { raw: 350, usd: 0.0015, ref: 1250 },
  output: { raw: 50, usd: 0.0005, ref: 250 },
  legacy: { raw: 150, usd: 0.0007, ref: 450 },
  requests: { raw: 1, usd: 1, ref: 1 },
};
const bases = ["all", "no-cache-read", "output", "legacy"] as const;
const units = ["raw", "usd", "ref"] as const;
for (const basis of bases) for (const unit of units) {
  check(`${basis}/${unit}: selected arithmetic, dated source and reference prices`, () => {
    const initial = convert(table, row, unit, "reference", row.date, basis);
    near(initial.value, expected[basis][unit]); assert.equal(initial.unpriced, false);
    near(convert(table, row, unit, "reference", "2026-02-01", basis).value,
      expected[basis][unit] * (unit === "raw" ? 1 : 2));
    near(convert(table, row, unit, "reference", "2026-03-01", basis).value,
      expected[basis][unit] * (unit === "usd" ? 2 : 1));
  });
  check(`${basis}/${unit}: missing and null fields, selected-zero unknown models`, () => {
    const blank = { model: "unknown", tool: "tool-a", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
    assert.deepEqual(convert(table, blank, unit, "reference", row.date, basis), { value: 0, unpriced: false });
    assert.deepEqual(convert(table, { model: "unknown", tool: "tool-a" }, unit, "reference", row.date, basis), { value: 0, unpriced: false });
    if (basis !== "all") {
      assert.deepEqual(convert(table, { model: "unknown", tool: "tool-a", cacheReadTokens: 1000 }, unit, "reference", row.date, basis), { value: 0, unpriced: false });
    }
  });
  check(`${basis}/${unit}: card, daily, member and tool aggregation agree`, () => {
    const facts: UsageFact[] = [row,
      { ...row, date: "2026-02-01", tool: "tool-b", memberId: "member-b", requests: 2 },
      { ...row, model: "unknown", requests: 3 },
      { ...row, date: "2026-02-01", tool: "tool-c", memberId: "", externalId: "unmapped",
        model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheCreationTokens: 0, requests: 0 },
      { ...row, model: "unknown", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, requests: 4 },
    ];
    const before = JSON.stringify(facts);
    const projected = projectUsage(facts, table, { unit, basis, ref: "reference" });
    assert.equal(JSON.stringify(facts), before, "projection must preserve stored facts");
    assert.equal(projected.length, 5, "zero-selected rows remain visible");
    const cache = basis === "all" ? 1000 : 0;
    const total = unit === "raw" ? 3 * expected[basis].raw + cache : 3 * expected[basis][unit];
    const warnings = unit === "raw" ? 0 : expected[basis].raw + cache;
    const all = groupUsage(projected, () => "all").get("all")!;
    near(all.tokens, total); assert.equal(all.unpricedTokens, warnings); assert.equal(all.requests, 10);
    assert.deepEqual([all.input, all.output, all.cacheRead, all.cacheCreation], [300, 150, 4000, 600]);
    assert.equal(all.lastDate, "2026-02-01"); assert.equal(all.users.size, 3); assert.equal(all.tools.size, 3);
    for (const key of [(r: typeof row) => r.date, (r: typeof row) => r.memberId || r.externalId, (r: typeof row) => r.tool]) {
      const groups = [...groupUsage(projected, key).values()];
      near(groups.reduce((n, g) => n + g.tokens, 0), total);
      assert.equal(groups.reduce((n, g) => n + g.unpricedTokens, 0), warnings);
      assert.equal(groups.reduce((n, g) => n + g.requests, 0), 10);
    }
    const daily = sumConverted(table, facts, unit, "reference", (r) => r.date, basis);
    near(daily.totals.get("2026-01-31")!, (unit === "raw" ? 2 : 1) * expected[basis][unit]);
    near(daily.totals.get("2026-02-01")!, unit === "raw" ? expected[basis].raw + cache : 2 * expected[basis][unit]);
    assert.equal(daily.unpricedTokens, warnings);
  });
}
check("cache-only known rows have usage even with zero requests", () => {
  const cacheOnly = { ...row, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, requests: 0 };
  assert.equal(selectedTokens(cacheOnly, "all"), 1000);
  near(convert(table, cacheOnly, "usd", "reference", row.date, "all").value, 0.0005);
  near(convert(table, cacheOnly, "ref", "reference", row.date, "all").value, 2000);
  for (const basis of bases.slice(1)) assert.equal(selectedTokens(cacheOnly, basis), 0);
});
check("selection defaults, invalid values and empty price table", () => {
  for (const value of [undefined, null, "bogus", "all"]) assert.equal(parseBasis(value), "all");
  for (const basis of bases) assert.equal(parseBasis(basis), basis);
  assert.deepEqual(resolveUnitSelection(table, { unit: "oops", basis: "oops", ref: "missing" }),
    { unit: "raw", basis: "all", ref: "fixture", families: ["fixture", "reference"] });
  const valid = resolveUnitSelection(table, { unit: "ref", basis: "legacy", ref: "reference" });
  assert.equal(valid.unit, "ref"); assert.equal(valid.basis, "legacy"); assert.equal(valid.ref, "reference");
  assert.deepEqual(resolveUnitSelection({ entries: [] }, { unit: "ref", basis: "output" }),
    { unit: "raw", basis: "output", ref: null, families: [] });
});
check("small USD display preserves nonzero amounts", () => {
  assert.equal(formatUsage(0.0005, "usd"), "$0.0005");
  assert.equal(formatUsage(0.0000001, "usd"), "<$0.000001");
  assert.equal(formatUsage(0, "usd"), "$0.00");
  assert.equal(formatUsage(0.42, "usd"), "$0.42");
  assert.equal(formatUsage(1350, "raw"), "1,350");
});
check("usage navigation preserves selection and explicit destination overrides", () => {
  const current = new URLSearchParams("basis=output&unit=ref&ref=reference&days=7&tab=connect&private=secret");
  const href = new URL(usageHref("/members/id?days=90#details", current), "https://example.invalid");
  assert.equal(href.pathname, "/members/id"); assert.equal(href.hash, "#details");
  assert.equal(href.searchParams.get("days"), "90"); assert.equal(href.searchParams.get("basis"), "output");
  assert.equal(href.searchParams.get("unit"), "ref"); assert.equal(href.searchParams.get("ref"), "reference");
  assert.equal(href.searchParams.has("tab"), false); assert.equal(href.searchParams.has("private"), false);
  assert.equal(usageHref("https://external.invalid/", current), "https://external.invalid/");
  assert.equal(usageHref("//external.invalid/", current), "//external.invalid/");
  assert.equal(usageHref("/me", new URLSearchParams()), "/me");
});
check("requests count is independent of price, unit and token fields", () => {
  for (const unit of units) {
    assert.deepEqual(convert({ entries: [] }, { ...row, model: "unknown", requests: 7 }, unit, null, row.date, "requests"), { value: 7, unpriced: false });
    assert.deepEqual(convert(table, { model: "unknown", tool: "copilot", requests: null }, unit, null, row.date, "requests"), { value: 0, unpriced: false });
    const sel = resolveUnitSelection(table, { basis: "requests", unit });
    assert.equal(sel.basis, "requests"); assert.equal(sel.unit, "raw");
  }
  assert.equal(parseBasis("requests"), "requests");
  const sums = sumConverted(table, [{ ...row, requests: 4 }, { ...row, model: "unknown", requests: 7 }], "usd", null, r => r.date, "requests");
  assert.equal(sums.totals.get(row.date), 11); assert.equal(sums.unpricedTokens, 0);
});
console.log(`${checks} checks\nALL PASS`);
