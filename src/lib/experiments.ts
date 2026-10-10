import { z } from "zod";

export const RESULTS = { improved: "개선됨", unchanged: "차이 없음", worsened: "악화됨", uncertain: "판단 유보", stopped: "중단" } as const;
export const resultSchema = z.enum(["improved", "unchanged", "worsened", "uncertain", "stopped"]);
export const codepoints = (s: string) => Array.from(s).length;
const text = (max: number) => z.string().trim().refine((s) => codepoints(s) <= max, `최대 ${max}자입니다.`);
const date = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, "올바른 날짜를 입력하세요.");
const link = text(2048).refine((s) => { try { return ["http:", "https:"].includes(new URL(s).protocol); } catch { return false; } }, "http(s) 링크만 가능합니다.");
export const measurementSchema = z.object({
  kind: z.enum(["estimate", "direct", "reference"]).optional(), method: text(2000).optional(), start: date.optional(), end: date.optional(), sampleSize: z.number().int().positive().optional(), taskUnit: text(120).optional(), unit: text(120).optional(), qualityMethod: text(2000).optional(), qualityMet: z.enum(["yes", "no", "unknown"]).optional(), before: z.number().finite().nonnegative().optional(), after: z.number().finite().nonnegative().optional(), aggregation: z.enum(["total", "per-task"]).optional(), includesReview: z.enum(["yes", "no", "unknown"]).optional(), comparable: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.start && v.end && v.start > v.end) ctx.addIssue({ code: "custom", path: ["end"], message: "종료일은 시작일 이후여야 합니다." });
  if ((v.before !== undefined || v.after !== undefined) && !v.unit) ctx.addIssue({ code: "custom", path: ["unit"], message: "수치에는 단위가 필요합니다." });
});
export const experimentInputSchema = z.object({ title: text(120), problem: text(2000), method: text(4000), result: resultSchema.nullable(), limitations: text(4000), tags: z.array(text(30).refine(Boolean, "빈 태그는 허용하지 않습니다.")).max(5), tools: z.array(text(120).refine(Boolean)).max(10), links: z.array(link).max(3), measurement: measurementSchema.nullable() }).strict();
export type ExperimentInput = z.infer<typeof experimentInputSchema>;
export const emptyExperiment: ExperimentInput = { title: "", problem: "", method: "", result: null, limitations: "", tags: [], tools: [], links: [], measurement: null };
export const reviewInputSchema = z.object({ conditions: text(2000), result: resultSchema.nullable(), limitations: text(4000), links: z.array(link).max(3), appliedVersion: z.number().int().positive(), tried: z.boolean() }).strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export const audienceSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("team") }).strict(), z.object({ kind: z.literal("pilot"), memberIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(1000) }).strict()]);
export type Audience = z.infer<typeof audienceSchema>;
export type ExperimentMode = "off" | "pilot" | "team";
export function experimentConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode: ExperimentMode = env.TOKEN_FOREST_EXPERIMENTS_MODE === "team" ? "team" : env.TOKEN_FOREST_EXPERIMENTS_MODE === "pilot" ? "pilot" : "off";
  return { mode, pilotIds: [...new Set((env.TOKEN_FOREST_EXPERIMENTS_PILOT_IDS ?? "").split(",").map((v) => v.trim()).filter((v) => /^[a-f\d]{24}$/i.test(v)))] };
}
export function enabledFor(id: string, config = experimentConfig()) { return config.mode === "team" || (config.mode === "pilot" && config.pilotIds.includes(id)); }
export function proposedAudience(config = experimentConfig()): Audience { return config.mode === "team" ? { kind: "team" } : { kind: "pilot", memberIds: config.pilotIds }; }
export function inAudience(a: Audience | null, id: string) { return !!a && (a.kind === "team" || a.memberIds.includes(id)); }
export function audienceSubset(child: Audience, parent: Audience) { return parent.kind === "team" || (child.kind === "pilot" && child.memberIds.every((id) => parent.memberIds.includes(id))); }
export function audienceLabel(a: Audience | null) { return a?.kind === "team" ? "현재 및 앞으로 이 설치 환경에 등록되는 팀 구성원" : a ? `확인한 시범 참여자 ${a.memberIds.length}명 (대상 고정)` : "본인만"; }
export function publishErrors(v: ExperimentInput): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, label] of [["title", "제목"], ["problem", "업무 문제"], ["method", "시도한 방법"], ["result", "결과 상태"], ["limitations", "결과와 한계"]] as const) if (!v[key]) errors[key] = `${label}을 입력하세요.`;
  if (v.measurement?.kind === "direct") for (const key of ["method", "start", "end", "sampleSize", "taskUnit", "qualityMethod"] as const) if (!v.measurement[key]) errors[`measurement.${key}`] = "직접 측정 근거를 완성하세요.";
  return errors;
}
export function reviewPublishErrors(v: ReviewInput) { const errors: Record<string, string> = {}; for (const key of ["conditions", "result", "limitations", "tried"] as const) if (!v[key]) errors[key] = key === "tried" ? "직접 적용했음을 확인하세요." : "후기 공유 필수 항목입니다."; return errors; }
export type ReviewRecord = { ownerId: string; input: ReviewInput; version: number; status: "draft" | "published" | "withdrawn"; audience: Audience | null; visibilityVersion: number; approvedCycle: number; updatedAt: string; lastRequest: string };
export type ExperimentRecord = { _id: string; ownerId: string; input: ExperimentInput; status: "draft" | "published" | "withdrawn" | "deleted"; contentVersion: number; revision: number; visibilityVersion: number; publicationCycle: number; audience: Audience | null; audienceSince?: { team: string | null; members: Record<string, string> }; visibleSince: string | null; firstPublishedAt: string | null; createdAt: string; updatedAt: string; reviews: ReviewRecord[]; lastRequest: string; deletedAt?: string };
export function canReadExperiment(e: ExperimentRecord, viewer: string | null) { return !!viewer && e.status !== "deleted" && (e.ownerId === viewer || (e.status === "published" && inAudience(e.audience, viewer))); }
export function canReadReview(e: ExperimentRecord, r: ReviewRecord, viewer: string | null) { return !!viewer && e.status !== "deleted" && (r.ownerId === viewer || (canReadExperiment(e, viewer) && e.status === "published" && r.status === "published" && r.approvedCycle === e.publicationCycle && inAudience(r.audience, viewer))); }
export type ExperimentView = Omit<ExperimentRecord, "lastRequest" | "reviews" | "revision" | "audienceSince"> & { reviews: Omit<ReviewRecord, "lastRequest">[]; isOwner: boolean };
export function experimentView(e: ExperimentRecord, viewer: string): ExperimentView | null { if (!canReadExperiment(e, viewer)) return null; const { lastRequest: _request, revision: _revision, audienceSince: _since, reviews, ...rest } = e; void _request; void _revision; void _since; return { ...rest, reviews: reviews.filter((r) => canReadReview(e, r, viewer)).map(({ lastRequest: _last, ...r }) => { void _last; return r; }), isOwner: e.ownerId === viewer }; }
export class ExperimentError extends Error { constructor(public code: "not_found" | "conflict" | "validation" | "disabled", message: string, public fields: Record<string, string> = {}) { super(message); } }
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T { const r = schema.safeParse(input); if (!r.success) throw new ExperimentError("validation", "입력 항목을 확인하세요.", Object.fromEntries(r.error.issues.map((e) => [e.path.join("."), e.message]))); return r.data; }
export function assertPublish(input: ExperimentInput) { const errors = publishErrors(input); if (Object.keys(errors).length) throw new ExperimentError("validation", "공유 필수 항목을 확인하세요.", errors); }

