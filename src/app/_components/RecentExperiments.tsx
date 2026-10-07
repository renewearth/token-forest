import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { enabledFor, type ExperimentView } from "@/lib/experiments";
import { listExperiments } from "@/lib/experiments-service";
import ExperimentCard from "@/app/knowhow/experiments/ExperimentCard";

export default async function RecentExperiments({ memberId }: { memberId?: string | null } = {}) {
  const viewer = await getViewer();
  if (viewer.status !== "member" || !enabledFor(viewer.member.id)) return null;
  const owner = memberId || undefined;
  const query = new URLSearchParams({ type: "experiments" });
  if (owner) query.set("owner", owner);
  const href = `/knowhow?${query}`;
  let items: ExperimentView[] = [];
  let failed = false;
  try {
    // The profile identifies the author; the authenticated viewer still owns
    // the visibility check. Filtering happens before sorting and limiting.
    items = (await listExperiments(viewer.member.id, { limit: 3, owner })).items;
  } catch {
    failed = true;
  }
  if (failed) return <section><h2 className="font-semibold">업무 실험</h2><p>불러오지 못했습니다.</p><Link href={href} className="underline">다시 시도</Link></section>;
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">{owner ? "이 구성원이 공유한 업무 실험" : "최근 공유된 업무 실험"}</h2>
      <p className="text-sm">작성은 선택이며 업무 성과 점수로 사용하지 않습니다.</p>
      {items.length ? items.map((e) => <ExperimentCard key={e._id} experiment={e} />) : <p className="text-sm">{owner ? "현재 볼 수 있는 이 구성원의 공유 실험이 없습니다." : "볼 수 있는 공유 실험이 아직 없습니다."}</p>}
      <Link href={href} className="text-sm underline">{owner ? "이 구성원의 업무 실험 더 보기" : "업무 실험 보기"}</Link>
    </section>
  );
}
