// Synthetic observations only. No DB, network, source secrets or production data.
import assert from "node:assert/strict";
import { observeUsage, observeField, mergeObservations, emptyObservation, compareObservations } from "@/lib/observation";
import { projectUsage, groupUsage, type UsageFact } from "@/lib/usage-display";
import { buildMemberSeries } from "@/lib/member-series";
import { resolveUnitSelection, type UsageSelection } from "@/lib/units";
import { formatUsage } from "@/app/_lib/usage-format";
import type { ModelPrice, PriceTable } from "@/lib/pricing";
import { usageSessionRowSchema } from "@/lib/types";
let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const price: ModelPrice = { family: "fixture", match: ["=fixture"], provider: "", priority: 1, effectiveFrom: "2026-01-01", input: 2, output: 10, cacheRead: 0.5, cacheWrite: 4, sourceUrl: "https://example.invalid", checkedAt: "2026-01-01", note: "Synthetic", registeredBy: "test" };
const table: PriceTable = { entries: [price] };
const sel: UsageSelection = { basis: "all", unit: "raw", ref: "fixture" };
const base: UsageFact = { date: "2026-09-01", tool: "fixture", model: "fixture", source: "manual", memberId: "a", externalId: "account-a", machineId: "m", hour: "", inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheCreationTokens: null, requests: 5 };
check("AC40 field partials preserve 120 / output 20, missing not zero", () => {
  const row = { ...base, fieldEvidence: { cacheCreationTokens: "unsupported" as const } };
  const all = observeUsage(row, table, sel); assert.equal(all.value, 120); assert.equal(all.complete, false);
  assert.deepEqual(all.unknownFields, ["cacheReadTokens"]); assert.deepEqual(all.unsupportedFields, ["cacheCreationTokens"]);
  assert.equal(observeUsage(row, table, { ...sel, basis: "output" }).value, 20);
});
check("AC46 default zero provenance is unknown but valid output survives", () => {
  const row = { ...base, inputTokens: 0, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 };
  assert.equal(observeUsage(row, table, sel).value, 20);
  assert.equal(observeUsage({ ...row, outputTokens: 0 }, table, sel).value, null);
  assert.equal(observeUsage({ ...base, inputTokens: null, outputTokens: null }, table, sel).value, null);
});
check("positive subtotal with unknown evidence survives but cannot prove completeness", () => {
  const row = { ...base, inputTokens: 80, outputTokens: 20,
    fieldEvidence: { inputTokens: "unknown" as const, outputTokens: "known" as const },
    completeEvidence: { source: "manual", account: "account-a", date: base.date,
      fields: ["inputTokens" as const, "outputTokens" as const] } };
  assert.deepEqual(observeField(row, "inputTokens"), { value: 80, status: "unknown", invalid: false });
  const result = observeUsage(row, table, { ...sel, basis: "legacy" });
  assert.equal(result.value, 100);
  assert.equal(result.complete, false);
  assert.deepEqual(result.unknownFields, ["inputTokens"]);
  assert.equal(observeField({ ...row, inputTokens: 0 }, "inputTokens").value, null);
  assert.equal(observeField({ ...row, inputTokens: -1 }, "inputTokens").invalid, true);
});
check("AC07 explicit zero remains partial", () => {
  const o = observeUsage({ ...base, outputTokens: 0, fieldEvidence: { outputTokens: "known" } }, table, { ...sel, basis: "output" });
  assert.equal(o.value, 0); assert.equal(o.status, "observed"); assert.equal(o.complete, false);
});
check("AC08 complete zero scope cannot extend to another source/account/date/metric", () => {
  const row = { ...base, outputTokens: 0, fieldEvidence: { outputTokens: "known" as const }, completeEvidence: { source: "manual", account: "account-a", date: base.date, fields: ["outputTokens" as const] } };
  assert.equal(observeUsage(row, table, { ...sel, basis: "output" }).status, "confirmed-zero");
  for (const changed of [{ ...row, source: "uploader" }, { ...row, externalId: "another" }, { ...row, date: "2026-09-02" }]) assert.equal(observeUsage(changed, table, { ...sel, basis: "output" }).complete, false);
  assert.equal(observeUsage(row, table, sel).complete, false);
});
check("AC09 missing requests unknown, explicit unsupported respected", () => {
  assert.equal(observeUsage({ ...base, requests: null }, table, { ...sel, basis: "requests" }).value, null);
  assert.equal(observeUsage({ ...base, requests: null, fieldEvidence: { requests: "unsupported" } }, table, { ...sel, basis: "requests" }).status, "unsupported");
});
check("AC41 negative/infinite/fractional request excluded without erasing valid fields", () => {
  const row = { ...base, inputTokens: -1, outputTokens: 20, cacheReadTokens: Infinity, requests: 1.5 };
  const o = observeUsage(row, table, sel); assert.equal(o.value, 20); assert.equal(o.invalid, true);
  assert.equal(observeUsage(row, table, { ...sel, basis: "requests" }).value, null);
  assert.equal(observeUsage(row, table, { ...sel, basis: "requests" }).invalid, true);
  assert.equal(observeField({ ...row, requests: NaN }, "requests").invalid, true);
});
check("AC12 all unpriced null in USD/ref, mixed priced subtotal + unpriced original", () => {
  for (const unit of ["usd", "ref"] as const) {
    const rows = projectUsage([base, { ...base, model: "missing", inputTokens: 80, outputTokens: null }], table, { ...sel, unit });
    assert.equal(rows[1].observation.value, null); assert.equal(rows[1].unpricedTokens, 80);
    const group = groupUsage(rows, () => "all").get("all")!; assert.ok(group.observation.value! > 0); assert.equal(group.unpricedTokens, 80);
    assert.equal(groupUsage([rows[1]], () => "all").get("all")!.observation.value, null);
  }
});
check("AC13 record positive request independent of basis or currency", () => {
  for (const basis of ["all", "output", "requests"] as const) for (const unit of ["raw", "usd", "ref"] as const) {
    const o = observeUsage({ ...base, inputTokens: 0, outputTokens: 0, requests: 3 }, table, { ...sel, basis, unit }); assert.equal(o.hasRecord, true);
  }
});
check("AC05/06/10 missing date stays null, all registered members retained, total 15", () => {
  const rows = projectUsage([{ ...base, outputTokens: 10 }, { ...base, date: "2026-09-03", outputTokens: 5 }], table, { ...sel, basis: "output" });
  const result = buildMemberSeries(rows, [{ id: "a", name: "A" }, { id: "b", name: "B" }], { from: base.date, to: "2026-09-03" });
  assert.equal(result.members.length, 2); assert.equal(result.data[1].ma, null); assert.equal(result.data[1].__total, null);
  assert.equal(result.members.find((m) => m.key === "mb")!.total, null); assert.equal(result.observation.value, 15); assert.equal(result.observation.complete, false);
});
check("AC11/19 members plus anonymous other equal totals without exposing hidden identity", () => {
  const rows = projectUsage([base, { ...base, memberId: "secret-hidden-id", outputTokens: 9 }], table, { ...sel, basis: "output" });
  const result = buildMemberSeries(rows, [{ id: "a", name: "동명" }, { id: "b", name: "동명" }], { from: base.date, to: base.date });
  assert.equal(result.data[0].__total, 29); assert.equal(result.data[0].other, 9); assert.ok(!JSON.stringify(result).includes("secret-hidden-id"));
  assert.notEqual(result.members[0].name, result.members[1].name);
});
check("AC19 50 registered members over 90 dates: none silently dropped", () => {
  const names = Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, name: `이름 ${i}` }));
  const result = buildMemberSeries([], names, { from: "2026-07-01", to: "2026-09-28" });
  assert.equal(result.members.length, 50); assert.equal(result.data.length, 90); assert.ok(result.data.every((d) => d.__total === null));
});
check("AC14 incomplete comparison blocked; complete 0→2 has no percent", () => {
  const p = { ...emptyObservation(), value: 0, complete: true }, c = { ...p, value: 2 };
  assert.deepEqual(compareObservations(p, c), { label: "증가", delta: 2, percent: null });
  assert.equal(compareObservations({ ...p, complete: false }, c).label, "비교 조건 확인 필요");
  assert.equal(compareObservations(p, { ...c, dateBases: ["UTC"] }).label, "비교 조건 확인 필요");
});
check("AC15 past gap not filled by recent heartbeat or latest data", () => {
  const o = observeUsage({ ...base, outputTokens: null, updatedAt: new Date(), heartbeat: new Date() } as UsageFact, table, { ...sel, basis: "output" });
  assert.equal(o.value, null); assert.equal(o.complete, false);
});
check("AC16 source date bases and today progress preserved without bucket shifting", () => {
  const utc = observeUsage({ ...base, tool: "cursor", source: "poller" }, table, sel, base.date);
  const kst = observeUsage({ ...base, dateBasis: "KST" }, table, sel, base.date);
  const unknown = observeUsage(base, table, sel, base.date);
  const o = mergeObservations([utc, kst, unknown]); assert.deepEqual(o.dateBases.sort(), ["KST", "UTC", "미확인"].sort()); assert.equal(o.inProgress, true);
});
check("AC04 requests invalid unit URLs normalize to raw", () => {
  for (const unit of ["usd", "ref"]) assert.equal(resolveUnitSelection(table, { unit, basis: "requests" }).unit, "raw");
});
check("nullable formatting does not fabricate zero", () => { assert.equal(formatUsage(null, "usd"), "—"); assert.equal(formatUsage(0, "usd"), "$0.00"); });
check("original facts remain immutable", () => { const before = JSON.stringify(base); projectUsage([base], table, { ...sel, unit: "usd" }); assert.equal(JSON.stringify(base), before); });
// Promoted from the independently prepared collection acceptance gate.
check("collection schema preserves absent versus explicit zero and rejects negative counts", () => {
  const session = { tool: "codex", sessionId: "codex:missing", hour: "2026-10-01T01", model: "fixture", parserVersion: 3 };
  assert.equal(usageSessionRowSchema.parse(session).inputTokens, null);
  assert.equal(usageSessionRowSchema.parse({ ...session, inputTokens: 0 }).inputTokens, 0);
  assert.equal(usageSessionRowSchema.safeParse({ ...session, outputTokens: -1 }).success, false);
});
check("legacy Copilot billing never becomes a model request count", () => {
  assert.equal(observeField({ date: "2026-10-01", tool: "copilot", model: "fixture", source: "poller", requests: 23 }, "requests").value, null);
});
console.log(`Observation verification: ${checks} PASS, 0 FAIL`);
