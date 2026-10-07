import type { Types } from "mongoose";
import { createHash } from "node:crypto";
import { canonicalJson, recordDigest, recordKey, normalizeRecordSemantics, METRIC_FIELDS, type UsageRecord } from "../../packages/protocol/records.mjs";
import { connectDb } from "@/lib/db";
import { UsageRecord as UsageRecordModel, UsageRecordChain, UsageRecordConflict, UsageRecordDerived, UsageRecordDevice, UsageRecordDeviceSource } from "@/lib/db/usage-record";
import { anonymizeMachineId } from "@/lib/machine-id";
import { deriveRecordChain } from "@/lib/record-derivation";
import { ingestRecordsSchema, recordSchema, reconcileSchema, type recordHealthSchema } from "@/lib/record-types";
import type { z } from "zod";

export type Acknowledgement = { key: string; digest: string; status: "stored" | "unchanged" | "superseded" | "conflict" | "rejected"; reasonCode?: string; currentDigest?: string };
type Member = { _id: Types.ObjectId };
type Device = { machineId: string; uploaderVersion: string };
type Health = z.infer<typeof recordHealthSchema> | undefined;

let indexBarrier: Promise<void> | undefined;
export function readyRecordCollections(): Promise<void> {
  // Do not acknowledge a first write until Mongo has installed every unique
  // key. createIndexes is explicit even if deployment disables autoIndex.
  return (indexBarrier ??= Promise.all([
    UsageRecordModel.createIndexes(), UsageRecordConflict.createIndexes(),
    UsageRecordChain.createIndexes(), UsageRecordDerived.createIndexes(),
    UsageRecordDevice.createIndexes(), UsageRecordDeviceSource.createIndexes(),
  ]).then(() => undefined).catch((error) => { indexBarrier = undefined; throw error; }));
}

function rejectedAcknowledgement(candidate: unknown): Acknowledgement {
  const value = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
  const key = [value.tool, value.accountId, value.recordId].every((part) => typeof part === "string")
    ? JSON.stringify([value.tool, value.accountId, value.recordId]) : "";
  let digest = "";
  try {
    // Well-formed identity but malformed counters still bind to the client's
    // protocol digest. If a required field is absent, hash its exact JSON row.
    digest = recordDigest(value as UsageRecord);
  } catch {
    try { digest = createHash("sha256").update(canonicalJson(value)).digest("hex"); } catch { /* no canonical row */ }
  }
  return { key, digest, status: "rejected", reasonCode: "invalid_record" };
}

function duplicateKey(error: unknown): boolean {
  return !!(error && typeof error === "object" && "code" in error && error.code === 11000);
}

function classify(existing: UsageRecord, incoming: UsageRecord): { action: "store" | "superseded" | "conflict"; reasonCode?: string; value?: UsageRecord } {
  if (existing.sessionId !== incoming.sessionId || existing.kind !== incoming.kind)
    return { action: "conflict", reasonCode: "identity_collision" };
  if (existing.occurredAt !== incoming.occurredAt &&
      !(incoming.revision > existing.revision && existing.identityQuality === "native" && incoming.identityQuality === "native"))
    return { action: "conflict", reasonCode: "unverified_timestamp_correction" };
  if (incoming.parserVersion < existing.parserVersion)
    return { action: "conflict", reasonCode: "parser_downgrade" };
  if (incoming.revision < existing.revision) return { action: "superseded", reasonCode: "older_revision" };
  if (existing.completeness === "final" && incoming.completeness === "partial")
    return { action: "superseded", reasonCode: "final_dominates_partial" };
  if (incoming.revision > existing.revision) return { action: "store", value: incoming };
  if (incoming.parserVersion !== existing.parserVersion)
    return { action: "conflict", reasonCode: "unverified_parser_correction" };
  if (existing.kind === "cumulative" && existing.completeness === incoming.completeness &&
      existing.model !== incoming.model && (existing.model === "unknown" || incoming.model === "unknown")) {
    const { model: _oldModel, ...oldWithoutModel } = normalizeRecordSemantics(existing);
    const { model: _newModel, ...newWithoutModel } = normalizeRecordSemantics(incoming);
    if (canonicalJson(oldWithoutModel) === canonicalJson(newWithoutModel)) {
      return existing.model === "unknown"
        ? { action: "store", value: incoming }
        : { action: "superseded", reasonCode: "model_already_known" };
    }
  }
  if (existing.completeness === "partial" && incoming.completeness === "final")
    return { action: "store", value: incoming };
  if (existing.completeness === "final") return { action: "conflict", reasonCode: "same_revision_final_conflict" };
  if (existing.kind !== "event") return { action: "conflict", reasonCode: "same_revision_snapshot_conflict" };
  if (existing.model !== incoming.model || existing.provider !== incoming.provider || existing.identityQuality !== incoming.identityQuality)
    return { action: "conflict", reasonCode: "same_revision_metadata_conflict" };
  const merged = { ...existing, fieldEvidence: { ...existing.fieldEvidence } };
  let changed = false;
  for (const f of METRIC_FIELDS) {
    const before = existing[f] ?? null;
    const after = incoming[f] ?? null;
    if (after === null || incoming.fieldEvidence?.[f] !== "known") continue;
    if (before === null || after > before) {
      merged[f] = after;
      merged.fieldEvidence[f] = "known";
      changed = true;
    }
  }
  return changed ? { action: "store", value: merged } : { action: "superseded", reasonCode: "partial_not_newer" };
}

