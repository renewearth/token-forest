export const dynamic = "force-dynamic";

import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { getMixedKnowhowFeed } from "@/lib/experiments-feed";
import { enabledFor } from "@/lib/experiments";
import ExperimentCard from "./experiments/ExperimentCard";
import PostEditor from "./PostEditor";
import PostActions from "./PostActions";
import PostBody from "./PostBody";
import ReactionBar from "./ReactionBar";
import ShareButton from "./ShareButton";

export default async function KnowhowPage({ searchParams }: { searchParams: Promise<{ type?: string; tag?: string; owner?: string; cursor?: string }> }) {
  const filters = await searchParams;
  const viewer = await getViewer();
  const memberId = viewer.status === "member" ? viewer.member.id : null;
  const feed = await getMixedKnowhowFeed(memberId, filters);
  const experimentsEnabled = !!memberId && enabledFor(memberId);
  const authorOptions = new Map(feed.items.map((item) => item.kind === "general" ? [item.authorId, `${item.post.authorName} (${item.authorId.slice(-6)})`] : [item.experiment.ownerId, `실험 작성자 (${item.experiment.ownerId.slice(-6)})`]));
  if (memberId) authorOptions.set(memberId, "나");
  if (filters.owner && /^[a-f\d]{24}$/i.test(filters.owner) && !authorOptions.has(filters.owner)) authorOptions.set(filters.owner, "선택한 작성자");
  const nextParams = new URLSearchParams();
  for (const key of ["type", "tag", "owner"] as const) if (filters[key]) nextParams.set(key, filters[key]!);
  if (feed.nextCursor) nextParams.set("cursor", feed.nextCursor);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">노하우 공유</h1>
      <p className="text-sm">일반 글과 업무 실험은 선택적으로 공유합니다. 작성 여부는 이용·평가에 영향을 주지 않습니다.</p>
      <form method="get" className="flex min-w-0 flex-wrap gap-2">
        <label>유형<select name="type" defaultValue={filters.type ?? "all"} className="ml-2 rounded border bg-transparent p-2"><option value="all">전체</option><option value="general">일반 글</option>{experimentsEnabled && <option value="experiments">업무 실험</option>}</select></label>
        <label className="min-w-0">업무 태그<input name="tag" defaultValue={filters.tag ?? ""} className="ml-2 w-32 rounded border bg-transparent p-2" /></label>
        <label className="min-w-0">작성자<select name="owner" defaultValue={filters.owner ?? ""} className="ml-2 rounded border bg-transparent p-2"><option value="">모두</option>{[...authorOptions].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <button className="rounded border px-3 py-2">필터 적용</button>
      </form>
      {experimentsEnabled && <Link href="/knowhow/experiments/new" className="self-start rounded border px-3 py-2 text-sm">업무 실험 기록 (선택)</Link>}
      {memberId && <Link href="/me#my-experiments" className="text-sm underline">내 비공개 기록과 후기</Link>}

      {memberId ? (
        <PostEditor mode="create" />
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">글 작성·리액션은 로그인(내 사용량에서 등록) 후 가능합니다.</p>
      )}

      {feed.items.length === 0 && (
        <p className="text-sm text-[var(--text-secondary)]">
          표시할 노하우가 없습니다. 기록 작성은 선택입니다.
        </p>
      )}

      {feed.items.map((item) => {
        if (item.kind === "experiment") return <ExperimentCard key={item.experiment._id} experiment={item.experiment} />;
        const p = item.post;
        return (
        <article id={p.id} key={p.id} className="scroll-mt-20 flex flex-col gap-2 rounded-xl border border-black/10 p-4 dark:border-white/10">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-semibold">
              {p.title}{" "}
              <span className="align-middle text-[10px] uppercase text-[var(--text-muted)]">
                {p.source === "ingest" ? "공유" : "직접"}
              </span>
            </h2>
            <span className="whitespace-nowrap text-xs text-[var(--text-muted)]">
              {p.authorName} · {p.activityAt.slice(0, 10)}
            </span>
          </div>
          {p.isOwner && (
            <PostActions postId={p.id} initial={{ title: p.title, bodyMarkdown: p.bodyMarkdown, link: p.link, tags: p.tags }} />
          )}
          {p.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {p.tags.map((t) => (
                <span key={t} className="rounded-full bg-[var(--accent)]/12 px-2 py-0.5 text-xs text-[var(--accent-strong)]">{t}</span>
              ))}
            </div>
          )}
          <PostBody markdown={p.bodyMarkdown} anchorId={p.id} />
          <div className="flex flex-wrap items-center gap-3 border-t border-black/5 pt-2 dark:border-white/5">
            {memberId && <ReactionBar postId={p.id} reactions={p.reactions} />}
            {p.link && (
              <Link href={p.link} target="_blank" className="text-xs text-[var(--accent)] underline">
                링크 열기 ↗
              </Link>
            )}
            <ShareButton postId={p.id} />
          </div>
        </article>
      ); })}
      {feed.nextCursor && <Link href={`/knowhow?${nextParams}`} className="self-start rounded border px-3 py-2">다음 20건</Link>}
    </main>
  );
}
