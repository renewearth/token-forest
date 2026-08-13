export const dynamic = "force-dynamic";

import {
  getDailyTokensByTool,
  getPeriodTotals,
  getSyncFreshness,
} from "@/lib/queries";
import {
  formatTimestamp,
  parseDays,
  rangeForDays,
  toolLabel,
} from "@/app/_lib/ui";
import { StackedTokensChart } from "@/app/_components/charts";
import {
  Card,
  EmptyState,
  PageHeader,
  RangeTabs,
  StatTile,
} from "@/app/_components/ui";
import LimitsOverview from "@/app/_components/LimitsOverview";
import { SyncNowButton } from "@/app/_components/SyncNowButton";
import { getNumStyle } from "@/app/_lib/numfmt";
import ForestScene from "@/app/_components/ForestScene";
import SymbolLegend from "@/app/_components/SymbolLegend";
import MaturityBanner from "@/app/_components/analytics/MaturityBanner";
import { getTeamMaturity } from "@/lib/team-maturity";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const days = parseDays((await searchParams).days);
  const range = rangeForDays(days);
  const numStyle = await getNumStyle();

  const [totals, tokensByTool, freshness, maturity] = await Promise.all([
    getPeriodTotals(range),
    getDailyTokensByTool(range),
    getSyncFreshness(),
    getTeamMaturity(range),
  ]);

  return (
    <div>
      <PageHeader title="대시보드">
        <RangeTabs days={days} base="/" />
      </PageHeader>
      <p className="-mt-4 mb-6 text-xs text-[var(--text-muted)]">
        {range.from} ~ {range.to} · KST 기준
      </p>

      {/* 가장 첫 시각요소 = 팀 숲 (스펙: 통합 숲 장면) */}
      <div className="mb-6">
        <ForestScene />
      </div>

      <div className="mb-6">
        <SymbolLegend />
      </div>

      <div className="mb-6">
        <MaturityBanner result={maturity} href="/team" />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="총 토큰"
          value={totals.totalTokens}
          sub="입력+출력 · 단순합산"
          numStyle={numStyle}
        />
        <StatTile
          label="총 요청"
          value={totals.totalRequests}
          sub="requests 합계"
          numStyle={numStyle}
        />
        <StatTile label="활성 구성원" value={totals.activeMembers} sub="기간 내 사용" />
        <StatTile label="사용 도구" value={totals.toolCount} sub="tool 종류" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="일별 토큰 추이 (도구별 누적)"
          hint="input+output"
          className="lg:col-span-3"
        >
          {tokensByTool.data.length ? (
            <StackedTokensChart data={tokensByTool.data} tools={tokensByTool.tools} />
          ) : (
            <EmptyState message="이 기간에 기록된 토큰 사용량이 없습니다." />
          )}
        </Card>

        {/* Bottom status strip: Claude limits (left 2/3, grows with members) +
            data freshness (right 1/3, fixed-size). Freshness is pinned to
            column 3 so it stays right even when LimitsOverview renders null. */}
        <LimitsOverview className="lg:col-span-2" />

        <Card
          title="데이터 신선도"
          hint="sync_runs 최신 상태 · KST"
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
                          f.status === "ok" ? "var(--series-4)" : "var(--series-6)",
                      }}
                    />
                    {toolLabel(f.tool)}
                  </span>
                  <span className="text-right text-xs text-[var(--text-muted)]">
                    {f.lastSyncedDate ? `~${f.lastSyncedDate} 까지 · ` : ""}
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
            Claude Code 사용량은 KST 기준으로 정확히 집계되고, 그 외 도구(Cursor·Copilot)는
            소스의 리포트일(UTC)을 따라 자정 부근 하루가 어긋날 수 있습니다. 새로 설치한 기기의 Claude
            Code 과거 이력은 최대 약 30일까지만 소급됩니다.
          </p>
        </Card>
      </div>
    </div>
  );
}
