import {
  getMemberUsageObservationSnapshot,
  getMemberTools,
} from "@/lib/queries";
import { loadPriceTable } from "@/lib/price-table";
import { resolveUnitSelection, unitLabel, type SelectionParams } from "@/lib/units";
import { rangeForDays, toolLabel, type NumStyle } from "@/app/_lib/ui";
import { formatUsage } from "@/app/_lib/usage-format";
import { TrendArea } from "@/app/_components/charts";
import { Card, EmptyState, StatTile, ToolChip, UnpricedNote, RangeTabs } from "@/app/_components/ui";
import { UsageAnalysis } from "@/app/_components/UsageAnalysis";

// One member's usage data view: stat tiles, tool chips, daily trends, and the
// per-tool/model breakdown. Shared by the member detail page (viewing others)
// and /me (viewing yourself) so both render the same picture of the same
// queries. Private extras (limits, efficiency coaching) stay in the callers.
export async function MemberUsagePanel({
  memberId,
  days,
  numStyle,
  unitParams = {},
  base,
}: {
  memberId: string;
  base?: string;
  days: number;
  numStyle: NumStyle;
  // Share one selection across cards, trends, and detailed totals.
  unitParams?: SelectionParams;
}) {
  const range = rangeForDays(days);
  const sel = resolveUnitSelection(await loadPriceTable(), unitParams);
  const [usage, tools] = await Promise.all([
    getMemberUsageObservationSnapshot(memberId, range, sel),
    getMemberTools(memberId),
  ]);
  const { breakdown, trend } = usage;
  const observation = usage.observation;
  const totalTokens = observation.value;
  const requestValues = breakdown.flatMap((r) => r.fields?.requests == null ? [] : [r.fields.requests]);
  const totalRequests = requestValues.length ? requestValues.reduce((s, n) => s + n, 0) : null;
  const hasUsage = breakdown.length > 0;
  const unpricedTokens = breakdown.reduce((sum, row) => sum + (row.unpricedTokens ?? 0), 0);
  const hasRequests = trend.some((t) => t.observedRequests != null);
  const chartTrend = trend.map((t) => ({ date: t.date, tokens: t.observedTokens ?? null, requests: t.observedRequests ?? null }));

  return (
    <div>
      <UsageAnalysis periodControl={<RangeTabs days={days} base={base ?? `/members/${memberId}`} keep={{ unit: sel.unit, ref: sel.ref ?? undefined, basis: sel.basis }} />} selection={sel} total={totalTokens} unpricedTokens={unpricedTokens} numStyle={numStyle} hasDetails observation={observation} range={range}>
        <h3 className="mb-3 text-sm font-medium text-[var(--text-secondary)]">일별 사용량 추이</h3>
        {hasUsage ? (
          <TrendArea
            data={chartTrend} dataKey={sel.basis === "requests" ? "requests" : "tokens"}
            unit={sel.basis === "requests" ? "건" : sel.unit === "ref" ? "환산 토큰" : "토큰"}
            valueFormat={sel.unit === "usd" ? "usd" : "count"}
          />
        ) : (
          <EmptyState message="수집된 기록이 아직 없습니다. 본인의 연결 설정을 확인해 주세요." />
        )}

        <div className="mt-6 border-t border-[var(--border)] pt-4">
          <h3 className="mb-1 text-sm font-medium text-[var(--text-secondary)]">도구·모델별 상세</h3>
          <p className="mb-4 text-xs text-[var(--text-muted)]">입력·캐시 읽기·캐시 쓰기·출력은 원래 토큰 수이며 합계만 선택 기준으로 표시합니다.</p>
        {breakdown.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">도구</th>
                  <th className="pb-2 font-medium">모델</th>
                  <th className="pb-2 text-right font-medium">일반 입력</th>
                  <th className="pb-2 text-right font-medium">캐시 읽기</th>
                  <th className="pb-2 text-right font-medium">캐시 쓰기</th>
                  <th className="pb-2 text-right font-medium">출력</th>
                  <th className="pb-2 text-right font-medium">합계 · {unitLabel(sel.unit, sel.ref, sel.basis)}</th>
                  <th className="pb-2 text-right font-medium">요청</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((r) => (
                  <tr
                    key={`${r.tool}:${r.model}`}
                    className="border-t border-black/5 dark:border-white/5"
                  >
                    <td className="py-2">{toolLabel(r.tool)}</td>
                    <td className="py-2 font-mono text-xs text-[var(--text-secondary)]">
                      {r.model || "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsage(r.fields ? r.fields.inputTokens : r.input, "raw")}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsage(r.fields ? r.fields.cacheReadTokens : r.cacheRead, "raw")}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsage(r.fields ? r.fields.cacheCreationTokens : r.cacheCreation, "raw")}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsage(r.fields ? r.fields.outputTokens : r.output, "raw")}</td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {formatUsage(r.observation ? r.observation.value : r.tokens, sel.unit)}
                      <UnpricedNote tokens={r.unpricedTokens ?? 0} numStyle={numStyle} />
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsage(r.fields ? r.fields.requests : r.requests, "raw")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="이 기간에 사용 상세 기록이 없습니다." />
        )}
        </div>
      </UsageAnalysis>

      <div aria-label="활동 요약" className="my-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile label="수집된 요청 합계" value={formatUsage(totalRequests, "raw")} sub="선택 기간" numStyle={numStyle} />
        <StatTile label="사용 도구" value={tools.length} sub="전체 기간" />
      </div>
      {tools.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {tools.map((t) => <ToolChip key={t} tool={t} />)}
        </div>
      )}
      <Card title="일별 요청 추이" hint="requests">
        {hasRequests ? (
          <TrendArea data={chartTrend} dataKey="requests" unit="요청" color="var(--series-2)" />
        ) : (
          <EmptyState message="이 기간에 요청 기록이 없습니다." />
        )}
      </Card>
    </div>
  );
}
