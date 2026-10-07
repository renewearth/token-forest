import mongoose, { Schema, type Model } from "mongoose";
import type { ExperimentRecord } from "./experiments";
// One document is the atomic visibility boundary, including review consent.
// Explicit revision CAS protects concurrent review saves and parent withdrawal.
const schema = new Schema<ExperimentRecord>({
  _id: { type: String, required: true }, ownerId: { type: String, required: true }, input: { type: Schema.Types.Mixed }, status: { type: String, required: true }, contentVersion: Number, revision: Number, visibilityVersion: Number, publicationCycle: Number, audience: { type: Schema.Types.Mixed }, audienceSince: { type: Schema.Types.Mixed }, visibleSince: { type: String, default: null }, firstPublishedAt: { type: String, default: null }, createdAt: String, updatedAt: String, reviews: { type: Schema.Types.Mixed, default: [] }, lastRequest: String, deletedAt: String,
}, { collection: "experiments", versionKey: false, strict: "throw" });
schema.index({ status: 1, firstPublishedAt: -1, _id: -1 });
schema.index({ ownerId: 1, createdAt: -1 });
schema.index({ "reviews.ownerId": 1 });
export const Experiment = (mongoose.models.Experiment as Model<ExperimentRecord>) ?? mongoose.model<ExperimentRecord>("Experiment", schema);