async function noteConflict(memberId: Types.ObjectId, row: UsageRecord, digest: string, currentDigest: string, reasonCode: string) {
  await UsageRecordConflict.updateOne(
    { memberId, tool: row.tool, accountId: row.accountId, recordId: row.recordId, submittedDigest: digest },
    { $setOnInsert: { currentDigest, reasonCode, observedAt: new Date() } }, { upsert: true },
  );
}

async function touchChain(memberId: Types.ObjectId, row: UsageRecord) {
  const key = { memberId, tool: row.tool, accountId: row.accountId, sessionId: row.sessionId };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await UsageRecordChain.updateOne(key, { $inc: { generation: 1 }, $set: { updatedAt: new Date() } }, { upsert: true });
      await deriveRecordChain(memberId, row.tool, row.accountId, row.sessionId);
      return;
    } catch (error) { if (!duplicateKey(error) || attempt === 2) throw error; }
  }
}

async function storeRecord(memberId: Types.ObjectId, row: UsageRecord, device: Device): Promise<Acknowledgement> {
  const key = recordKey(row), digest = recordDigest(row);
  const id = { memberId, tool: row.tool, accountId: row.accountId, recordId: row.recordId };
  const semantics = normalizeRecordSemantics(row);
  const at = new Date(row.occurredAt);
  const date = new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hour = new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 13);
  for (let attempt = 0; attempt < 25; attempt++) {
    const existing = await UsageRecordModel.findOne(id).lean();
    if (!existing) {
      try {
        await UsageRecordModel.create({ ...id, sessionId: row.sessionId, kind: row.kind,
          occurredAt: at, date, hour, digest, semantics,
          machineId: anonymizeMachineId(device.machineId), uploaderVersion: device.uploaderVersion,
          version: 1, receivedAt: new Date() });
        await touchChain(memberId, row);
        return { key, digest, status: "stored" };
      } catch (error) { if (duplicateKey(error)) continue; throw error; }
    }
    if (existing.digest === digest) {
      // A process may have died after the ledger write but before updating its
      // materialized chain. An exact retry repairs the shadow derivation.
      await touchChain(memberId, existing.semantics as UsageRecord);
      return { key, digest, status: "unchanged" };
    }
    const current = existing.semantics as UsageRecord;
    const decision = classify(current, semantics);
    if (decision.action === "superseded") return { key, digest, status: "superseded", reasonCode: decision.reasonCode, currentDigest: existing.digest };
    if (decision.action === "conflict") {
      await noteConflict(memberId, row, digest, existing.digest, decision.reasonCode!);
      return { key, digest, status: "conflict", reasonCode: decision.reasonCode, currentDigest: existing.digest };
    }
    const merged = normalizeRecordSemantics(decision.value!);
    const replacementDigest = recordDigest(merged);
    const updated = await UsageRecordModel.updateOne({ ...id, version: existing.version }, {
      $set: { semantics: merged, digest: replacementDigest,
        occurredAt: new Date(merged.occurredAt),
        date: new Date(Date.parse(merged.occurredAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
        hour: new Date(Date.parse(merged.occurredAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 13),
        machineId: anonymizeMachineId(device.machineId), uploaderVersion: device.uploaderVersion,
        receivedAt: new Date() }, $inc: { version: 1 },
    });
    if (updated.modifiedCount) {
      await touchChain(memberId, merged);
      return { key, digest, status: "stored", ...(replacementDigest !== digest ? { currentDigest: replacementDigest } : {}) };
    }
  }
  throw new Error("record write contention exceeded retry budget");
}

async function recordDeviceReceipt(memberId: Types.ObjectId, device: Device & { label?: string; buildHash?: string }, health: Health,
  observations: Array<{ row: UsageRecord; acknowledgement: Acknowledgement }>, acknowledgements: Acknowledgement[]) {
  const machineId = anonymizeMachineId(device.machineId);
  const now = new Date();
  const acceptedCount = acknowledgements.filter((x) => ["stored", "unchanged"].includes(x.status)).length;
  const rejectedCount = acknowledgements.filter((x) => x.status === "rejected").length;
  const conflictCount = acknowledgements.filter((x) => x.status === "conflict").length;
  const set: Record<string, unknown> = { label: device.label ?? null, uploaderVersion: device.uploaderVersion, buildHash: device.buildHash ?? null };
  if (health) {
    const report = Array.isArray(health) ? { sources: health } : health;
    if ("lastRunAt" in report && report.lastRunAt) set.lastRunAt = new Date(report.lastRunAt);
    if ("pending" in report && report.pending !== undefined) set.pending = report.pending;
    if ("rejected" in report && report.rejected !== undefined) set.reportedRejected = report.rejected;
    const sources = report.sources ?? [];
    set.parserHealth = sources;
    set.readErrors = "readErrors" in report && report.readErrors !== undefined
      ? report.readErrors : sources.reduce((n, s) => n + s.readErrors, 0);
    set.healthStatus = "status" in report && report.status !== undefined
      ? report.status : sources.some((s) => s.error || s.readErrors) ? "partial" : "ok";
  }
  const key = { memberId, machineId };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await UsageRecordDevice.updateOne(key, {
        $set: set, $max: { lastReceiptAt: now },
        $inc: { receiptCount: 1, acceptedCount, rejectedCount, conflictCount },
        $setOnInsert: { memberId, machineId },
      }, { upsert: true });
      break;
    } catch (error) { if (!duplicateKey(error) || attempt === 2) throw error; }
  }
  const bySource = new Map<string, { tool: string; accountId: string; count: number; lastSourceAt: Date }>();
  for (const { row } of observations) {
    const key = JSON.stringify([row.tool, row.accountId]);
    const at = new Date(row.occurredAt);
    const prior = bySource.get(key);
    if (prior) { prior.count++; if (prior.lastSourceAt < at) prior.lastSourceAt = at; }
    else bySource.set(key, { tool: row.tool, accountId: row.accountId, count: 1, lastSourceAt: at });
  }
  for (const source of bySource.values()) {
    const sourceKey = { memberId, machineId, tool: source.tool, accountId: source.accountId };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await UsageRecordDeviceSource.updateOne(sourceKey, {
          $max: { lastReceiptAt: now, lastSourceAt: source.lastSourceAt },
          $inc: { receiptCount: source.count }, $setOnInsert: sourceKey,
        }, { upsert: true });
        break;
      } catch (error) { if (!duplicateKey(error) || attempt === 2) throw error; }
    }
  }
}

