export const dynamic = "force-dynamic";

import {
  getAdoptionMatrix,
  getUsageObservationSnapshot,
  getAllMembers,
  getCacheSavings,
  getDailyRequests,
  getHourlyHeatmap,
  getLimitHistory,
  getLimitHitCounts,
  getMemberLeaderboard,
  getMemberWowDeltas,
  getModelAdoption,
  getModelBreadthWeekly,
  getModelDistribution,
  getModelTierTrend,
  getOnboardingActivity,
  getPremiumShareWeekly,
  getScorecardWeeklySums,
  getTeamAdoptionRate,
  getToolSummary,
  getWeeklyActiveByTool,
} from "@/lib/queries";
import type { PremiumShareWeeklyRow } from "@/lib/queries";
import {
  formatNumber,
  parseDays,
  rangeForDays,
  toolLabel,
} from "@/app/_lib/ui";
import { AdoptionChart, TrendArea } from "@/app/_components/charts";
import {
  AdoptionRateChart,
  LimitHistoryChart,
  TierMixChart,
} from "@/app/_components/analytics/TeamCharts";
import {
  Card,
  EmptyState,
  PageHeader,
  RangeTabs,
  ToolChip,
} from "@/app/_components/ui";
import { Heatmap } from "@/app/_components/analytics/Heatmap";
import { ModelDonut } from "@/app/_components/analytics/ModelDonut";
import { WowTable } from "@/app/_components/analytics/WowTable";
import { getNumStyle } from "@/app/_lib/numfmt";
import TeamScorecard from "@/app/_components/analytics/TeamScorecard";
import UsageCharacteristics from "@/app/_components/UsageCharacteristics";
import CollectionStatusPanel from "@/app/_components/CollectionStatusPanel";
import {
  adoptionLeadDays,
  cacheReuseRatio,
  cacheSavingsRate,
  contextYield as contextYieldMetric,
  iqrBand,
  median,
  rampWeeks,
  sessionDepth as sessionDepthMetric,
  showBand,
  weeklyModelBreadthSeries,
  weeklyTeamSeries,
} from "@/lib/scorecard";
import type { WeeklySeriesPoint } from "@/lib/scorecard";
import { organizationLabels, windowLabel } from "@/lib/limit-window";
import { loadPriceTable } from "@/lib/price-table";
import { resolveUnitSelection, unitHint, unitLabel, unpricedNote, type SelectionParams } from "@/lib/units";
import { UsageAnalysis } from "@/app/_components/UsageAnalysis";
import { UsageComparison } from "@/app/_components/UsageComparison";
import { formatUsage } from "@/app/_lib/usage-format";

const MS_PER_DAY = 86_400_000;

// Whole days since a "YYYY-MM-DD" date — UTC on both sides, matching
// rangeForDays which also derives its dates from toISOString (UTC).
function daysSince(date: string): number {
  return Math.floor((Date.now() - Date.parse(`${date}T00:00:00Z`)) / MS_PER_DAY);
}

// Adoption-matrix cell shading: the more recent the last use, the darker.
// No lastDate = outline only. Class strings stay literal so Tailwind sees them.
function matrixCellClass(lastDate: string | undefined): string {
  if (!lastDate) return "border border-black/10 dark:border-white/10";
  const age = daysSince(lastDate);
  if (age <= 7) return "bg-[var(--series-4)]/60";
  if (age <= 30) return "bg-[var(--series-4)]/30";
  return "bg-[var(--series-4)]/10";
}

// Section heading + the question this section answers, so a first-time
// viewer knows why these cards are grouped together.
function SectionHeading({
  children,
  lead,
}: {
  children: React.ReactNode;
  lead: string;
}) {
  return (
    <div className="mt-8 mb-4">
      <h2 className="text-sm font-semibold tracking-tight text-[var(--text-secondary)]">
        {children}
      </h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{lead}</p>
    </div>
  );
}

// One-sentence reading guide under a card: what the number means and which
// state is a signal. Definitions stay in the card hint; this is
// interpretation only.
function Insight({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
      {children}
    </p>
  );
}

