export const dynamic = "force-dynamic";
export const revalidate = 0;
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { enabledFor, audienceLabel } from "@/lib/experiments";
import { getExperiment, getOwnReview } from "@/lib/experiments-service";
import ExperimentEditor from "../ExperimentEditor";
import ExperimentContent, { ReviewContent } from "../ExperimentContent";
import ReviewEditor from "../ReviewEditor";
export default async function ExperimentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer(); if (viewer.status !== "member") return <main className="mx-auto max-w-2xl p-6"><p>로그인 후 이용할 수 있습니다.</p><Link href="/me" className="underline">로그인</Link></main>;
  const { id } = await params; const member = viewer.member.id;
  const [experiment, ownReview] = await Promise.all([getExperiment(member, id), getOwnReview(member, id)]);
  if (!experiment && !ownReview) return <main className="mx-auto max-w-2xl p-6"><p>기록을 찾을 수 없습니다.</p><Link href="/knowhow">노하우로 돌아가기</Link></main>;
  const enabled = enabledFor(member);
  return <main className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-5 p-4 sm:p-6"><Link href="/knowhow?type=experiments" className="text-sm underline">업무 실험 목록</Link>
    {experiment ? <><h1 className="text-xl font-semibold">업무 실험</h1>{experiment.isOwner ? <ExperimentEditor initial={experiment} enabled={enabled} /> : <><p className="text-xs">내용 버전 {experiment.contentVersion} · 최초 공유 {experiment.firstPublishedAt?.slice(0, 10)} · 수정 {experiment.updatedAt.slice(0, 10)}</p><p className="text-xs">공유 대상: {audienceLabel(experiment.audience)}</p><ExperimentContent input={experiment.input} /></>}
    <section className="space-y-3"><h2 className="font-semibold">공유된 적용 후기</h2>{experiment.reviews.filter((r) => r.status === "published" && r.approvedCycle === experiment.publicationCycle).length === 0 && <p className="text-sm">볼 수 있는 공유 후기가 없습니다.</p>}{experiment.reviews.filter((r) => r.status === "published" && r.approvedCycle === experiment.publicationCycle).map((r) => <article key={r.ownerId} className="rounded border border-black/10 p-3 dark:border-white/10"><p className="text-xs">작성자 {r.ownerId.slice(-6)} · 수정 {r.updatedAt.slice(0, 10)}</p><ReviewContent input={r.input} currentVersion={experiment.contentVersion} /></article>)}</section></> : <p>원문을 볼 수 없습니다. 본인이 작성한 후기만 확인할 수 있습니다.</p>}
    {!experiment?.isOwner && (ownReview || (experiment?.status === "published" && enabled)) && <ReviewEditor experimentId={id} currentVersion={experiment?.contentVersion} currentCycle={experiment?.publicationCycle} initial={ownReview} enabled={enabled && !!experiment} />}
  </main>;
}
