import type { Types } from "mongoose";
import { UsageRecord, UsageRecordChain, UsageRecordConflict, UsageRecordDerived, UsageRecordDevice, UsageRecordDeviceSource } from "@/lib/db/usage-record";

export async function getCollectionStatus(memberId: Types.ObjectId) {
  const [records, conflicts, chains, derived, devices, deviceSources] = await Promise.all([
    UsageRecord.find({ memberId }).select({ tool: 1, accountId: 1, machineId: 1, occurredAt: 1, receivedAt: 1, digest: 1, semantics: 1 }).lean(),
    UsageRecordConflict.find({ memberId }).select({ tool: 1, accountId: 1, observedAt: 1, reasonCode: 1 }).lean(),
    UsageRecordChain.find({ memberId }).select({ tool: 1, accountId: 1, sessionId: 1, generation: 1 }).lean(),
    UsageRecordDerived.find({ memberId }).select({ tool: 1, accountId: 1, sessionId: 1, generation: 1, conflictCount: 1 }).lean(),
    UsageRecordDevice.find({ memberId }).sort({ lastReceiptAt: 1 }).lean(),
    UsageRecordDeviceSource.find({ memberId }).lean(),
  ]);
  const sources = new Map<string, { tool: string; accountId: string; recordCount: number; conflictCount: number; lastSourceAt: string | null; lastReceiptAt: string | null; unverifiedCount: number; namespaceConfigured: boolean | null; namespaceVerified: boolean | null; healthStatus: string | null; locationsChecked: number | null; locationsPresent: number | null }>();
  const get = (tool: string, accountId: string) => {
    const key = JSON.stringify([tool, accountId]);
    let source = sources.get(key);
    if (!source) { source = { tool, accountId, recordCount: 0, conflictCount: 0, lastSourceAt: null, lastReceiptAt: null, unverifiedCount: 0, namespaceConfigured: null, namespaceVerified: null, healthStatus: null, locationsChecked: null, locationsPresent: null }; sources.set(key, source); }
    return source;
  };
  for (const r of records) {
    const s = get(r.tool, r.accountId);
    s.recordCount++;
    if ((r.semantics as { identityQuality?: string }).identityQuality !== "native" || (r.semantics as { completeness?: string }).completeness !== "final") s.unverifiedCount++;
    const sourceAt = r.occurredAt.toISOString(), receiptAt = r.receivedAt.toISOString();
    if (!s.lastSourceAt || s.lastSourceAt < sourceAt) s.lastSourceAt = sourceAt;
    if (!s.lastReceiptAt || s.lastReceiptAt < receiptAt) s.lastReceiptAt = receiptAt;
  }
  for (const c of conflicts) get(c.tool, c.accountId).conflictCount++;
  for (const d of derived) get(d.tool, d.accountId).conflictCount += d.conflictCount;
  for (const receipt of deviceSources) {
    const source = get(receipt.tool, receipt.accountId);
    const at = receipt.lastReceiptAt.toISOString();
    if (!source.lastReceiptAt || source.lastReceiptAt < at) source.lastReceiptAt = at;
  }
  for (const device of devices) for (const parser of device.parserHealth ?? []) {
    if (!parser || typeof parser !== "object") continue;
    const h = parser as { parser?: string; accountId?: string; namespaceConfigured?: boolean; namespaceVerified?: boolean; error?: string; readErrors?: number; linesUnrecognized?: number; filesScanned?: number; locationsChecked?: number; locationsPresent?: number };
    if (!h.parser || !h.accountId) continue;
    const source = get(h.parser, h.accountId);
    source.namespaceConfigured = h.namespaceConfigured ?? null;
    source.namespaceVerified = h.namespaceVerified ?? null;
    source.locationsChecked = h.locationsChecked ?? null;
    source.locationsPresent = h.locationsPresent ?? null;
    source.healthStatus = h.error ? "error" : h.readErrors || h.linesUnrecognized ? "partial" : h.filesScanned === 0 ? "empty" : "ok";
    const at = device.lastReceiptAt.toISOString();
    if (!source.lastReceiptAt || source.lastReceiptAt < at) source.lastReceiptAt = at;
  }
  const generations = new Map(derived.map((d) => [JSON.stringify([d.tool, d.accountId, d.sessionId]), d.generation]));
  const staleChains = chains.filter((c) => generations.get(JSON.stringify([c.tool, c.accountId, c.sessionId])) !== c.generation).length;
  const sourcesByDevice = new Map<string, Array<{ tool: string; accountId: string; receiptCount: number; lastReceiptAt: string; lastSourceAt: string | null }>>();
  for (const s of deviceSources) {
    const list = sourcesByDevice.get(s.machineId) ?? [];
    list.push({ tool: s.tool, accountId: s.accountId, receiptCount: s.receiptCount,
      lastReceiptAt: s.lastReceiptAt.toISOString(), lastSourceAt: s.lastSourceAt?.toISOString() ?? null });
    sourcesByDevice.set(s.machineId, list);
  }
  return { protocolVersion: 3, scope: "authenticated_member", recordCount: records.length,
    conflictCount: conflicts.length + derived.reduce((n, d) => n + d.conflictCount, 0), staleChains,
    sourceStatus: [...sources.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.accountId.localeCompare(b.accountId)),
    deviceStatus: devices.map((d) => ({ machineId: d.machineId, label: d.label,
      uploaderVersion: d.uploaderVersion, buildHash: d.buildHash,
      lastReceiptAt: d.lastReceiptAt.toISOString(), lastRunAt: d.lastRunAt?.toISOString() ?? null,
      receiptCount: d.receiptCount, acceptedCount: d.acceptedCount,
      rejectedCount: d.rejectedCount, conflictCount: d.conflictCount,
      pending: d.pending, reportedRejected: d.reportedRejected, readErrors: d.readErrors,
      healthStatus: d.healthStatus, parserHealth: d.parserHealth,
      sources: (sourcesByDevice.get(d.machineId) ?? []).sort((a, b) => a.tool.localeCompare(b.tool) || a.accountId.localeCompare(b.accountId)),
    })).sort((a, b) => a.machineId.localeCompare(b.machineId)),
    reconciliation: { meaning: "only_expected_keys_can_be_compared", globallyComplete: false },
  };
}
