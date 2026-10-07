// Server rendering checks complement the browser interaction gate.
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageComparison } from "@/app/_components/UsageComparison";
import { ModelDonut } from "@/app/_components/analytics/ModelDonut";
import { emptyObservation } from "@/lib/observation";
import { Heatmap } from "@/app/_components/analytics/Heatmap";
import { buildMemberSeries } from "@/lib/member-series";
import { projectUsage, type UsageFact } from "@/lib/usage-display";
const range = { from: "2026-09-01", to: "2026-09-03" };
const names = Array.from({ length: 50 }, (_, i) => ({ id: `member-${i}`, name: `구성원 ${i}` }));
const people = buildMemberSeries([], names, range);
let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const html = renderToStaticMarkup(<UsageComparison people={people} tools={{ data: [], tools: [], unpricedTokens: 0 }} unit="raw" basis="all" />);
check("50 registered members render with search, all controls and unknown statuses", () => {
  for (const name of names) assert.ok(html.includes(name.name));
  for (const phrase of ["구성원 검색", "전체 선택", "전체 해제", "전체 합계 표시", "수집 미확인", "기록 미확인", "날짜별 값·수집 상태"]) assert.ok(html.includes(phrase), phrase);
  assert.ok(html.includes("aria-pressed=\"true\"")); assert.ok(!html.includes("기록이 없는 날짜는 0"));
});
const fact: UsageFact = { date: range.from, tool: "fixture", model: "unpriced", memberId: "member-0", externalId: "", machineId: "", hour: "", outputTokens: 20 };
const unpriced = buildMemberSeries(projectUsage([fact], { entries: [] }, { basis: "output", unit: "usd", ref: null }), names, range);
check("all unpriced render never substitutes $0.00 and retains record evidence", () => {
  const rendered = renderToStaticMarkup(<UsageComparison people={unpriced} tools={{ data: [], tools: [], unpricedTokens: 20 }} unit="usd" basis="output" />);
  assert.ok(!rendered.includes("$0.00")); assert.ok(rendered.includes("미환산 원본 있음")); assert.ok(rendered.includes("기록 있음"));
});
check("unknown heatmap has keyboard focus and textual null status without zero maximum", () => {
  const rendered = renderToStaticMarkup(<Heatmap matrix={Array.from({ length: 7 }, () => Array(24).fill(null))} />);
  assert.ok(rendered.includes("tabindex=\"0\"")); assert.ok(rendered.includes("수집 미확인")); assert.ok(!rendered.includes("최대 0"));
});
check("model donut all-unpriced USD/ref never renders zero or a percentage", () => {
  for (const unit of ["usd", "ref"] as const) {
    const rendered = renderToStaticMarkup(<ModelDonut rows={[{ model: "unknown-model", tool: "fixture", tokens: 0, unpricedTokens: 20, observation: { ...emptyObservation(), unpricedTokens: 20 } }]} unit={unit} />);
    assert.ok(!rendered.includes("$0.00")); assert.ok(!rendered.includes("0%")); assert.ok(rendered.includes("미환산 원본 20토큰")); assert.ok(rendered.includes("—"));
  }
});
check("model donut mixed conversion retains priced sum and unpriced original", () => {
  const rendered = renderToStaticMarkup(<ModelDonut rows={[
    { model: "known-model", tool: "fixture", tokens: 2, observation: { ...emptyObservation(), value: 2, status: "observed" } },
    { model: "unknown-model", tool: "fixture", tokens: 0, unpricedTokens: 20, observation: { ...emptyObservation(), unpricedTokens: 20 } },
  ]} unit="usd" />);
  assert.ok(rendered.includes("$2.00")); assert.ok(!rendered.includes("$0.00")); assert.ok(rendered.includes("미환산 원본 20토큰")); assert.ok(rendered.includes("일부 수집"));
});
check("model donut explicit observed zero preserves zero but cannot infer percentage", () => {
  const rendered = renderToStaticMarkup(<ModelDonut rows={[{ model: "zero-model", tool: "fixture", tokens: 0, observation: { ...emptyObservation(), value: 0, status: "observed" } }]} unit="usd" />);
  assert.ok(rendered.includes("$0.00")); assert.ok(!rendered.includes("0%"));
});
console.log(`Observation rendering verification: ${checks} PASS, 0 FAIL`);