export async function handleRecordIngest(member: Member, body: unknown) {
  const parsed = ingestRecordsSchema.safeParse(body);
  if (!parsed.success) return { httpStatus: 400, body: { error: "invalid payload" } };
  await connectDb();
  await readyRecordCollections();
  const acknowledgements: Acknowledgement[] = [];
  const observations: Array<{ row: UsageRecord; acknowledgement: Acknowledgement }> = [];
  for (const candidate of parsed.data.records) {
    const result = recordSchema.safeParse(candidate);
    if (!result.success) {
      acknowledgements.push(rejectedAcknowledgement(candidate));
      continue;
    }
    const row = result.data as UsageRecord;
    const acknowledgement = await storeRecord(member._id, row, parsed.data.device);
    acknowledgements.push(acknowledgement);
    observations.push({ row, acknowledgement });
  }
  await recordDeviceReceipt(member._id, parsed.data.device, parsed.data.health, observations, acknowledgements);
  return { httpStatus: 200, body: { protocolVersion: 3, acknowledgements,
    accepted: acknowledgements.filter((a) => a.status === "stored" || a.status === "unchanged").length,
    rejected: acknowledgements.filter((a) => a.status === "rejected").length } };
}

export async function reconcileRecordReceipts(member: Member, body: unknown) {
  const parsed = reconcileSchema.safeParse(body);
  if (!parsed.success) return { httpStatus: 400, body: { error: "invalid payload" } };
  await connectDb();
  const expected = parsed.data.expected;
  const identities = expected.map(({ key }) => {
    try {
      const parts = JSON.parse(key);
      return Array.isArray(parts) && parts.length === 3 && parts.every((x) => typeof x === "string")
        ? { memberId: member._id, tool: parts[0], accountId: parts[1], recordId: parts[2] } : null;
    } catch { return null; }
  });
  const validIdentities = identities.filter((x) => x !== null);
  const docs = validIdentities.length
    ? await UsageRecordModel.find({ $or: validIdentities }).select({ tool: 1, accountId: 1, recordId: 1, digest: 1 }).lean()
    : [];
  const digests = new Map(docs.map((d) => [recordKey({ tool: d.tool as UsageRecord["tool"], accountId: d.accountId, recordId: d.recordId }), d.digest]));
  return { httpStatus: 200, body: { protocolVersion: 3,
    results: expected.map(({ key, digest }, i) => {
      if (!identities[i]) return { key, digest, status: "missing" as const, reasonCode: "invalid_key" };
      const currentDigest = digests.get(key);
      return !currentDigest ? { key, digest, status: "missing" as const }
        : currentDigest === digest ? { key, digest, status: "matched" as const }
          : { key, digest, status: "different" as const, currentDigest };
    }) } };
}
