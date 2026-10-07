import assert from "node:assert/strict";
import { cutoverBlockers, ledgerDigest, replaceReviewedScopes, matchesFact, supportsCutoverMatch, type CutoverScope } from "@/lib/collection-cutover";
import { normalizeRecordSemantics, recordDigest, type UsageRecord } from "../../packages/protocol/records.mjs";
import type { UsageFact } from "@/lib/usage-display";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }
const r = normalizeRecordSemantics({ tool: "claude_code", accountId: "company", recordId: "call1", sessionId: "s", kind: "event", occurredAt: "2026-10-01T00:00:00.000Z", model: "test", provider: null, revision: 1, parserVersion: 1, completeness: "final", identityQuality: "native", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 1, fieldEvidence: { inputTokens: "known", outputTokens: "known", cacheReadTokens: "known", cacheCreationTokens: "known", requests: "known" } } as UsageRecord);
const entries = [{ semantics: r, digest: recordDigest(r) }];
const scope: CutoverScope = { memberId: "111111111111111111111111", tool: "claude_code", date: "2026-10-01", accountIds: ["company"], deviceIds: ["mini", "book"], expectedCount: 1, ledgerDigest: ledgerDigest(entries), inventoryDigest: "a".repeat(64), registeredScopeReviewed: true, reviewedAt: "2026-10-07T00:00:00.000Z" };
const fact: UsageFact = { memberId: scope.memberId, tool: scope.tool, date: scope.date, model: "test", externalId: "member", machineId: "mini", hour: "", source: "uploader", inputTokens: 200 };
const replacement = { ...fact, source: "uploader-records", inputTokens: 100 };
check("scope with exact receipts permits review", () => assert.deepEqual(cutoverBlockers(scope, entries, "2026-10-07", 0), []));
check("today cannot cut over", () => assert(cutoverBlockers({ ...scope, date: "2026-10-07" }, entries, "2026-10-07", 0).includes("open_or_future_day")));
check("partial backfill preserves all legacy rows", () => assert.deepEqual(replaceReviewedScopes([fact], [{ scope, facts: [replacement], blockers: ["missing"] }]), [fact]));
check("reviewed complete local scope replaces once", () => assert.equal(replaceReviewedScopes([fact, { ...fact, machineId: "book" }], [{ scope, facts: [replacement], blockers: [] }]).reduce((n, x) => n + (x.inputTokens ?? 0), 0), 100));
check("provider and other person unaffected", () => assert.equal(replaceReviewedScopes([fact, { ...fact, source: "poller" }, { ...fact, memberId: "222222222222222222222222" }], [{ scope, facts: [replacement], blockers: [] }]).length, 3));
check("changed digest blocks same-sized ledger", () => assert(cutoverBlockers(scope, [{ ...entries[0], digest: "b".repeat(64) }], "2026-10-07", 0).includes("ledger_changed_or_incomplete")));
check("unverified default cannot certify scope", () => assert(cutoverBlockers(scope, [{ ...entries[0], semantics: { ...r, identityQuality: "unverified" } }], "2026-10-07", 0).includes("unverified_source")));
check("different account cannot replace legacy tool scope", () => assert(cutoverBlockers({ ...scope, accountIds: ["other"] }, entries, "2026-10-07", 0).includes("account_scope_mismatch")));
check("conflicts block cutover", () => assert(cutoverBlockers(scope, entries, "2026-10-07", 1).includes("unresolved_conflicts")));
check("native final does not certify unknown metrics", () => assert(cutoverBlockers(scope, [{ ...entries[0], semantics: { ...r, inputTokens: null, fieldEvidence: { ...r.fieldEvidence, inputTokens: "unknown" } } }], "2026-10-07", 0).includes("source_metrics_unknown")));
check("duplicate policies do not double count", () => assert.throws(() => replaceReviewedScopes([fact], [0, 1].map(() => ({ scope, facts: [replacement], blockers: [] })))));
check("member date filters remain private", () => assert(!matchesFact(fact, { memberId: "222222222222222222222222" })));
check("known range filter works", () => assert(matchesFact(fact, { memberId: { $ne: null }, date: { $gte: "2026-10-01", $lt: "2026-10-02" } })));
check("device view never uses member-wide replacement", () => assert(!supportsCutoverMatch({ machineId: "mini" })));
check("offline dry-run computes candidate totals and blocks incomplete inventory", () => {
  const temp = mkdtempSync(join(tmpdir(), "tf-cutover-dry-"));
  try {
    const file = join(temp, "input.json");
    const input = { scope, sourceEntries: entries, serverEntries: entries, inventory: { deviceIds: scope.deviceIds, sourceErrors: 0, unknownPaths: 0 }, legacyTotals: { inputTokens: 200 }, conflictCount: 0 };
    const execute = () => JSON.parse(execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/scripts/compare-record-cutover.ts", "--input", file], { encoding: "utf8" }));
    writeFileSync(file, JSON.stringify(input)); const report = execute();
    assert.equal(report.eligibleForHumanReview, true); assert.equal(report.databaseWrites, 0);
    assert.equal(report.differences.inputTokens.candidate, 100); assert.equal(report.differences.inputTokens.delta, -100);
    writeFileSync("/tmp/tf-reliability-cutover-dryrun.json", JSON.stringify(report, null, 2));
    input.inventory.unknownPaths = 1; writeFileSync(file, JSON.stringify(input));
    assert(execute().blockers.includes("inventory_incomplete"));
    input.inventory.unknownPaths = 0; input.scope = { ...scope, date: "2026-10-02" }; writeFileSync(file, JSON.stringify(input));
    assert(execute().blockers.includes("target_day_unobserved"));
    const incomplete = { ...input, inventory: { deviceIds: scope.deviceIds } }; writeFileSync(file, JSON.stringify(incomplete));
    assert.throws(execute);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
console.log(`${passed} cutover checks passed`);
