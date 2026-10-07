// Offline dry-run only. Input contains usage metadata, never credentials or raw
// transcripts. No database connection or mutation is available in this script.
import { readFile } from "node:fs/promises";
import { recordKey, recordDigest, METRIC_FIELDS } from "../../packages/protocol/records.mjs";
import { cutoverSchema, cutoverBlockers, ledgerDigest, type LedgerEntry } from "@/lib/collection-cutover";
import { todayKst } from "@/lib/date";
import { recordSchema } from "@/lib/record-types";
import { deriveRecordRows } from "@/lib/record-derivation";
import { z } from "zod";

type Input = {
  scope: unknown; sourceEntries: LedgerEntry[]; serverEntries: LedgerEntry[];
  inventory: { deviceIds: string[]; sourceErrors: number; unknownPaths: number };
  legacyTotals: Record<string, number | null>;
  conflictCount: number;
};
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") throw Error("Usage: tsx src/scripts/compare-record-cutover.ts --input metadata.json (dry-run only)");
  const input = JSON.parse(await readFile(process.argv[3], "utf8")) as Input;
  z.object({ deviceIds: z.array(z.string().min(1)).min(1), sourceErrors: z.number().int().nonnegative().safe(), unknownPaths: z.number().int().nonnegative().safe() }).strict().parse(input.inventory);
  z.number().int().nonnegative().safe().parse(input.conflictCount);
  const scope = cutoverSchema.parse({ version: 1, scopes: [input.scope] }).scopes[0];
  for (const entry of [...input.sourceEntries, ...input.serverEntries]) {
    recordSchema.parse(entry.semantics);
    if (recordDigest(entry.semantics) !== entry.digest) throw Error("Invalid digest");
  }
  if (Object.values(input.legacyTotals).some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0))) throw Error("Invalid legacy total");
  const expected = new Map<string, string>();
  let contradictorySourceRevisions = 0;
  for (const r of input.sourceEntries) {
    const key = recordKey(r.semantics);
    if (expected.has(key) && expected.get(key) !== r.digest) contradictorySourceRevisions++;
    expected.set(key, r.digest);
  }
  const received = new Map(input.serverEntries.map((r) => [recordKey(r.semantics), r.digest]));
  const missing = [...expected].filter(([key]) => !received.has(key)).length;
  const different = [...expected].filter(([key, digest]) => received.has(key) && received.get(key) !== digest).length;
  const unexpected = [...received].filter(([key]) => !expected.has(key)).length;
  const blockers = cutoverBlockers(scope, input.serverEntries, todayKst(), input.conflictCount);
  if (received.size !== input.serverEntries.length) blockers.push("duplicate_server_keys");
  if (input.serverEntries.some((e) => e.semantics.tool !== scope.tool || new Date(Date.parse(e.semantics.occurredAt) + 9 * 3600000).toISOString().slice(0, 10) > scope.date)) blockers.push("ledger_outside_scope");
  const chains = new Map<string, LedgerEntry[]>();
  for (const entry of input.serverEntries) {
    const key = JSON.stringify([entry.semantics.accountId, entry.semantics.sessionId]);
    const group = chains.get(key) ?? []; group.push(entry); chains.set(key, group);
  }
  const derived = [...chains.values()].map((chain) => deriveRecordRows(chain.map((e) => e.semantics)));
  const rows = derived.flatMap((r) => r.rows).filter((r) => r.grain === "day" && r.period === scope.date);
  if (!rows.length) blockers.push("target_day_unobserved");
  if (derived.some((r) => r.conflictCount) || rows.some((r) => r.verification !== "verified")) blockers.push("unverified_derivation");
  const candidateTotals = Object.fromEntries(METRIC_FIELDS.map((field) => [field,
    !rows.length || rows.some((r) => r.metrics[field] === null) ? null : rows.reduce((n, r) => n + (r.metrics[field] ?? 0), 0)]));
  if (missing || different || unexpected) blockers.push("source_receipt_difference");
  if (contradictorySourceRevisions) blockers.push("source_revision_conflict");
  if (input.inventory.sourceErrors || input.inventory.unknownPaths) blockers.push("inventory_incomplete");
  if (JSON.stringify([...new Set(input.inventory.deviceIds)].sort()) !== JSON.stringify([...new Set(scope.deviceIds)].sort())) blockers.push("device_scope_mismatch");
  const differences = Object.fromEntries([...new Set([...Object.keys(input.legacyTotals), ...Object.keys(candidateTotals)])].map((field) => {
    const before = input.legacyTotals[field] ?? null, after = candidateTotals[field] ?? null;
    return [field, { legacy: before, candidate: after, delta: before === null || after === null ? null : after - before }];
  }));
  console.log(JSON.stringify({ mode: "dry-run", databaseWrites: 0, activation: false,
    sourceRecords: expected.size, serverRecords: received.size, missing, different, unexpected, contradictorySourceRevisions,
    blockers: [...new Set(blockers)], eligibleForHumanReview: !blockers.length,
    ledgerDigest: ledgerDigest(input.serverEntries), differences,
    differenceReason: "미분류: 합계 차이만으로 신규·중복·파서 정정·복구 불가를 확정하지 않음",
    limitation: "등록한 경로와 고정한 시점의 기록만 비교. 미등록 경로·삭제된 로그·웹/앱 미제공 수치 제외.",
  }, null, 2));
}
main().catch(() => { console.error("Dry-run failed: invalid metadata input. No data was changed."); process.exitCode = 1; });
