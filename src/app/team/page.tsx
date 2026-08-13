export const dynamic = "force-dynamic";

import {
  getAdoptionMatrix,
  getAllMembers,
  getCacheSavings,
  getDailyRequests,
  getHourlyHeatmap,
  getInactiveMembers,
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
  formatCompact,
  formatNumber,
  parseDays,
  rangeForDays,
  REQUESTS_ONLY_TOOLS,
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
import MaturityBanner from "@/app/_components/analytics/MaturityBanner";
import { maturityFromParts } from "@/lib/team-maturity";
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
  searchParams: Promise<{ days?: string }>;
}) {
  const days = parseDays((await searchParams).days);
  const range = rangeForDays(days);

  const [
    adoptionRate,
    matrix,
    inactive,
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
  ] = await Promise.all([
    getTeamAdoptionRate(range),
    getAdoptionMatrix(),
    getInactiveMembers(7),
    getWeeklyActiveByTool(range),
    getScorecardWeeklySums(range),
    getPremiumShareWeekly(range),
    getCacheSavings(range),
    getModelAdoption(120),
    getOnboardingActivity(),
    getModelTierTrend(range),
    getHourlyHeatmap(range),
    getModelDistribution(range),
    getMemberWowDeltas(),
    getDailyRequests(range),
    getToolSummary(range),
    getLimitHistory(range),
    getLimitHitCounts(range),
    getMemberLeaderboard(rangeForDays(30)),
    getAllMembers(),
    getNumStyle(),
    getModelBreadthWeekly(range),
  ]);

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

  // ---- AI 사용 성숙도 배너 조립 (계산 로직은 team-maturity.ts와 공유) ----
  const maturity = maturityFromParts({
    adoptionRate,
    scoreWeekly,
    toolSummary,
    modelAdoption,
    teamSize,
  });

  const heatmapHasData = heatmap.some((row) => row.some((v) => v > 0));

  const requestsOnlyTools = toolSummary
    .filter((t) => REQUESTS_ONLY_TOOLS.has(t.tool) || (t.tokens === 0 && t.requests > 0))
    .map((t) => t.tool);
  const hasRequestsData = requests.some((r) => r.requests > 0);

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
        share: row?.weightedShare ?? 0,
      };
    })
    .sort(
      (a, b) => b.share - a.share || b.tokens - a.tokens || a.name.localeCompare(b.name),
    );

  return (
    <div>
      <PageHeader title="팀 분석">
        <RangeTabs days={days} base="/team" />
      </PageHeader>
      <p className="-mt-4 mb-6 text-xs text-[var(--text-muted)]">
        {range.from} ~ {range.to}
      </p>

      <SectionHeading lead="팀이 AI 도구를 얼마나 넓게, 꾸준히 쓰게 되고 있는가">도입 확산</SectionHeading>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="팀 도입률" hint="주별 활성 인원 ÷ 등록 인원">
          {adoptionRate.length ? (
            <AdoptionRateChart data={adoptionRate} />
          ) : (
            <EmptyState message="매핑된 구성원 사용 기록이 없습니다." />
          )}
          <Insight>등록 구성원 중 그 주에 실제로 쓴 비율입니다. 우상향이면 확산 중, 정체되면 온보딩·활용 장벽을 점검할 시점입니다.</Insight>
        </Card>

        <Card title="도입 매트릭스" hint="구성원 × 도구 · 마지막 사용">
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
          <Insight>빈 칸이 많은 행(사람)은 온보딩 대상, 빈 칸이 많은 열(도구)은 도입 여지가 있는 도구입니다.</Insight>
        </Card>

        <Card title="비활성 구성원" hint="최근 7일 무사용">
          {inactive.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">이름</th>
                  <th className="pb-2 font-medium">이메일</th>
                  <th className="pb-2 text-right font-medium">마지막 사용일</th>
                </tr>
              </thead>
              <tbody>
                {inactive.map((m) => (
                  <tr
                    key={m.email}
                    className="border-t border-black/5 dark:border-white/5"
                  >
                    <td className="py-2">{m.name}</td>
                    <td className="py-2 text-[var(--text-secondary)]">{m.email}</td>
                    <td className="py-2 text-right tabular-nums">
                      {m.lastDate ?? "기록 없음"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="전원이 최근 7일 내 사용했습니다 🎉" />
          )}
          <Insight>도입 이탈의 조기 신호입니다. 장기 비활성이면 설치·계정 등 장벽이 있는지 확인해 보세요.</Insight>
        </Card>

        <Card title="주간 활성 사용자 (도구별)" hint="주별 고유 구성원">
          {weeklyActive.data.length ? (
            <AdoptionChart data={weeklyActive.data} tools={weeklyActive.tools} />
          ) : (
            <EmptyState message="매핑된 구성원 사용 기록이 없습니다." />
          )}
          <Insight>어떤 도구가 팀의 주력이 되어가는지 — 도구별 확산 속도의 비교입니다.</Insight>
        </Card>
      </div>

      <SectionHeading lead="팀의 사용 습관이 어떤 모습이고, 어떻게 변하고 있는가">사용 패턴</SectionHeading>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="AI 활용 스코어카드" hint="주별 · 풀드/중앙값 병기 · 순위 없음" className="lg:col-span-2">
          <div className="mb-6">
            <MaturityBanner result={maturity} />
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
          <Insight>4축(습관·효율·숙련·확장) 원값 스코어카드입니다 — 점수화·순위 없음. 풀드는 팀 자원 전체 관점, 중앙값은 전형적인 팀원 관점입니다.</Insight>
        </Card>

        <Card title="모델 티어 믹스" hint="주별 토큰 비중 %" className="lg:col-span-2">
          {tierMix.weeks.length ? (
            <TierMixChart weeks={tierMix.weeks} families={tierMix.families} />
          ) : (
            <EmptyState message="이 기간에 기록된 토큰 사용량이 없습니다." />
          )}
          <Insight>팀 토큰이 어떤 등급 모델에 쓰이는지의 구성비입니다. 새 모델 출시 후 비중이 빠르게 옮겨가면 팀이 신모델을 빠르게 흡수한다는 뜻입니다.</Insight>
        </Card>

        <Card
          title="시간대 히트맵"
          hint="요일 × 시간 · usage_hourly"
          className="lg:col-span-2"
        >
          {heatmapHasData ? (
            <Heatmap matrix={heatmap} />
          ) : (
            <EmptyState message="이 기간에 시간별(hourly) 사용 기록이 없습니다." />
          )}
          <Insight>팀의 AI 집중 작업 시간대입니다. 회의·배포 일정과의 겹침을 피하는 참고자료가 됩니다.</Insight>
        </Card>

        <Card title="모델 분포" hint="모델별 토큰 점유율">
          {modelDist.length ? (
            <ModelDonut rows={modelDist} />
          ) : (
            <EmptyState message="이 기간에 기록된 토큰 사용량이 없습니다." />
          )}
          <Insight>기간 전체의 모델별 점유율 스냅샷 — 티어 믹스의 “지금” 단면입니다.</Insight>
        </Card>

        <Card title="주간 증감" hint="최근 7일 vs 이전 7일">
          {wow.length ? (
            <WowTable rows={wow} />
          ) : (
            <EmptyState message="최근 2주간 구성원 사용 기록이 없습니다." />
          )}
          <Insight>구성원별 급증/급감의 조기 신호입니다. 급감은 이탈 또는 휴가, 급증은 새 활용법 발견일 수 있습니다.</Insight>
        </Card>

        <Card title="일별 요청 추이" hint="requests" className="lg:col-span-2">
          {hasRequestsData ? (
            <TrendArea data={requests} dataKey="requests" unit="요청" />
          ) : (
            <EmptyState message="이 기간에 기록된 요청이 없습니다." />
          )}
          <Insight>토큰을 보고하지 않는 도구(Copilot)까지 포함한 전체 활동량 추세입니다.</Insight>
        </Card>

        {requestsOnlyTools.length > 0 && (
          <div className="rounded-lg border border-[var(--series-3)]/40 bg-[var(--series-3)]/5 px-4 py-3 text-xs text-[var(--text-secondary)] lg:col-span-2">
            <strong className="font-semibold text-[var(--text-primary)]">
              토큰 vs 활동량 안내:
            </strong>{" "}
            {requestsOnlyTools.map((t) => toolLabel(t)).join(", ")} 은(는) 토큰 수치를
            제공하지 않고 요청(requests) 수만 집계됩니다. 토큰 차트에는 나타나지 않으므로
            도입률·활동량은 위 요청 추이와 주간 활성 사용자로 함께 확인하세요.
          </div>
        )}

        <Card title="도구별 요약" className="lg:col-span-2">
          {toolSummary.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">도구</th>
                  <th className="pb-2 text-right font-medium">토큰</th>
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
                      {t.tokens ? formatNumber(t.tokens) : "—"}
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
              hint={h.organization}
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
                      {r.organization}
                    </td>
                    <td className="py-2">{r.window}</td>
                    <td className="py-2 text-right tabular-nums">{r.days90}</td>
                    <td className="py-2 text-right tabular-nums">{r.days100}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="기간 내 90% 이상 도달한 계정이 없습니다." />
          )}
          <Insight>100% 도달 일수 = 그날 실제로 작업이 막힌 날 — 가장 직접적인 증석 신호입니다. 90%+가 잦으면 예방적 검토 대상입니다.</Insight>
        </Card>

        <Card title="좌석 활용" hint="최근 30일 고정" className="lg:col-span-2">
          {seatRows.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">이름</th>
                  <th className="pb-2 text-center font-medium">활동</th>
                  <th className="pb-2 text-right font-medium">토큰</th>
                  <th className="pb-2 text-right font-medium">보정 지수</th>
                </tr>
              </thead>
              <tbody>
                {seatRows.map((r) => (
                  <tr key={r.id} className="border-t border-black/5 dark:border-white/5">
                    <td className="py-2">{r.name}</td>
                    <td className="py-2 text-center">{r.tokens > 0 ? "✅" : "⬜"}</td>
                    <td className="py-2 text-right tabular-nums">
                      {r.tokens > 0 ? formatCompact(r.tokens, numStyle) : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.share.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState message="등록된 구성원이 없습니다." />
          )}
          <Insight>노는 좌석(⬜)은 감석 후보, 사용이 소수에 몰려 있으면 확산 여지 — 증석·감석 양방향 판단에 씁니다. 이 표는 용량 계획용 지표로, 나무 성장과는 무관합니다.</Insight>
        </Card>
      </div>
    </div>
  );
}
