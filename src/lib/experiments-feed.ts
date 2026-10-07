import { Types } from "mongoose";
import { connectDb, Member, Post, Reaction } from "./db";
import { audienceBoundaryFilter, enabledFor, experimentView, ExperimentError, type ExperimentView } from "./experiments";
import { Experiment } from "./experiments-model";
import type { FeedPost } from "./knowhow-queries";
export type KnowhowItem = { kind: "general"; post: FeedPost; authorId: string } | { kind: "experiment"; experiment: ExperimentView };
export async function getMixedKnowhowFeed(viewer: string | null, options: { type?: string; tag?: string; owner?: string; cursor?: string } = {}) {
  await connectDb();
  const type = ["all", "general", "experiments"].includes(options.type ?? "") ? options.type! : "all";
  const tag = options.tag?.trim() ?? ""; const owner = options.owner ?? "";
  if (tag.length > 120 || (owner && !/^[a-f\d]{24}$/i.test(owner))) return { items: [] as KnowhowItem[], nextCursor: null };
  const auth = !!viewer && /^[a-f\d]{24}$/i.test(viewer) && !!await Member.exists({ _id: viewer });
  let after: { time: string; id: string; boundary: string; type: string; tag: string; owner: string } | null = null;
  if (options.cursor) { try { const raw = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); if (typeof raw.time !== "string" || Number.isNaN(Date.parse(raw.time)) || typeof raw.boundary !== "string" || Number.isNaN(Date.parse(raw.boundary)) || typeof raw.id !== "string" || !/^[a-f\d-]{24,36}$/i.test(raw.id) || raw.type !== type || raw.tag !== tag || raw.owner !== owner) throw Error(); after = raw; } catch { throw new ExperimentError("validation", "필터나 커서가 변경됐습니다. 첫 페이지부터 다시 조회하세요."); } }
  const boundary = after?.boundary ?? new Date().toISOString();
  function conditions(timeKey: string, dateType: boolean) {
    const value = (s: string) => dateType ? new Date(s) : s;
    const clauses: object[] = [{ [timeKey]: { $lte: value(boundary) } }];
    if (after) clauses.push({ $or: [{ [timeKey]: { $lt: value(after.time) } }, { [timeKey]: value(after.time), $expr: { $lt: [{ $toString: "$_id" }, after.id] } }] });
    return clauses;
  }
  const postClauses = conditions("activityAt", true); if (tag) postClauses.push({ tags: tag }); if (owner) postClauses.push({ authorMemberId: new Types.ObjectId(owner) });
  const experimentClauses = conditions("firstPublishedAt", false); experimentClauses.push(audienceBoundaryFilter(viewer ?? "", boundary)); experimentClauses.push({ status: "published", $or: [{ "audience.kind": "team" }, { "audience.kind": "pilot", "audience.memberIds": viewer }] }); if (tag) experimentClauses.push({ "input.tags": tag }); if (owner) experimentClauses.push({ ownerId: owner });
  const [posts, experiments] = await Promise.all([
    type === "experiments" ? [] : Post.find({ $and: postClauses }).sort({ activityAt: -1, _id: -1 }).limit(21).lean(),
    type === "general" || !auth || !enabledFor(viewer!) ? [] : Experiment.find({ $and: experimentClauses }).sort({ firstPublishedAt: -1, _id: -1 }).limit(21).lean(),
  ]);
  const ranked = [...posts.map((post) => ({ kind: "general" as const, post, id: String(post._id), time: post.activityAt.toISOString() })), ...experiments.map((experiment) => ({ kind: "experiment" as const, experiment, id: experiment._id, time: experiment.firstPublishedAt! }))].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const chosen = ranked.slice(0, 20); const shownPosts = chosen.filter((item) => item.kind === "general").map((item) => item.post);
  const [members, reactions] = await Promise.all([shownPosts.length ? Member.find({ _id: { $in: shownPosts.map((p) => p.authorMemberId) } }, { name: 1 }).lean() : [], shownPosts.length ? Reaction.find({ postId: { $in: shownPosts.map((p) => p._id) } }).lean() : []]);
  const names = new Map(members.map((m) => [String(m._id), m.name]));
  const items: KnowhowItem[] = chosen.map((row) => {
    if (row.kind === "experiment") return { kind: "experiment", experiment: experimentView(row.experiment, viewer!)! };
    const p = row.post; const groups = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const r of reactions) if (String(r.postId) === String(p._id)) { const group = groups.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false }; group.count++; group.mine ||= auth && String(r.memberId) === viewer; groups.set(r.emoji, group); }
    return { kind: "general", authorId: String(p.authorMemberId), post: { id: String(p._id), source: p.source, title: p.title, bodyMarkdown: p.bodyMarkdown, link: p.link, tags: p.tags, authorName: names.get(String(p.authorMemberId)) ?? "알 수 없음", activityAt: p.activityAt.toISOString(), isOwner: auth && String(p.authorMemberId) === viewer, reactions: [...groups.values()] } };
  });
  const last = chosen.at(-1); return { items, nextCursor: ranked.length > 20 && last ? Buffer.from(JSON.stringify({ time: last.time, id: last.id, boundary, type, tag, owner })).toString("base64url") : null };
}