// 프리미엄 비중 팀 시리즈 — getPremiumShareWeekly 행(멤버×주×모델 이미 접힘)을
// weeklyTeamSeries와 같은 모양(풀드+중앙값+IQR)으로 조립한다. weeklyTeamSeries는
// ScoreSums 위에서 동작하는데 이 지표는 premium/total 토큰 두 값뿐이라 재사용하지
// 않고 여기서 직접 리듀스한다 (스펙: 풀드=자원 관점, 중앙값=사람 관점, 8명 미만 IQR 숨김).
function premiumShareSeries(rows: PremiumShareWeeklyRow[]): WeeklySeriesPoint[] {
  const byWeek = new Map<string, Map<string, { premium: number; total: number }>>();
  for (const r of rows) {
    const wk = byWeek.get(r.week) ?? new Map<string, { premium: number; total: number }>();
    const cur = wk.get(r.memberId) ?? { premium: 0, total: 0 };
    cur.premium += r.premiumTokens;
    cur.total += r.totalTokens;
    wk.set(r.memberId, cur);
    byWeek.set(r.week, wk);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, members]) => {
      let pooledPremium = 0;
      let pooledTotal = 0;
      const shares: number[] = [];
      for (const m of members.values()) {
        pooledPremium += m.premium;
        pooledTotal += m.total;
        if (m.total > 0) shares.push(m.premium / m.total);
      }
      const point: WeeklySeriesPoint = {
        week,
        pooled: pooledTotal > 0 ? pooledPremium / pooledTotal : null,
        median: median(shares),
      };
      if (showBand(members.size)) {
        const band = iqrBand(shares);
        if (band) {
          point.p25 = band.p25;
          point.p75 = band.p75;
        }
      }
      return point;
    });
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<SelectionParams & { days?: string }>;
}) {
  const params = await searchParams;
  const days = parseDays(params.days);
  const range = rangeForDays(days);
  const sel = resolveUnitSelection(await loadPriceTable(), params);
  const keep = { unit: sel.unit, ref: sel.ref ?? undefined, basis: sel.basis };
  const label = unitLabel(sel.unit, sel.ref, sel.basis);

  const [
    adoptionRate,
    matrix,
    weeklyActive,
    scoreWeekly,
    premiumShareWeekly,
    savings,
    adoption,
    onboarding,
    tierMix,
    heatmap,
    modelDist,
    wow,
    requests,
    toolSummary,
    limitHistory,
    limitHits,
    seatLeaderboard, // seat utilization is fixed to 30 days regardless of tabs
    allMembers,
    numStyle,
    modelBreadthWeekly,
    usageSnapshot,
  ] = await Promise.all([
    getTeamAdoptionRate(range),
    getAdoptionMatrix(),
    getWeeklyActiveByTool(range),
    getScorecardWeeklySums(range),
    getPremiumShareWeekly(range),
    getCacheSavings(range),
    getModelAdoption(120),
    getOnboardingActivity(),
    getModelTierTrend(range, sel),
    getHourlyHeatmap(range, undefined, sel),
    getModelDistribution(range, undefined, sel),
    getMemberWowDeltas(sel),
    getDailyRequests(range),
    getToolSummary(range, sel),
    getLimitHistory(range),
    getLimitHitCounts(range),
    getMemberLeaderboard(rangeForDays(30), sel),
    getAllMembers(),
    getNumStyle(),
    getModelBreadthWeekly(range),
    getUsageObservationSnapshot(range, sel),
  ]);

  // Plan-limit organization labels per member: Codex "device:…" orgs show as
  // "기기 N" (numbered within that member), never the raw device id.
  const limitOrgLabels = new Map<string, Map<string, string>>();
  for (const name of new Set([...limitHistory, ...limitHits].map((r) => r.memberName))) {
    const orgs = [...limitHistory, ...limitHits]
      .filter((r) => r.memberName === name)
      .map((r) => r.organization);
    limitOrgLabels.set(name, organizationLabels(orgs));
  }
  const limitOrg = (memberName: string, org: string) =>
    limitOrgLabels.get(memberName)?.get(org) ?? org;

  // ---- 팀 스코어카드 조립 (순수 계산은 scorecard.ts, 여긴 원재료 배선만) ----
  const claudeOnlyWeekly = scoreWeekly.filter((r) => r.tool === "claude_code");
  const cacheReuseSeries = weeklyTeamSeries(scoreWeekly, cacheReuseRatio);
  const modelBreadthSeries = weeklyModelBreadthSeries(modelBreadthWeekly);
  const contextYieldSeries = weeklyTeamSeries(scoreWeekly, contextYieldMetric);
  const sessionDepthSeries = weeklyTeamSeries(claudeOnlyWeekly, sessionDepthMetric);
  const premiumShareSeriesData = premiumShareSeries(premiumShareWeekly);
  const cacheSavingsPct = cacheSavingsRate(savings.saved, savings.spent);
  const teamSize = allMembers.length;
  const modelAdoption = adoption.map((a) => ({
    model: a.model,
    globalFirst: a.globalFirst,
    leadDays: adoptionLeadDays(a.memberFirstDates, teamSize),
  }));
  const rampAvg =
    onboarding.length === 0
      ? null
      : onboarding
          .map((m) => rampWeeks(m.activeDates, m.onboardedAt, 4))
          .reduce((acc, weeks) => acc.map((v, i) => v + weeks[i]), [0, 0, 0, 0])
          .map((sum) => sum / onboarding.length);

  const heatmapHasData = heatmap.some((row) => row.some((v) => v !== null && v > 0));

  const unpricedTokens = toolSummary.reduce((sum, t) => sum + (t.unpricedTokens ?? 0), 0);
  const requestsOnlyTools = toolSummary
    .filter((t) => (t.observation?.value === null && t.requests > 0))
    .map((t) => t.tool);
  const hasRequestsData = requests.some((r) => r.observedRequests !== null);

  // Seat utilization: full roster × 30-day leaderboard. Members absent from
  // the leaderboard had no usage — they sink to the bottom with zeros.
  const seatById = new Map(seatLeaderboard.map((r) => [r.memberId, r]));
  const seatRows = allMembers
    .map((m) => {
      const row = seatById.get(m.id);
      return {
        id: m.id,
        name: m.name,
        tokens: row?.tokens ?? 0,
        hasRecord: row?.hasRecord ?? false,
        observation: row?.observation,
        unpricedTokens: row?.unpricedTokens ?? 0,
        share: row?.weightedShare ?? 0,
      };
    })
    .sort(
      (a, b) => a.id.localeCompare(b.id),
    );

  return (
    <div>
      <PageHeader title="팀 분석" />
      <p className="-mt-4 mb-6 text-xs text-[var(--text-muted)]">
        {range.from} ~ {range.to}
      </p>
      <UsageAnalysis periodControl={<RangeTabs days={days} base="/team" keep={keep} />} selection={sel} total={usageSnapshot.totals.totalTokens} unpricedTokens={usageSnapshot.tools.unpricedTokens} numStyle={numStyle} observation={usageSnapshot.totals.observation} range={range}>
        <UsageComparison people={usageSnapshot.people} tools={usageSnapshot.tools} unit={sel.unit} basis={sel.basis} />
      </UsageAnalysis>
      {unpricedTokens > 0 && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{unpricedNote(formatNumber(unpricedTokens))}</p>
      )}

      <SectionHeading lead="수집된 사용 기록이 어떤 소스와 구성원에 연결되어 있는가">수집된 사용 기록</SectionHeading>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="사용 기록이 확인된 구성원 비율" hint="주별 기록 확인 인원 ÷ 등록 인원 · 실제 도입률 아님">
          {adoptionRate.length ? (
            <AdoptionRateChart data={adoptionRate} />
          ) : (
            <EmptyState message="매핑된 구성원 사용 기록이 없습니다." />
          )}
          <Insight>등록 구성원 가운데 사용 기록이 수집된 비율입니다. 미수집 도구·기기·계정의 사용 여부는 알 수 없습니다.</Insight>
        </Card>

        <Card title="구성원별 수집 기록" hint="구성원 × 도구 · 마지막 사용">
          {matrix.rows.length ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--text-muted)]">
                    <th className="pb-2 font-medium">구성원</th>
                    {matrix.tools.map((tool) => (
                      <th key={tool} className="pb-2 text-center font-medium">
                        {toolLabel(tool)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => {
                    const byTool = new Map(row.cells.map((c) => [c.tool, c.lastDate]));
                    return (
                      <tr
                        key={row.memberId}
                        className="border-t border-black/5 dark:border-white/5"
                      >
                        <td className="py-2">{row.name}</td>
                        {matrix.tools.map((tool) => {
                          const lastDate = byTool.get(tool);
                          return (
                            <td key={tool} className="py-2 text-center">
                              <span
                                title={lastDate ?? "기록 없음"}
                                className={`inline-block h-4 w-8 rounded ${matrixCellClass(lastDate)}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-muted)]">
                진함=최근:
                <span className="inline-block h-3 w-6 rounded bg-[var(--series-4)]/60" />
                ≤7일
                <span className="inline-block h-3 w-6 rounded bg-[var(--series-4)]/30" />
                ≤30일
                <span className="inline-block h-3 w-6 rounded bg-[var(--series-4)]/10" />
                &gt;30일
                <span className="inline-block h-3 w-6 rounded border border-black/10 dark:border-white/10" />
                기록 없음
              </p>
            </>
          ) : (
            <EmptyState message="등록된 구성원이 없습니다." />
          )}
          <Insight>빈 칸은 수집된 기록을 확인할 수 없다는 뜻입니다. 실제 미사용이나 지원이 필요한 사람으로 단정하지 않습니다.</Insight>
        </Card>

        <CollectionStatusPanel />

        <Card title="주간 기록 확인 인원 (도구별)" hint="주별 고유 구성원">
          {weeklyActive.data.length ? (
            <AdoptionChart data={weeklyActive.data} tools={weeklyActive.tools} />
          ) : (
            <EmptyState message="매핑된 구성원 사용 기록이 없습니다." />
          )}
          <Insight>도구별로 기록이 수집된 인원입니다. 수집 지원 범위가 다른 도구 사이의 도입 수준을 평가하지 않습니다.</Insight>
        </Card>
      </div>

      <SectionHeading lead="팀의 사용 습관이 어떤 모습이고, 어떻게 변하고 있는가">사용 패턴</SectionHeading>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="사용 특성 상세" hint="고정 기준 · 주별 · 풀드/중앙값 병기 · 순위 없음" className="lg:col-span-2">
          <div className="mb-6">
            <UsageCharacteristics range={range} />
          </div>
          {scoreWeekly.length ? (
            <TeamScorecard
              cacheReuse={cacheReuseSeries}
              contextYield={contextYieldSeries}
              sessionDepth={sessionDepthSeries}
              cacheSavingsPct={cacheSavingsPct}
              premiumShare={premiumShareSeriesData}
              modelBreadth={modelBreadthSeries}
              modelAdoption={modelAdoption}
              rampAvg={rampAvg}
              cohortSize={onboarding.length}
            />
          ) : (
            <EmptyState message="이 기간에 팀 사용 기록이 없습니다." />
          )}
          <Insight>각 항목은 수집된 사용 특성입니다. 합산과 중앙값을 함께 보되 사람의 역량이나 조직의 성숙도 단계로 환산하지 않습니다.</Insight>
          <Insight>사용 특성의 계산식은 선택한 집계 기준과 무관합니다. 모델 폭과 프리미엄 비중은 입력+출력, 캐시 절감은 수집된 캐시 항목의 공개 단가 기준을 유지합니다.</Insight>
        </Card>

        <Card title="모델 티어 믹스" hint={`주별 ${label} 비중 % · ${unitHint(sel.unit, sel.basis)}`} className="lg:col-span-2">
          {tierMix.weeks.length ? (
            <TierMixChart weeks={tierMix.weeks} families={tierMix.families} />
          ) : (
            <EmptyState message="이 기간에 기록된 사용량이 없습니다." />
          )}
          <Insight>선택한 기준의 사용량이 어떤 모델군에 쓰이는지의 구성비입니다. 새 모델 출시 후 비중 변화를 비교할 수 있습니다.</Insight>
        </Card>

        <Card
          title="시간대 히트맵"
          hint={`요일 × 시간 · ${label}`}
          className="lg:col-span-2"
        >
          {heatmapHasData ? (
            <Heatmap matrix={heatmap} unit={sel.unit} basis={sel.basis} />
          ) : (
            <EmptyState message="이 기간에 시간별(hourly) 사용 기록이 없습니다." />
          )}
          <Insight>수집된 소스의 시간 버킷별 사용량입니다. 사람의 실제 집중 시간이나 근무 시간을 나타내지 않습니다.</Insight>
        </Card>

        <Card title="모델 분포" hint={`모델별 ${label} 점유율`}>
          {modelDist.length ? (
            <ModelDonut rows={modelDist} unit={sel.unit} basis={sel.basis} />
          ) : (
            <EmptyState message="이 기간에 기록된 사용량이 없습니다." />
          )}
          <Insight>기간 전체의 모델별 점유율 스냅샷 — 티어 믹스의 “지금” 단면입니다.</Insight>
        </Card>

        <Card title="주간 증감" hint={`최근 7일 vs 이전 7일 · ${label}`}>
          {wow.length ? (
            <WowTable rows={wow} unit={sel.unit} />
          ) : (
            <EmptyState message="최근 2주간 구성원 사용 기록이 없습니다." />
          )}
          <Insight>각 기간의 수집된 절대값을 보여줍니다. 변화의 이유는 업무 맥락과 수집 상태를 함께 확인해야 하며 이탈·휴가·성과를 추정하지 않습니다.</Insight>
        </Card>

        <Card title="일별 요청 추이" hint="requests" className="lg:col-span-2">
          {hasRequestsData ? (
            <TrendArea data={requests} dataKey="observedRequests" unit="건" />
          ) : (
            <EmptyState message="이 기간에 기록된 요청이 없습니다." />
          )}
          <Insight>토큰을 보고하지 않는 도구(Copilot)까지 포함한 전체 활동량 추세입니다.</Insight>
        </Card>

        {sel.basis !== "requests" && requestsOnlyTools.length > 0 && (
          <div className="rounded-lg border border-[var(--series-3)]/40 bg-[var(--series-3)]/5 px-4 py-3 text-xs text-[var(--text-secondary)] lg:col-span-2">
            <strong className="font-semibold text-[var(--text-primary)]">
              토큰 vs 활동량 안내:
            </strong>{" "}
            {requestsOnlyTools.map((t) => toolLabel(t)).join(", ")}에서 선택한 토큰 항목을 확인할 수 없고 요청 기록만 관측되었습니다. 수집 지원 범위를 확인하고
            도입률·활동량은 위 요청 추이와 주간 활성 사용자로 함께 확인하세요.
          </div>
        )}

        <Card title="도구별 요약" className="lg:col-span-2">
          {toolSummary.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">도구</th>
                  <th className="pb-2 text-right font-medium">{label}</th>
                  <th className="pb-2 text-right font-medium">요청</th>
                  <th className="pb-2 text-right font-medium">활성</th>
                </tr>
              </thead>
              <tbody>
                {toolSummary.map((t) => (
                  <tr key={t.tool} className="border-t border-black/5 dark:border-white/5">
                    <td className="py-2">
                      <ToolChip tool={t.tool} />
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsage(t.observation ? t.observation.value : null, sel.unit)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {t.requests ? formatNumber(t.requests) : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">{t.activeMembers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="데이터가 없습니다." />
          )}
          <Insight>기간 내 도구별 총량·활성 인원의 한 표 요약입니다.</Insight>
        </Card>
      </div>

      <SectionHeading lead="지금 플랜(좌석·한도)이 팀 사용량에 맞는가">용량 계획</SectionHeading>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {limitHistory.length ? (
          limitHistory.map((h) => (
            <Card
              key={`${h.memberName}|${h.accountEmail}|${h.organization}`}
              title={`${h.memberName} · ${h.accountEmail}`}
              hint={limitOrg(h.memberName, h.organization)}
            >
              <LimitHistoryChart days={h.days} />
            </Card>
          ))
        ) : (
          <Card title="한도 소진 히스토리" className="lg:col-span-2">
            <EmptyState message="이 기간의 플랜 한도 스냅샷이 없습니다." />
          </Card>
        )}

        {limitHistory.length > 0 && (
          <p className="-mt-1 text-[11px] leading-relaxed text-[var(--text-muted)] lg:col-span-2">
            위 카드는 계정·플랜별 하루 최고 소진율의 추이입니다. 90% 점선에 자주 닿는
            계정은 플랜이 사용량을 조이고 있다는 뜻 — 상위 플랜 검토 근거입니다.
          </p>
        )}

        <Card title="한도 도달" hint="일별 피크 기준" className="lg:col-span-2">
          {limitHits.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">구성원</th>
                  <th className="pb-2 font-medium">계정</th>
                  <th className="pb-2 font-medium">조직</th>
                  <th className="pb-2 font-medium">창</th>
                  <th className="pb-2 text-right font-medium">90%+ 일수</th>
                  <th className="pb-2 text-right font-medium">100% 일수</th>
                </tr>
              </thead>
              <tbody>
                {limitHits.map((r) => (
                  <tr
                    key={`${r.accountEmail}|${r.organization}|${r.window}`}
                    className="border-t border-black/5 dark:border-white/5"
                  >
                    <td className="py-2">{r.memberName}</td>
                    <td className="py-2 text-[var(--text-secondary)]">
                      {r.accountEmail}
                    </td>
                    <td className="py-2 text-[var(--text-secondary)]">
                      {limitOrg(r.memberName, r.organization)}
                    </td>
                    <td className="py-2">{windowLabel(r.window)}</td>
                    <td className="py-2 text-right tabular-nums">{r.days90}</td>
                    <td className="py-2 text-right tabular-nums">{r.days100}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="기간 내 90% 이상 도달한 계정이 없습니다." />
          )}
          <Insight>수집된 한도 스냅샷입니다. 실제 업무가 중단됐는지는 이 값만으로 알 수 없으므로 본인의 작업 맥락과 함께 확인합니다.</Insight>
        </Card>

        <Card title="구성원별 수집 합계" hint="최근 30일 고정" className="lg:col-span-2">
          {seatRows.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">이름</th>
                  <th className="pb-2 text-center font-medium">수집 기록</th>
                  <th className="pb-2 text-right font-medium">{label}</th>
                  <th className="pb-2 text-right font-medium">수집 상태</th>
                </tr>
              </thead>
              <tbody>
                {seatRows.map((r) => (
                  <tr key={r.id} className="border-t border-black/5 dark:border-white/5">
                    <td className="py-2">{r.name}</td>
                    <td className="py-2 text-center">{r.hasRecord ? "기록 있음" : "기록 미확인"}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatUsage(r.observation ? r.observation.value : null, sel.unit, numStyle)}
                      {r.unpricedTokens > 0 && <div className="text-[11px] text-[var(--text-muted)]">{unpricedNote(formatNumber(r.unpricedTokens))}</div>}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      일부 수집
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="등록된 구성원이 없습니다." />
          )}
          <Insight>고정된 구성원 순서의 수집 합계입니다. 기록 여부는 표시 단위와 무관하게 확인하며, 수집된 값이 낮다고 미사용·저성과로 판단하지 않습니다.</Insight>
        </Card>
      </div>
    </div>
  );
}
