import mongoose, { Schema, type Model, type Types } from "mongoose";

// Protocol 3 lives in new collections. The legacy usage/session graph is never
// updated from these models, so a reviewed source switch can happen later.
export interface UsageRecordDoc {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  tool: string;
  accountId: string;
  recordId: string;
  sessionId: string;
  kind: "event" | "cumulative";
  occurredAt: Date;
  date: string;
  hour: string;
  digest: string;
  semantics: Record<string, unknown>;
  machineId: string;
  uploaderVersion: string;
  version: number;
  receivedAt: Date;
}

const recordSchema = new Schema<UsageRecordDoc>({
  memberId: { type: Schema.Types.ObjectId, required: true },
  tool: { type: String, required: true }, accountId: { type: String, required: true },
  recordId: { type: String, required: true }, sessionId: { type: String, required: true },
  kind: { type: String, enum: ["event", "cumulative"], required: true },
  occurredAt: { type: Date, required: true }, date: { type: String, required: true },
  hour: { type: String, required: true }, digest: { type: String, required: true },
  semantics: { type: Schema.Types.Mixed, required: true },
  machineId: { type: String, required: true }, uploaderVersion: { type: String, required: true },
  version: { type: Number, required: true, default: 1 }, receivedAt: { type: Date, required: true },
}, { collection: "usagerecords", versionKey: false });
recordSchema.index({ memberId: 1, tool: 1, accountId: 1, recordId: 1 }, { unique: true });
recordSchema.index({ memberId: 1, tool: 1, accountId: 1, sessionId: 1, occurredAt: 1 });

export interface UsageRecordConflictDoc {
  memberId: Types.ObjectId; tool: string; accountId: string; recordId: string;
  submittedDigest: string; currentDigest: string; reasonCode: string; observedAt: Date;
}
const conflictSchema = new Schema<UsageRecordConflictDoc>({
  memberId: { type: Schema.Types.ObjectId, required: true }, tool: String, accountId: String,
  recordId: String, submittedDigest: String, currentDigest: String,
  reasonCode: String, observedAt: Date,
}, { collection: "usagerecordconflicts", versionKey: false });
conflictSchema.index({ memberId: 1, tool: 1, accountId: 1, recordId: 1, submittedDigest: 1 }, { unique: true });

export interface UsageRecordChainDoc {
  memberId: Types.ObjectId; tool: string; accountId: string; sessionId: string;
  generation: number; updatedAt: Date;
}
const chainSchema = new Schema<UsageRecordChainDoc>({
  memberId: { type: Schema.Types.ObjectId, required: true }, tool: String,
  accountId: String, sessionId: String, generation: { type: Number, required: true },
  updatedAt: Date,
}, { collection: "usagerecordchains", versionKey: false });
chainSchema.index({ memberId: 1, tool: 1, accountId: 1, sessionId: 1 }, { unique: true });

export interface UsageRecordDerivedDoc {
  memberId: Types.ObjectId; tool: string; accountId: string; sessionId: string;
  generation: number; rows: unknown[]; conflictCount: number; derivedAt: Date;
}
const derivedSchema = new Schema<UsageRecordDerivedDoc>({
  memberId: { type: Schema.Types.ObjectId, required: true }, tool: String,
  accountId: String, sessionId: String, generation: Number,
  rows: { type: [Schema.Types.Mixed], default: [] }, conflictCount: Number, derivedAt: Date,
}, { collection: "usagerecordderived", versionKey: false });
derivedSchema.index({ memberId: 1, tool: 1, accountId: 1, sessionId: 1 }, { unique: true });

export interface UsageRecordDeviceDoc {
  memberId: Types.ObjectId; machineId: string; label: string | null;
  uploaderVersion: string; buildHash: string | null;
  lastReceiptAt: Date; lastRunAt: Date | null;
  receiptCount: number; acceptedCount: number; rejectedCount: number; conflictCount: number;
  pending: number | null; reportedRejected: number | null; readErrors: number | null;
  healthStatus: string | null; parserHealth: unknown[];
}
const deviceSchema = new Schema<UsageRecordDeviceDoc>({
  memberId: { type: Schema.Types.ObjectId, required: true }, machineId: { type: String, required: true },
  label: { type: String, default: null }, uploaderVersion: { type: String, required: true },
  buildHash: { type: String, default: null }, lastReceiptAt: { type: Date, required: true },
  lastRunAt: { type: Date, default: null }, receiptCount: { type: Number, default: 0 },
  acceptedCount: { type: Number, default: 0 }, rejectedCount: { type: Number, default: 0 },
  conflictCount: { type: Number, default: 0 }, pending: { type: Number, default: null },
  reportedRejected: { type: Number, default: null }, readErrors: { type: Number, default: null },
  healthStatus: { type: String, default: null },
  parserHealth: { type: [Schema.Types.Mixed], default: [] },
}, { collection: "usagerecorddevices", versionKey: false });
deviceSchema.index({ memberId: 1, machineId: 1 }, { unique: true });

export interface UsageRecordDeviceSourceDoc {
  memberId: Types.ObjectId; machineId: string; tool: string; accountId: string;
  receiptCount: number; lastReceiptAt: Date; lastSourceAt: Date | null;
}
const deviceSourceSchema = new Schema<UsageRecordDeviceSourceDoc>({
  memberId: { type: Schema.Types.ObjectId, required: true }, machineId: { type: String, required: true },
  tool: { type: String, required: true }, accountId: { type: String, required: true },
  receiptCount: { type: Number, default: 0 }, lastReceiptAt: { type: Date, required: true },
  lastSourceAt: { type: Date, default: null },
}, { collection: "usagerecorddevicesources", versionKey: false });
deviceSourceSchema.index({ memberId: 1, machineId: 1, tool: 1, accountId: 1 }, { unique: true });

export const UsageRecord: Model<UsageRecordDoc> = mongoose.models.UsageRecord ?? mongoose.model<UsageRecordDoc>("UsageRecord", recordSchema);
export const UsageRecordConflict: Model<UsageRecordConflictDoc> = mongoose.models.UsageRecordConflict ?? mongoose.model<UsageRecordConflictDoc>("UsageRecordConflict", conflictSchema);
export const UsageRecordChain: Model<UsageRecordChainDoc> = mongoose.models.UsageRecordChain ?? mongoose.model<UsageRecordChainDoc>("UsageRecordChain", chainSchema);
export const UsageRecordDerived: Model<UsageRecordDerivedDoc> = mongoose.models.UsageRecordDerived ?? mongoose.model<UsageRecordDerivedDoc>("UsageRecordDerived", derivedSchema);
export const UsageRecordDevice: Model<UsageRecordDeviceDoc> = mongoose.models.UsageRecordDevice ?? mongoose.model<UsageRecordDeviceDoc>("UsageRecordDevice", deviceSchema);
export const UsageRecordDeviceSource: Model<UsageRecordDeviceSourceDoc> = mongoose.models.UsageRecordDeviceSource ?? mongoose.model<UsageRecordDeviceSourceDoc>("UsageRecordDeviceSource", deviceSourceSchema);
