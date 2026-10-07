import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { COLLECTION_TOOLS } from "@/lib/collection-catalog";
import { getMemberCollectionHistory } from "@/lib/collection-history";
import { latestMemberUsageReports } from "@/lib/usage-reports";
import { REPORT_METRIC_LABELS, type ReportMetric } from "@/lib/usage-report-types";
import { Card, PageHeader } from "@/app/_components/ui";
import ToolCollectionOverview, { LegacyHistory } from "./ToolCollectionOverview";

export const dynamic = "force-dynamic";
export const metadata = { title: "도구별 수집 · token-forest" };
const COVERAGE = { full: "보고서 범위 전체", overage: "초과 사용분만", unknown: "포함 범위 미확인" };

export default async function CollectionPage() {
  const viewer = await getViewer();
  const [reports, collection] = viewer.status === "member" ? await Promise.all([
    latestMemberUsageReports(viewer.member), getMemberCollectionHistory(viewer.member),
  ]) : [null, null];
  return <div className="space-y-6">
    <PageHeader title="도구별 수집"><p className="text-sm text-[var(--text-secondary)]">도구별 기록이 어디까지 수신됐는지 확인합니다.</p></PageHeader>
    <ToolCollectionOverview key={viewer.status === "member" ? viewer.member.id : viewer.status} signedIn={viewer.status === "member"} history={collection?.history ?? []} />
    <Card title="현재 그래프에 포함되는 범위" hint="도구의 사용 여부와 수집 여부는 다릅니다">
      <p className="text-sm leading-6 text-[var(--text-secondary)]">대시보드는 수신된 일별·세션 기록을 보여줍니다. 웹·앱 보고서와 과금 자료는 아래에서 별도로 확인합니다. 서로 겹치는 계정·제품·기간을 대조하기 전에는 전체 토큰이나 요청 수에 더하지 않습니다.</p>
      <p className="mt-2 text-sm">토큰이 제공되지 않으면 <strong>미제공</strong>, 보고서를 받지 못했으면 <strong>미수신</strong>입니다. 사용량 0을 뜻하지 않습니다.</p>
      <Link href="/" className="mt-3 inline-block text-sm text-[var(--accent-strong)] underline">사용량 그래프 보기</Link>
    </Card>
    {(["개발 도구", "웹·앱"] as const).map(group => <section key={group} aria-label={group}>
      <h2 className="mb-3 text-lg font-semibold">{group}</h2>
      <div className="grid gap-4 md:grid-cols-2">{COLLECTION_TOOLS.filter(t => t.group === group).map(tool => <Card key={tool.id} title={tool.name} hint={tool.method}>
        <p className="text-sm font-medium">{tool.metrics}</p>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{tool.note}</p>
        {(tool.id === "cursor" || tool.id === "copilot") && collection?.history.find(row => row.tool === tool.id) && <LegacyHistory history={collection.history.find(row => row.tool === tool.id)!} />}
        {tool.id === "copilot" && <div className="mt-3 rounded-lg bg-[var(--surface-2)] p-3 text-sm" data-copilot-connection>
          <p className="font-medium">{!collection ? "로그인 후 계정 설정 확인" : !collection.copilot.identityConfigured || !collection.copilot.credentialConfigured ? "계정 연결 필요" : reports?.some(r => r.sourceId === tool.sourceId) ? "최근 보고서 수신 이력 있음" : "조회 설정 등록됨 · 최근 목록에서 보고서 미확인"}</p>
          {collection && <p className="mt-1 text-xs text-[var(--text-secondary)]">GitHub 계정 {collection.copilot.identityConfigured ? "등록됨" : "미등록"} · 조회 인증 {collection.copilot.credentialConfigured ? "등록됨" : "미등록"}</p>}
          <Link href="/me" className="mt-2 inline-block text-[var(--accent-strong)] underline">내 계정 설정 보기</Link>
          <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">OpenCode에서 사용한 Copilot 모델의 기록은 OpenCode에서 수집합니다. 이 계정 설정은 별도의 Copilot 과금 보고서용이며, 두 자료를 자동으로 더하지 않습니다.</p>
        </div>}
        <p className="mt-3 text-xs text-[var(--text-muted)]">{tool.group === "웹·앱" ? reports === null ? "연결 상태 확인 필요 · 로그인 후 받은 보고서 확인" : reports.some(r => r.sourceId === tool.sourceId) ? "내 보고서 수신 이력 있음 · 현재 연결 상태와 별도" : "내 계정 보고서 수신 미확인 · 플랜/권한 확인 필요" : tool.id === "copilot" ? "과금 보고서는 사용량 그래프와 별도" : "기기별 수신 여부는 내 사용량에서 확인"}</p>
      </Card>)}</div>
    </section>)}
    <Card title="내 계정의 보고서" hint="본인에게 연결된 최근 수신 60행 · 기간이 겹치는 행은 서로 더하지 않습니다">
      <p className="mb-4 text-sm text-[var(--text-secondary)]">기간 합계는 일별로 나누지 않습니다. 모델·지표가 다르면 단위도 각각 유지합니다. 새 자료와 이전 자료가 겹칠 수 있으므로 이 목록의 총합은 계산하지 않습니다.</p>
      {reports === null ? <p className="text-sm"><Link href="/me" className="underline">로그인</Link>하면 본인에게 연결된 보고서를 확인할 수 있습니다.</p> : reports.length === 0 ? <p className="rounded-lg bg-[var(--surface-2)] p-4 text-sm">본인에게 연결된 보고서가 없습니다. Claude CSV를 가져오거나 권한을 확인한 관리자 API를 연결하면 여기에 표시됩니다.</p> : <ul className="space-y-3">{reports.map((report, i) => <li key={`${report.sourceId}-${i}`} className="min-w-0 rounded-lg border border-[var(--border)] p-4 text-sm">
        <p className="break-words font-medium">{report.product} · {report.model || "모델 구분 없음"}</p>
        <p className="mt-1 break-words text-xs text-[var(--text-secondary)]">{report.externalId} · {report.accountId}</p>
        <p className="mt-2">{report.periodStart} ~ {report.periodEnd} · {report.timeZone} · {report.granularity === "period" ? "기간 합계" : "일별"}</p>
        <p className="text-xs text-[var(--text-muted)]">{COVERAGE[report.coverage]} · 수신 {report.collectedAt.toISOString().replace("T", " ").slice(0, 16)} UTC</p>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2">{Object.entries(report.metrics).map(([metric, value]) => <div key={metric}><dt className="text-xs text-[var(--text-secondary)]">{REPORT_METRIC_LABELS[metric as ReportMetric]}</dt><dd className="font-mono tabular-nums">{value?.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}</dd></div>)}</dl>
      </li>)}</ul>}
    </Card>
    <p className="text-xs text-[var(--text-muted)]">NotebookLM·Perplexity·Microsoft 365 Copilot·Grok 웹은 실사용과 공식 제공 항목을 확인한 뒤 추가합니다.</p>
  </div>;
}
