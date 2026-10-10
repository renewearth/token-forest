import { getTeamCollectionStatus } from "@/lib/collection-status";
import { Card, EmptyState } from "./ui";
import { formatTimestamp } from "@/app/_lib/ui";
import Link from "next/link";

export default async function CollectionStatusPanel() {
  const rows = await getTeamCollectionStatus();
  return <Card title="수집 상태 확인" hint="연결된 장치의 수신 상태 · 실제 미사용 여부와 다릅니다">
    {rows.length ? <ul className="divide-y divide-black/5 dark:divide-white/5">{rows.map(r => <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
      <span>{r.name}</span><span className="text-right text-xs text-[var(--text-secondary)]">{r.label}<span className="block">{r.lastReceivedAt ? formatTimestamp(r.lastReceivedAt) : "수신 시각 미확인"}</span></span>
    </li>)}</ul> : <EmptyState message="등록된 구성원이 없습니다." />}
    <p className="mt-3 text-xs text-[var(--text-muted)]">장치 수신이 있어도 모든 소스의 기록이 수집되었다는 뜻은 아닙니다. 장치 이름과 오류 상세는 본인의 내 사용량에서 확인합니다.</p>
    <Link href="/collection" className="mt-3 inline-block text-sm text-[var(--accent-strong)] underline">도구별 수집 범위와 웹·앱 보고서 보기</Link>
  </Card>;
}
