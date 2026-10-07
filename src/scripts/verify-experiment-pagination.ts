import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { connectDb, closeDb, Member } from "../lib/db";
import { Experiment } from "../lib/experiments-model";
import { emptyExperiment, parentConsent, type Audience } from "../lib/experiments";
import { createExperiment, getExperiment, listExperiments, publishExperiment, withdrawExperiment } from "../lib/experiments-service";
import { getMixedKnowhowFeed } from "../lib/experiments-feed";

if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/tf-v2-test-[a-z\d-]+(?:\?.*)?$/i.test(process.env.MONGODB_URI ?? "")) throw Error("Explicit local synthetic database required.");
const [A, B, C] = Array.from({ length: 3 }, () => new Types.ObjectId().toHexString());
const ids: string[] = [];
const tag = `cursor-${randomUUID().slice(0, 12)}`;
const team: Audience = { kind: "team" };
let passed = 0;
function check(value: unknown, label: string) { assert.ok(value, label); passed++; console.log(`PASS ${label}`); }
async function publish(id: string, audience: Audience) { const e = (await getExperiment(A, id))!; return publishExperiment(A, id, parentConsent(e), audience, randomUUID()); }
async function allAfter(viewer: string, first: Awaited<ReturnType<typeof listExperiments>>) { const found = first.items.map((e) => e._id); let cursor = first.nextCursor; while (cursor) { const next = await listExperiments(viewer, { tag, cursor }); found.push(...next.items.map((e) => e._id)); cursor = next.nextCursor; } return found; }
async function mixedAfter(viewer: string, first: Awaited<ReturnType<typeof getMixedKnowhowFeed>>) { const found = first.items.map((e) => e.kind === "experiment" ? e.experiment._id : e.post.id); let cursor = first.nextCursor; while (cursor) { const next = await getMixedKnowhowFeed(viewer, { type: "experiments", tag, cursor }); found.push(...next.items.map((e) => e.kind === "experiment" ? e.experiment._id : e.post.id)); cursor = next.nextCursor; } return found; }
async function run() {
  await connectDb(); process.env.TOKEN_FOREST_EXPERIMENTS_MODE = "team";
  await Member.create([A, B, C].map((id) => ({ _id: id, name: "합성 커서", email: `${id}@example.invalid` })));
  for (let i = 0; i < 46; i++) { const e = await createExperiment(A, randomUUID(), { ...emptyExperiment, title: `표본 ${i}`, problem: "문제", method: "방법", result: "stopped", limitations: "한계", tags: [tag] }); ids.push(e._id); await publish(e._id, i === 45 ? { kind: "pilot", memberIds: [A, B] } : team); }
  const candidate = ids[45];
  await Experiment.updateMany({ _id: { $in: ids.slice(0, 45) } }, { $set: { firstPublishedAt: "2020-01-02T00:00:00.000Z" } });
  await Experiment.updateOne({ _id: candidate }, { $set: { firstPublishedAt: "2020-01-01T00:00:00.000Z" } });
  const [beforeB, beforeC, mixedB, mixedC] = await Promise.all([listExperiments(B, { tag }), listExperiments(C, { tag }), getMixedKnowhowFeed(B, { tag, type: "experiments" }), getMixedKnowhowFeed(C, { tag, type: "experiments" })]);
  check(!beforeB.items.some((e) => e._id === candidate) && !!beforeB.nextCursor && !!beforeC.nextCursor, "candidate is beyond first page for existing and new readers");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await publish(candidate, team);
  const [seenB, seenC, seenMixedB, seenMixedC] = await Promise.all([allAfter(B, beforeB), allAfter(C, beforeC), mixedAfter(B, mixedB), mixedAfter(C, mixedC)]);
  check(seenB.length === 46 && new Set(seenB).size === 46 && seenB.includes(candidate), "AC45 audience expansion retains every existing reader item");
  check(seenC.length === 45 && !seenC.includes(candidate), "AC45 newly admitted reader waits until refresh");
  check(seenMixedB.length === 46 && seenMixedB.includes(candidate), "AC45 mixed feed retains existing reader item");
  check(seenMixedC.length === 45 && !seenMixedC.includes(candidate), "AC45 mixed feed defers newly admitted item");
  const refreshed = await allAfter(C, await listExperiments(C, { tag })); check(refreshed.includes(candidate), "new reader sees expanded item on refresh");
  const view = (await getExperiment(C, candidate))!; check(!("audienceSince" in view), "per-reader visibility history never enters public DTO");
  const beforeRevoke = await listExperiments(B, { tag });
  await new Promise((resolve) => setTimeout(resolve, 5)); await publish(candidate, { kind: "pilot", memberIds: [A, C] }); await publish(candidate, team);
  check(!(await allAfter(B, beforeRevoke)).includes(candidate), "revoked and later re-added reader gets a new boundary");
  const beforeWithdrawal = await listExperiments(C, { tag });
  await new Promise((resolve) => setTimeout(resolve, 5)); await withdrawExperiment(A, candidate, parentConsent((await getExperiment(A, candidate))!), randomUUID()); await publish(candidate, team);
  check(!(await allAfter(C, beforeWithdrawal)).includes(candidate), "withdraw then republish starts a new boundary for every reader");
  console.log(`PASS ${passed} experiment pagination regression checks`);
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await Experiment.deleteMany({ _id: { $in: ids } }); await Member.deleteMany({ _id: { $in: [A, B, C] } }); await closeDb(); });