export function parentConsent(e: { contentVersion: number; visibilityVersion: number; publicationCycle: number }) { return { contentVersion: e.contentVersion, visibilityVersion: e.visibilityVersion, publicationCycle: e.publicationCycle }; }

// Earliest continuously authorized time for each existing reader. The team
// timestamp covers future members, while pilot-reader exceptions preserve
// their older boundary when an author expands to the whole team.
export function publicationAudienceSince(e: ExperimentRecord, next: Audience, now: string): NonNullable<ExperimentRecord["audienceSince"]> {
  const continuing = e.status === "published";
  const previousTime = (id: string) => e.audienceSince?.members[id] ?? e.audienceSince?.team ?? e.visibleSince ?? e.firstPublishedAt ?? now;
  if (next.kind === "pilot") {
    const members = Object.fromEntries(next.memberIds.map((id) => [id, continuing && inAudience(e.audience, id) ? previousTime(id) : now]));
    return { team: null, members };
  }
  if (continuing && e.audience?.kind === "team") return { team: e.audienceSince?.team ?? e.visibleSince ?? e.firstPublishedAt ?? now, members: e.audienceSince?.members ?? {} };
  const members = continuing && e.audience?.kind === "pilot" ? Object.fromEntries(e.audience.memberIds.map((id) => [id, previousTime(id)])) : {};
  return { team: now, members };
}
// Applied in the database before limits, never as a post-pagination filter.
// Legacy rows predate this field and use their previous visibility timestamp.
export function audienceBoundaryFilter(viewer: string, boundary: string) {
  return { $or: [
    { [`audienceSince.members.${viewer}`]: { $lte: boundary } },
    { "audienceSince.team": { $lte: boundary } },
    { audienceSince: { $exists: false }, visibleSince: { $lte: boundary } },
  ] };
}
