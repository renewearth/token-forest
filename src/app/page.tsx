export const dynamic = "force-dynamic";

import { UsageLink } from "@/app/_components/UsageLink";
import {
  getUsageObservationSnapshot,
  getSyncFreshness,
} from "@/lib/queries";
import { loadPriceTable } from "@/lib/price-table";
import { resolveUnitSelection } from "@/lib/units";
import {
  formatTimestamp,
  parseDays,
  rangeForDays,
  toolLabel,
} from "@/app/_lib/ui";
import { UsageComparison } from "@/app/_components/UsageComparison";
import {
  Card,
  EmptyState,
  PageHeader,
  RangeTabs,
  StatTile,
} from "@/app/_components/ui";
import { UsageAnalysis } from "@/app/_components/UsageAnalysis";
import LimitsOverview from "@/app/_components/LimitsOverview";
import { SyncNowButton } from "@/app/_components/SyncNowButton";
import { getNumStyle } from "@/app/_lib/numfmt";
import ForestScene from "@/app/_components/ForestScene";
import SymbolLegend from "@/app/_components/SymbolLegend";
import UsageCharacteristics from "@/app/_components/UsageCharacteristics";
import RecentExperiments from "@/app/_components/RecentExperiments";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; unit?: string; ref?: string; basis?: string }>;
}) {
  const params = await searchParams;
  const days = parseDays(params.days);
  const range = rangeForDays(days);
  const numStyle = await getNumStyle();
  // One basis and display unit for all usage totals and trends.
  const sel = resolveUnitSelection(await loadPriceTable(), params);

  const [snapshot, freshness] = await Promise.all([
    getUsageObservationSnapshot(range, sel), getSyncFreshness(),
  ]);
  const { totals, tools: tokensByTool, people: tokensByMember } = snapshot;
  const unitKeep = { unit: sel.unit, ref: sel.ref ?? undefined, basis: sel.basis };

  return (
    <div>
      <PageHeader title="대시보드">
        <UsageLink href="/collection" className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--accent-strong)]">도구별 수집 상태</UsageLink>
      </PageHeader>
      <p className="-mt-4 mb-6 text-xs text-[var(--text-muted)]">
        {range.from} ~ {range.to} · KST 기준
      </p>

      <div className="mb-6"><ForestScene /></div>
      <div className="mb-6"><SymbolLegend /></div>

      <UsageAnalysis periodControl={<RangeTabs days={days} base="/" keep={unitKeep} />} selection={sel} total={totals.totalTokens} unpricedTokens={tokensByTool.unpricedTokens} numStyle={numStyle} observation={totals.observation} range={range}>
        <UsageComparison people={tokensByMember} tools={tokensByTool} unit={sel.unit} basis={sel.basis} />
      </UsageAnalysis>

      <div aria-label="활동 요약" className="my-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="총 요청"
          value={totals.observedRequests ?? "—"}
          sub="수집된 요청 합계 · 소스별 정의 다름"
          numStyle={numStyle}
        />
        <StatTile label="기록 확인 구성원" value={tokensByMember.members.filter(m => m.key !== "other" && m.observation.hasRecord).length} sub="수집된 기록 기준" />
        <StatTile label="사용 도구" value={totals.toolCount} sub="tool 종류" />
      </div>

      <div className="my-6"><RecentExperiments /></div>
      <div className="my-6"><UsageCharacteristics range={range} /></div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Bottom status strip: Claude limits (left 2/3, grows with members) +
            data freshness (right 1/3, fixed-size). Freshness is pinned to
            column 3 so it stays right even when LimitsOverview renders null. */}
        <LimitsOverview className="lg:col-span-2" />

        <Card
          title="데이터 신선도"
          hint="최근 조회와 수신한 사용일 · KST"
          className="lg:col-span-1 lg:col-start-3"
        >
          <div className="mb-2 flex justify-end">
            <SyncNowButton />
          </div>
          {freshness.length ? (
            <ul className="space-y-2 text-sm">
              {freshness.map((f) => (
                <li
                  key={f.tool}
                  className="flex items-center justify-between gap-2 border-t border-black/5 py-2 first:border-0 dark:border-white/5"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{
                        background:
                          f.status === "error" ? "var(--series-6)" : f.status === "ok" ? "var(--series-4)" : "var(--text-muted)",
                      }}
                    />
                    {toolLabel(f.tool)}
                  </span>
                  <span className="text-right text-xs text-[var(--text-muted)]">
                    {f.status === "partial" ? "일부 기간 미수신 · " : f.status === "empty" ? "자료 미수신 · " : f.status === "error" ? "조회 실패 · " : "조회 완료 · "}
                    {f.lastSyncedDate ? `최근 사용일 ${f.lastSyncedDate} · ` : ""}
                    {formatTimestamp(f.ranAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState message="자동 동기화 기록이 없습니다. 수동 입력만 사용 중일 수 있습니다." />
          )}
          <p className="mt-3 text-[11px] text-[var(--text-muted)]">
            서버가 매 정시에 자동 동기화하며, 버튼은 Cursor·Copilot만 즉시
            갱신합니다. Claude Code 사용량·한도는 각 구성원 기기에서 매 정시 자동
            업로드됩니다.
            소스별 날짜 기준이 다를 수 있습니다. Claude Code 업로더는 KST, Cursor·Copilot은
            소스의 리포트일(UTC)을 따라 자정 부근 하루가 어긋날 수 있습니다. 새로 설치한 기기의 Claude
            Code 과거 이력은 최대 약 30일까지만 소급됩니다.
          </p>
        </Card>
      </div>
    </div>
  );
}
