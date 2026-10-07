import mongoose, { Schema, type Model } from "mongoose";
import type { UsageReportSnapshot } from "@/lib/usage-report-types";

export interface UsageReportDoc extends UsageReportSnapshot { key: string; collectedAt: Date }
const schema = new Schema<UsageReportDoc>({
  key: { type: String, required: true, unique: true },
  sourceId: { type: String, required: true }, accountId: { type: String, required: true },
  periodStart: { type: String, required: true }, periodEnd: { type: String, required: true },
  timeZone: { type: String, required: true }, granularity: { type: String, enum: ["day", "period"], required: true },
  coverage: { type: String, enum: ["full", "overage", "unknown"], required: true }, partition: { type: String, default: "" },
  rows: { type: Schema.Types.Mixed, required: true }, collectedAt: { type: Date, required: true },
}, { collection: "usagereportsnapshots", versionKey: false });
schema.index({ sourceId: 1, periodEnd: -1 });
export const UsageReport: Model<UsageReportDoc> = mongoose.models.UsageReportSnapshot ?? mongoose.model<UsageReportDoc>("UsageReportSnapshot", schema);
