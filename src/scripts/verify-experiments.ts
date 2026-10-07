import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { connectDb, closeDb, Member, Post } from "../lib/db";
import { Experiment } from "../lib/experiments-model";
import { parentConsent, audienceSubset, canReadExperiment, canReadReview, emptyExperiment, experimentInputSchema, experimentView, publishErrors, reviewInputSchema, type ExperimentInput, type ExperimentRecord, type ReviewInput } from "../lib/experiments";
import * as service from "../lib/experiments-service";
import { getMixedKnowhowFeed } from "../lib/experiments-feed";

// Deliberately refuses arbitrary DBs. The runner must supply a disposable local
// database whose name begins with tf-v2-test-; never reads a project .env file.
const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/tf-v2-test-[a-z\d-]+(?:\?.*)?$/i.test(uri)) throw Error("Use an explicitly provided local tf-v2-test-* synthetic database.");
let checks = 0;
function check(condition: unknown, label: string) { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); }
async function rejected(promise: Promise<unknown>, code: string, label: string) { await assert.rejects(promise, (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code, label); checks++; console.log(`PASS ${label}`); }
const ids = Array.from({ length: 4 }, () => new Types.ObjectId().toHexString()); const [A, B, C, D] = ids;
const created: string[] = []; const posts: Types.ObjectId[] = [];
const pilot = { kind: "pilot" as const, memberIds: [A, B] };
const full: ExperimentInput = { ...emptyExperiment, title: "합성 실험", problem: "문서 확인", method: "두 번 검수", result: "worsened", limitations: "기존보다 느렸음", tags: ["합성"], links: ["https://example.com/reference"] };
const review: ReviewInput = { conditions: "작은 문서에 적용", result: "stopped", limitations: "중단한 이유와 한계", links: [], appliedVersion: 1, tried: true };
const req = () => randomUUID();
async function create(owner = A, input = full) { const id = req(); created.push(id); return service.createExperiment(owner, id, input); }
async function publish(id: string, owner = A, audience = pilot) { const e = await service.getExperiment(owner, id); assert.ok(e); return service.publishExperiment(owner, id, parentConsent(e), audience, req()); }
async function run() {
  await connectDb(); await Experiment.init(); await Member.create(ids.map((id, n) => ({ _id: id, name: `AX 합성 ${n}`, email: `ax-${id}@example.invalid` })));
  process.env.TOKEN_FOREST_EXPERIMENTS_MODE = "pilot"; process.env.TOKEN_FOREST_EXPERIMENTS_PILOT_IDS = [A, B].join(",");
  check(experimentInputSchema.safeParse(emptyExperiment).success, "AC20 incomplete draft is valid");
  check(Object.keys(publishErrors(emptyExperiment)).length === 5, "AC20 missing publish fields reported individually");
  for (const result of ["improved", "unchanged", "worsened", "uncertain", "stopped"] as const) check(Object.keys(publishErrors({ ...full, result })).length === 0, `AC21 ${result} may be published`);
  check(experimentInputSchema.safeParse({ ...full, title: "🌳".repeat(120) }).success && !experimentInputSchema.safeParse({ ...full, title: "🌳".repeat(121) }).success, "AC33 unicode codepoint limit");
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/a"]) check(!experimentInputSchema.safeParse({ ...full, links: [value] }).success, "AC33 reject non-http link");
  check(!experimentInputSchema.safeParse({ ...full, ownerId: B }).success, "AC33 reject injected ownership field");
  check(experimentInputSchema.safeParse({ ...full, method: "<script>alert(1)</script>" }).success, "AC33 text remains valid and is rendered as escaped React text");
  for (const value of [-1, Infinity, NaN]) check(!experimentInputSchema.safeParse({ ...full, measurement: { before: value, unit: "분" } }).success, "AC22 invalid measurement rejected");
  check(!experimentInputSchema.safeParse({ ...full, measurement: { start: "2026-02-30" } }).success, "AC22 impossible date rejected");
  check(!experimentInputSchema.safeParse({ ...full, measurement: { start: "2026-10-03", end: "2026-10-01" } }).success, "AC22 inverted dates rejected");
  check(!experimentInputSchema.safeParse({ ...full, measurement: { before: 0 } }).success, "AC22 measurement needs unit");
  check(!reviewInputSchema.safeParse({ ...review, appliedVersion: 1.5 }).success, "AC33 fractional applied version rejected");
  const draft = await create(A, emptyExperiment);
  check(await service.getExperiment(B, draft._id) === null && await service.getExperiment(null, draft._id) === null, "AC23 private detail hidden from other member and anonymous");
  check(await service.getExperiment(B, "bad-id") === null, "AC23 malformed ID has identical unavailable response");
  await rejected(service.saveExperiment(B, draft._id, 1, full, req()), "not_found", "AC23 unauthorized edit denied");
  await rejected(service.publishExperiment(A, draft._id, parentConsent(draft), pilot, req()), "validation", "AC20 cannot publish incomplete draft");
  check((await service.listExperiments(B)).items.every((e) => e._id !== draft._id), "AC23 drafts absent from lists and metadata");
  const reused = await service.createExperiment(A, draft._id, full); check(reused._id === draft._id && reused.input.title === "", "AC35 create retry retains first draft, one ID");
  const editRequest = req(); const edited = await service.saveExperiment(A, draft._id, 1, full, editRequest);
  const editRetry = await service.saveExperiment(A, draft._id, 1, full, editRequest); check(editRetry.contentVersion === edited.contentVersion, "AC35 same save request is idempotent");
  await rejected(service.saveExperiment(A, draft._id, 1, { ...full, title: "古い" }, req()), "conflict", "AC26 stale save rejected");
  const exp = await create(); let shared = await publish(exp._id); const first = shared.firstPublishedAt;
  check(!!await service.getExperiment(B, exp._id), "pilot participant reads shared experiment");
  const byAuthor = await service.listExperiments(B, { owner: A });
  check(byAuthor.items.some((e) => e._id === exp._id) && byAuthor.items.every((e) => e.ownerId === A && e.status === "published"), "member profile author filter retains viewer visibility");
  check((await service.listExperiments(B, { owner: C })).items.length === 0 && (await service.listExperiments(null, { owner: A })).items.length === 0, "member profile empty and anonymous responses leak no metadata");
  process.env.TOKEN_FOREST_EXPERIMENTS_PILOT_IDS = [A, B, C].join(",");
  check(await service.getExperiment(C, exp._id) === null && !(await service.listExperiments(C)).items.some((e) => e._id === exp._id), "AC42 added pilot cannot see prior fixed audience");
  await rejected(service.saveReview(A, exp._id, 0, review, req()), "not_found", "AC27 own experiment review forbidden");
  const sameRequest = req(); const concurrent = await Promise.all([service.saveReview(B, exp._id, 0, review, sameRequest), service.saveReview(B, exp._id, 0, review, sameRequest)]);
  check(concurrent[0].version === 1 && concurrent[1].version === 1 && (await Experiment.findById(exp._id).lean())!.reviews.length === 1, "AC27 duplicate concurrent review requests create one review");
  check((await service.getExperiment(A, exp._id))!.reviews.length === 0, "AC29 original author cannot read colleague draft");
  let r = await service.publishReview(B, exp._id, 1, parentConsent(shared), pilot, req());
  check((await service.getExperiment(A, exp._id))!.reviews.length === 1, "shared review visible within both audiences");
  const staleConsent = shared; shared = await service.saveExperiment(A, exp._id, 1, { ...full, title: "원문 버전 2" }, req());
  check(shared.firstPublishedAt === first && shared.contentVersion === 2 && shared.reviews[0].input.appliedVersion === 1, "AC26/28 first publication stable and review keeps applied version");
  await rejected(service.publishReview(B, exp._id, r.version, parentConsent(staleConsent), pilot, req()), "conflict", "AC44 delayed preview rejected after content edit");
  r = await service.publishReview(B, exp._id, r.version, parentConsent(shared), pilot, req()); check(r.input.appliedVersion === 1, "AC48 explicit re-confirmation preserves historical applied version");
  process.env.TOKEN_FOREST_EXPERIMENTS_MODE = "team";
  await rejected(service.publishReview(B, exp._id, r.version, parentConsent(shared), { kind: "team" }, req()), "validation", "AC47 review cannot exceed parent audience");
  shared = await service.publishExperiment(A, exp._id, parentConsent(shared), { kind: "team" }, req());
  const forC = await service.getExperiment(C, exp._id); check(!!forC && forC.reviews.length === 0, "AC43 expanded parent does not expand review metadata/count");
  r = await service.publishReview(B, exp._id, r.version, parentConsent(shared), { kind: "team" }, req()); check((await service.getExperiment(C, exp._id))!.reviews.length === 1, "AC47 review visible after independent valid consent");
  const beforeWithdraw = shared; shared = await service.withdrawExperiment(A, exp._id, parentConsent(shared), req());
  check(await service.getExperiment(B, exp._id) === null && !!await service.getOwnReview(B, exp._id), "AC24 reviewer can read only own review after withdrawal");
  shared = await service.publishExperiment(A, exp._id, parentConsent(shared), { kind: "team" }, req());
  check((await service.getExperiment(C, exp._id))!.reviews.length === 0, "AC25 republishing parent does not resurrect reviews");
  await rejected(service.publishReview(B, exp._id, r.version, parentConsent(beforeWithdraw), { kind: "team" }, req()), "conflict", "AC44 old publication cycle cannot authorize delayed review");
  const raceConsent = shared; const race = await Promise.allSettled([service.publishReview(B, exp._id, r.version, parentConsent(raceConsent), { kind: "team" }, req()), service.withdrawExperiment(A, exp._id, parentConsent(raceConsent), req())]);
  check(race[1].status === "fulfilled" && await service.getExperiment(C, exp._id) === null, "AC30 withdrawal wins visibility under concurrent review publish");
  const beforeDelete = await service.getExperiment(A, exp._id); assert.ok(beforeDelete);
  await service.publishExperiment(A, exp._id, parentConsent(beforeDelete), { kind: "team" }, req());
  const delConsent = (await service.getExperiment(B, exp._id))!; const own = (await service.getOwnReview(B, exp._id))!;
  await Promise.allSettled([service.publishReview(B, exp._id, own.version, parentConsent(delConsent), { kind: "team" }, req()), service.deleteExperiment(A, exp._id, req())]);
  const tombstone = await Experiment.findById(exp._id).lean(); check(tombstone?.status === "deleted" && !tombstone.input && !tombstone.reviews?.length && !tombstone.contentVersion, "AC31 deletion immediately erases content, measurements and reviews");
  check(await service.getExperiment(A, exp._id) === null && await service.getOwnReview(B, exp._id) === null, "AC30 deleted aggregate invisible even to owners");
  await rejected(service.createExperiment(A, exp._id, full), "not_found", "AC30 create retry cannot resurrect tombstone");
  await service.deleteExperiment(A, exp._id, req()); check(true, "AC31 repeated delete succeeds without content revival");
  const one = await create(); await publish(one._id, A, pilot);
  process.env.TOKEN_FOREST_EXPERIMENTS_MODE = "off";
  check(!!await service.getExperiment(A, one._id) && (await service.listOwnExperiments(A)).some((e) => e._id === one._id), "feature off retains owner reading and private list");
  check((await service.listExperiments(B)).items.length === 0 && await service.getExperiment(B, one._id) === null, "feature off exposes no teammate feed/detail");
  await rejected(service.createExperiment(A, req(), full), "disabled", "feature off blocks creation");
  const off = (await service.getExperiment(A, one._id))!; await service.withdrawExperiment(A, one._id, parentConsent(off), req()); await service.deleteExperiment(A, one._id, req()); check(true, "feature off retains withdrawal and deletion");
  process.env.TOKEN_FOREST_EXPERIMENTS_MODE = "team";
  const many: string[] = [];
  for (let n = 0; n < 45; n++) { const e = await create(A, { ...full, title: `페이지 ${n}`, tags: ["pagination"] }); many.push(e._id); await publish(e._id); }
  await Experiment.updateMany({ _id: { $in: many } }, { $set: { firstPublishedAt: "2026-01-01T00:00:00.000Z", visibleSince: "2026-01-01T00:00:00.000Z" } });
  const page1 = await service.listExperiments(B, { tag: "pagination" }); check(page1.items.length === 20 && !!page1.nextCursor, "AC34 first page capped at twenty");
  const newest = await create(A, { ...full, tags: ["pagination"] }); await publish(newest._id);
  const seen = [...page1.items.map((e) => e._id)]; let cursor = page1.nextCursor;
  while (cursor) { const page = await service.listExperiments(B, { tag: "pagination", cursor }); seen.push(...page.items.map((e) => e._id)); cursor = page.nextCursor; }
  check(seen.length === 45 && new Set(seen).size === 45 && !seen.includes(newest._id), "AC34/45 stable equal-time cursor, new posts wait for refresh");
  const legacy = await Post.create({ source: "ingest", title: "기존 일반 글", bodyMarkdown: "본문", link: full.links[0], tags: ["pagination"], authorMemberId: A, activityAt: new Date() }); posts.push(legacy._id);
  const anonMixed = await getMixedKnowhowFeed(null, { tag: "pagination" }); check(anonMixed.items.length === 1 && anonMixed.items[0].kind === "general", "AC32/38 mixed anonymous feed preserves general posts but no experiments");
  const mixed = await getMixedKnowhowFeed(B, { tag: "pagination" }); check(mixed.items.length === 20, "AC34 mixed list also capped at twenty");
  check((await getMixedKnowhowFeed(C, { type: "experiments", tag: "pagination" })).items.every((item) => item.kind !== "experiment" || item.experiment.audience?.kind === "team"), "AC42 mixed feed applies fixed audience before pagination");
  const raw = (await Experiment.findById(many[0]).lean()) as ExperimentRecord;
  check(!canReadExperiment(raw, null) && experimentView(raw, D) === null, "permission helpers cannot bypass parent audience");
  check(!audienceSubset({ kind: "team" }, pilot), "team audience is not a pilot subset");
  check(!canReadReview(raw, { ownerId: B, input: review, status: "published", version: 1, audience: pilot, visibilityVersion: 1, approvedCycle: raw.publicationCycle + 1, updatedAt: new Date().toISOString(), lastRequest: req() }, A), "review publication cycle checked on every projection");
  console.log(`PASS ${checks} experiment verification checks`);
}
run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await Experiment.deleteMany({ _id: { $in: created } }); await Post.deleteMany({ _id: { $in: posts } }); await Member.deleteMany({ _id: { $in: ids } }); await closeDb(); });
