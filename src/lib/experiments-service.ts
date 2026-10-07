import { randomUUID } from "node:crypto";
import { z } from "zod";
import { connectDb, Member } from "./db";
import { Experiment } from "./experiments-model";
import { audienceBoundaryFilter, publicationAudienceSince, audienceSchema, audienceSubset, assertPublish, canReadExperiment, canReadReview, enabledFor, experimentInputSchema, experimentView, ExperimentError, parseInput, proposedAudience, reviewInputSchema, reviewPublishErrors, type Audience, type ExperimentRecord, type ExperimentView, type ReviewRecord } from "./experiments";

const idSchema = z.string().uuid();
const versionSchema = z.number().int().positive();
const notFound = () => new ExperimentError("not_found", "기록을 찾을 수 없습니다.");
const conflict = () => new ExperimentError("conflict", "다른 변경이 반영됐습니다. 입력은 보존됩니다. 현재 내용을 다시 확인하세요.");
async function member(id: string | null) { if (!id || !/^[a-f\d]{24}$/i.test(id)) throw notFound(); await connectDb(); if (!await Member.exists({ _id: id })) throw notFound(); return id; }
function active(id: string) { if (!enabledFor(id)) throw new ExperimentError("disabled", "현재 신규 작성·공유를 이용할 수 없습니다. 기존 기록은 읽기·철회·삭제할 수 있습니다."); }
async function record(id: string) { if (!idSchema.safeParse(id).success) throw notFound(); const row = await Experiment.findById(id).lean(); if (!row || row.status === "deleted") throw notFound(); return row; }
function approvedAudience(value: unknown, viewer: string): Audience {
  active(viewer); const a = parseInput(audienceSchema, value); const proposed = proposedAudience();
  if (!audienceSubset(a, proposed)) throw conflict();
  return a.kind === "pilot" ? { kind: "pilot", memberIds: [...new Set(a.memberIds)].sort() } : a;
}
function sameAudience(a: Audience | null, b: Audience | null) { return JSON.stringify(a) === JSON.stringify(b); }
// Every write tests the complete aggregate revision. Retrying only reconciles
// independent review writes; content versions and consent are checked again.
async function mutate(id: string, viewer: string, requestId: string, change: (e: ExperimentRecord) => ExperimentRecord | null) {
  parseInput(idSchema, requestId);
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await record(id);
    const next = change(current);
    if (!next) return current;
    const result = await Experiment.replaceOne({ _id: id, revision: current.revision, status: { $ne: "deleted" } }, { ...next, revision: current.revision + 1 });
    if (result.modifiedCount) return { ...next, revision: current.revision + 1 };
  }
  void viewer; throw conflict();
}
export async function createExperiment(viewerId: string, id: string, input: unknown) {
  const viewer = await member(viewerId); active(viewer); parseInput(idSchema, id);
  const data = parseInput(experimentInputSchema, input); const now = new Date().toISOString();
  const existing = await Experiment.findById(id).lean();
  if (existing) { if (existing.ownerId !== viewer || existing.status === "deleted") throw notFound(); return experimentView(existing, viewer)!; }
  const entry: ExperimentRecord = { _id: id, ownerId: viewer, input: data, status: "draft", contentVersion: 1, revision: 1, visibilityVersion: 1, publicationCycle: 1, audience: null, visibleSince: null, firstPublishedAt: null, createdAt: now, updatedAt: now, reviews: [], lastRequest: id };
  try { await Experiment.create(entry); } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; const found = await record(id); if (found.ownerId !== viewer) throw notFound(); return experimentView(found, viewer)!; }
  return experimentView(entry, viewer)!;
}
export type ParentConsent = { contentVersion: number; visibilityVersion: number; publicationCycle: number };
const consentSchema = z.object({ contentVersion: versionSchema, visibilityVersion: versionSchema, publicationCycle: versionSchema }).strict();
function consentMatches(e: ExperimentRecord, consent: ParentConsent) { return e.contentVersion === consent.contentVersion && e.visibilityVersion === consent.visibilityVersion && e.publicationCycle === consent.publicationCycle; }
export async function saveExperiment(viewerId: string, id: string, version: number, input: unknown, requestId: string) {
  const viewer = await member(viewerId); active(viewer); parseInput(versionSchema, version); const data = parseInput(experimentInputSchema, input);
  const row = await mutate(id, viewer, requestId, (e) => { if (e.ownerId !== viewer) throw notFound(); if (e.lastRequest === requestId) return null; if (e.contentVersion !== version) throw conflict(); if (e.status === "published") assertPublish(data); return { ...e, input: data, contentVersion: e.contentVersion + 1, updatedAt: new Date().toISOString(), lastRequest: requestId }; });
  return experimentView(row, viewer)!;
}
export async function publishExperiment(viewerId: string, id: string, consent: ParentConsent, audience: unknown, requestId: string) {
  const viewer = await member(viewerId); const c = parseInput(consentSchema, consent); const a = approvedAudience(audience, viewer);
  const row = await mutate(id, viewer, requestId, (e) => { if (e.ownerId !== viewer) throw notFound(); if (e.lastRequest === requestId) return null; if (!consentMatches(e, c)) throw conflict(); assertPublish(e.input); const now = new Date().toISOString(); return { ...e, status: "published", audience: a, audienceSince: publicationAudienceSince(e, a, now), visibilityVersion: e.visibilityVersion + (e.status !== "published" || !sameAudience(e.audience, a) ? 1 : 0), visibleSince: e.status !== "published" || !sameAudience(e.audience, a) ? now : e.visibleSince, firstPublishedAt: e.firstPublishedAt ?? now, updatedAt: now, lastRequest: requestId }; });
  return experimentView(row, viewer)!;
}
export async function withdrawExperiment(viewerId: string, id: string, consent: ParentConsent, requestId: string) {
  const viewer = await member(viewerId); const c = parseInput(consentSchema, consent);
  const row = await mutate(id, viewer, requestId, (e) => { if (e.ownerId !== viewer) throw notFound(); if (e.lastRequest === requestId) return null; if (!consentMatches(e, c)) throw conflict(); return { ...e, status: "withdrawn", publicationCycle: e.publicationCycle + 1, visibilityVersion: e.visibilityVersion + 1, updatedAt: new Date().toISOString(), lastRequest: requestId }; });
  return experimentView(row, viewer)!;
}
export async function deleteExperiment(viewerId: string, id: string, requestId: string) {
  const viewer = await member(viewerId); parseInput(idSchema, id); parseInput(idSchema, requestId);
  // Atomic content erasure now, rather than waiting for a cleanup job. Retained
  // identity prevents create/retry resurrection and contains no user content.
  const row = await Experiment.findOne({ _id: id, ownerId: viewer }).lean(); if (!row) throw notFound(); if (row.status === "deleted") return;
  await Experiment.replaceOne({ _id: id, ownerId: viewer }, { _id: id, ownerId: viewer, status: "deleted", deletedAt: new Date().toISOString() }, { upsert: false });
}
export async function saveReview(viewerId: string, id: string, version: number, input: unknown, requestId: string) {
  const viewer = await member(viewerId); active(viewer); parseInput(z.number().int().nonnegative(), version); const data = parseInput(reviewInputSchema, input);
  const row = await mutate(id, viewer, requestId, (e) => {
    if (e.ownerId === viewer || !canReadExperiment(e, viewer)) throw notFound();
    const old = e.reviews.find((r) => r.ownerId === viewer); if (old?.lastRequest === requestId) return null;
    if ((old?.version ?? 0) !== version || data.appliedVersion > e.contentVersion) throw conflict();
    const review: ReviewRecord = { ownerId: viewer, input: data, version: version + 1, status: "draft", audience: old?.audience ?? null, visibilityVersion: (old?.visibilityVersion ?? 0) + 1, approvedCycle: old?.approvedCycle ?? 0, updatedAt: new Date().toISOString(), lastRequest: requestId };
    return { ...e, reviews: [...e.reviews.filter((r) => r.ownerId !== viewer), review] };
  });
  return row.reviews.find((r) => r.ownerId === viewer)!;
}
export async function publishReview(viewerId: string, id: string, version: number, consent: ParentConsent, audience: unknown, requestId: string) {
  const viewer = await member(viewerId); parseInput(versionSchema, version); const c = parseInput(consentSchema, consent); const a = approvedAudience(audience, viewer);
  const row = await mutate(id, viewer, requestId, (e) => {
    if (e.ownerId === viewer || e.status !== "published" || !canReadExperiment(e, viewer)) throw notFound();
    const old = e.reviews.find((r) => r.ownerId === viewer); if (!old) throw notFound(); if (old.lastRequest === requestId) return null;
    if (old.version !== version || !consentMatches(e, c)) throw conflict();
    if (!e.audience || !audienceSubset(a, e.audience)) throw new ExperimentError("validation", "후기 대상은 현재 원문 대상 안에서만 선택할 수 있습니다.");
    const errors = reviewPublishErrors(old.input); if (Object.keys(errors).length) throw new ExperimentError("validation", "후기 공유 필수 항목을 확인하세요.", errors);
    const review: ReviewRecord = { ...old, status: "published", audience: a, version: old.version + 1, visibilityVersion: old.visibilityVersion + 1, approvedCycle: e.publicationCycle, updatedAt: new Date().toISOString(), lastRequest: requestId };
    return { ...e, reviews: e.reviews.map((r) => r.ownerId === viewer ? review : r) };
  });
  return row.reviews.find((r) => r.ownerId === viewer)!;
}
export async function withdrawReview(viewerId: string, id: string, version: number, requestId: string) {
  const viewer = await member(viewerId); parseInput(versionSchema, version);
  const row = await mutate(id, viewer, requestId, (e) => { const old = e.reviews.find((r) => r.ownerId === viewer); if (!old) throw notFound(); if (old.lastRequest === requestId) return null; if (old.version !== version) throw conflict(); return { ...e, reviews: e.reviews.map((r) => r.ownerId === viewer ? { ...r, status: "withdrawn", version: r.version + 1, visibilityVersion: r.visibilityVersion + 1, lastRequest: requestId, updatedAt: new Date().toISOString() } : r) }; });
  return row.reviews.find((r) => r.ownerId === viewer)!;
}
export async function getExperiment(viewerId: string | null, id: string) { if (!viewerId) return null; const viewer = await member(viewerId); try { const e = await record(id); return e.ownerId === viewer || enabledFor(viewer) ? experimentView(e, viewer) : null; } catch (e) { if (e instanceof ExperimentError && e.code === "not_found") return null; throw e; } }
export async function getOwnReview(viewerId: string | null, id: string) {
  if (!viewerId) return null; const viewer = await member(viewerId);
  try { const e = await record(id); const r = e.reviews.find((r) => r.ownerId === viewer); if (!r || !canReadReview(e, r, viewer)) return null; const { lastRequest: _last, ...safe } = r; void _last; return safe; } catch (e) { if (e instanceof ExperimentError && e.code === "not_found") return null; throw e; }
}
function visibility(viewer: string) { return { status: "published", $or: [{ "audience.kind": "team" }, { "audience.kind": "pilot", "audience.memberIds": viewer }] }; }
const cursorSchema = z.object({ time: z.string().datetime(), id: idSchema, boundary: z.string().datetime(), tag: z.string(), owner: z.string() }).strict();
export async function listExperiments(viewerId: string | null, options: { cursor?: string; tag?: string; owner?: string; limit?: number } = {}) {
  if (!viewerId) return { items: [] as ExperimentView[], nextCursor: null as string | null };
  const viewer = await member(viewerId); if (!enabledFor(viewer)) return { items: [] as ExperimentView[], nextCursor: null as string | null };
  const tag = options.tag?.trim() ?? ""; const owner = options.owner ?? ""; const limit = Math.max(1, Math.min(options.limit ?? 20, 20));
  if (tag.length > 120 || (owner && !/^[a-f\d]{24}$/i.test(owner))) return { items: [] as ExperimentView[], nextCursor: null as string | null };
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (options.cursor) { try { cursor = parseInput(cursorSchema, JSON.parse(Buffer.from(options.cursor, "base64url").toString())); } catch { throw new ExperimentError("validation", "목록 커서가 올바르지 않습니다. 처음부터 조회하세요."); } if (cursor.tag !== tag || cursor.owner !== owner) throw new ExperimentError("validation", "필터 변경 후 첫 페이지부터 조회하세요."); }
  const boundary = cursor?.boundary ?? new Date().toISOString();
  const clauses: object[] = [visibility(viewer), { firstPublishedAt: { $lte: boundary } }, audienceBoundaryFilter(viewer, boundary)];
  if (tag) clauses.push({ "input.tags": tag }); if (owner) clauses.push({ ownerId: owner });
  if (cursor) clauses.push({ $or: [{ firstPublishedAt: { $lt: cursor.time } }, { firstPublishedAt: cursor.time, _id: { $lt: cursor.id } }] });
  const rows = await Experiment.find({ $and: clauses }).sort({ firstPublishedAt: -1, _id: -1 }).limit(limit + 1).lean();
  const more = rows.length > limit; const items = rows.slice(0, limit).map((e) => experimentView(e, viewer)!).filter(Boolean); const last = items.at(-1);
  return { items, nextCursor: more && last ? Buffer.from(JSON.stringify({ time: last.firstPublishedAt, id: last._id, boundary, tag, owner })).toString("base64url") : null };
}
export async function listOwnExperiments(viewerId: string) { const viewer = await member(viewerId); const rows = await Experiment.find({ ownerId: viewer, status: { $ne: "deleted" } }).sort({ createdAt: -1, _id: -1 }).lean(); return rows.map((e) => experimentView(e, viewer)!); }
export async function listOwnReviews(viewerId: string) { const viewer = await member(viewerId); const rows = await Experiment.find({ "reviews.ownerId": viewer, status: { $ne: "deleted" } }).lean(); return rows.flatMap((e) => e.reviews.filter((r) => r.ownerId === viewer).map(({ lastRequest: _last, ...r }) => { void _last; return { experimentId: e._id, review: r, title: enabledFor(viewer) && canReadExperiment(e, viewer) ? e.input.title : null }; })); }
export function newRequestId() { return randomUUID(); }
