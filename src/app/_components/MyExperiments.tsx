import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { enabledFor } from "@/lib/experiments";
import { listOwnExperiments, listOwnReviews } from "@/lib/experiments-service";
export default async function MyExperiments(_props: { memberId?: string | null } = {}) {
  void _props; const viewer = await getViewer(); if (viewer.status !== "member") return null;
  let experiments: Awaited<ReturnType<typeof listOwnExperiments>> = []; let reviews: Awaited<ReturnType<typeof listOwnReviews>> = []; let failed = false;
  try { [experiments, reviews] = await Promise.all([listOwnExperiments(viewer.member.id), listOwnReviews(viewer.member.id)]); } catch { failed = true; }
  if (failed) return <section id="my-experiments"><h2 className="font-semibold">내 업무 실험과 후기</h2><p>불러오지 못했습니다.</p><Link href="/me#my-experiments" className="underline">다시 시도</Link></section>;
    return <section id="my-experiments" className="space-y-3 rounded-xl border border-black/10 p-4 dark:border-white/10"><h2 className="font-semibold">내 업무 실험과 후기</h2><p className="text-sm">작성은 선택입니다. 비공개 기록은 본인만 볼 수 있습니다.</p>{enabledFor(viewer.member.id) && <Link href="/knowhow/experiments/new" className="inline-block rounded border px-3 py-2 text-sm">업무 실험 기록</Link>}{experiments.length === 0 && reviews.length === 0 && <p className="text-sm">저장한 기록이 없습니다.</p>}<ul className="space-y-2">{experiments.map((e) => <li key={e._id} className="break-words text-sm"><Link className="underline" href={`/knowhow/experiments/${e._id}`}>{e.input.title || "제목 없는 초안"}</Link> · {e.status === "published" ? "공유 중" : e.status === "withdrawn" ? "비공개 전환" : "비공개 초안"}</li>)}</ul>{reviews.length > 0 && <><h3 className="font-medium">내 적용 후기</h3><ul className="space-y-2">{reviews.map((r) => <li key={r.experimentId} className="break-words text-sm"><Link href={`/knowhow/experiments/${r.experimentId}`} className="underline">{r.title ?? "원문 비공개 · 내 후기 보기"}</Link> · 적용 버전 {r.review.input.appliedVersion}</li>)}</ul></>}</section>;

}
