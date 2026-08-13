import { Card } from "@/app/_components/ui";
import { InfoTip } from "@/app/_components/InfoTip";
import { METRIC_INFO } from "@/lib/metric-info";
import { getScorecardSums, getGrowthDays } from "@/lib/queries";
import { connectDb, Member } from "@/lib/db";
import { computeGrowth } from "@/lib/growth";
import { todayKst, teamEpoch, isoDaysAgo, todayUtc } from "@/lib/date";
import {
  EMPTY_SUMS, addSums, cacheReuseRatio, contextYield, sessionDepth,
  requestAnatomy, toolEntropy, median,
} from "@/lib/scorecard";
import type { ScoreSums } from "@/lib/scorecard";

// AI 활용 스코어카드(개인) — 4축, 본인 값 + 팀 중앙값 대비. 원값만, 점수화 없음.
// 무방향 지표(세션 깊이)는 화살표 없이 값만 (스펙 — 게이밍/오독 방지).
const RANGE_DAYS = 28;

type MemberCalc = {
  total: ScoreSums;
  claude: ScoreSums;
  byTool: Record<string, number>;
  models: Set<string>;
};

function fold(rows: Awaited<ReturnType<typeof getScorecardSums>>): Map<string, MemberCalc> {
  const map = new Map<string, MemberCalc>();
  for (const r of rows) {
    const m = map.get(r.memberId) ?? {
      total: { ...EMPTY_SUMS }, claude: { ...EMPTY_SUMS }, byTool: {}, models: new Set<string>(),
    };
    m.total = addSums(m.total, r.sums);
    if (r.tool === "claude_code") m.claude = addSums(m.claude, r.sums);
    m.byTool[r.tool] = (m.byTool[r.tool] ?? 0) + r.sums.input + r.sums.output;
    r.models.forEach((x) => m.models.add(x));
    map.set(r.memberId, m);
  }
  return map;
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
function num(v: number | null, digits = 1): string {
  return v == null ? "—" : v.toFixed(digits);
}
function delta(mine: number | null, team: number | null, higherBetter: boolean): string {
  if (mine == null || team == null) return "";
  const up = mine > team;
  return up === higherBetter ? " ▲" : " ▼";
}

export default async function Scorecard({ memberId }: { memberId: string }) {
  const range = { from: isoDaysAgo(RANGE_DAYS), to: todayUtc() };
  const rows = await getScorecardSums(range);
  const perMember = fold(rows);
  const mine = perMember.get(memberId);
  if (!mine) return null;

  await connectDb();
  const me = await Member.findById(memberId, { onboardedAt: 1 }).lean();
  const onboarded = me?.onboardedAt
    ? new Date(me.onboardedAt).toISOString().slice(0, 10)
    : null;
  const days = await getGrowthDays(memberId, onboarded ?? "1970-01-01");
  const g = computeGrowth(days, teamEpoch(), todayKst());
  const weeklyActive = days.filter((d) => d.date >= isoDaysAgo(7)).length;

  const others = [...perMember.values()];
  const med = (f: (m: MemberCalc) => number | null) =>
    median(others.map(f).filter((v): v is number => v != null));

  const myAnatomy = requestAnatomy(mine.total);
  const myReuse = cacheReuseRatio(mine.total);
  const myYield = contextYield(mine.total);

  return (
    <Card title="AI 활용 스코어카드" hint={`최근 ${RANGE_DAYS}일 · 팀 중앙값 대비 · 순위 없음`}>
      <div className="space-y-3 text-sm">
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)]">습관화</h3>
          <p>주간 활동일 {weeklyActive}/7 · 스트릭<InfoTip info={METRIC_INFO.streak} /> 🔥{g.streakDays} (최고 {g.bestStreak})</p>
        </section>
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)]">효율</h3>
          <p>캐시 재사용 배율<InfoTip info={METRIC_INFO.cacheReuse} /> {num(myReuse)}{delta(myReuse, med((m) => cacheReuseRatio(m.total)), true)} · 컨텍스트 수율<InfoTip info={METRIC_INFO.contextYield} /> {pct(myYield)}{delta(myYield, med((m) => contextYield(m.total)), true)}</p>
          <p className="text-xs text-[var(--text-muted)]">컨텍스트 수율은 새로 끌어온 컨텍스트 1토큰당 산출량입니다 — 높을수록 맥락을 알차게 씁니다.</p>
        </section>
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)]">숙련</h3>
          <p>세션 깊이<InfoTip info={METRIC_INFO.sessionDepth} /> {num(sessionDepth(mine.claude))} 턴/세션 <span className="text-[var(--text-muted)]">(Claude Code · 방향 없음 — 작업 스타일)</span></p>
          {myAnatomy && (
            <p>요청 1건 구성<InfoTip info={METRIC_INFO.requestAnatomy} /> — 입력 {Math.round(myAnatomy.inputPerReq).toLocaleString()} · 캐시 {Math.round(myAnatomy.cachePerReq).toLocaleString()} · 생성 {Math.round(myAnatomy.outputPerReq).toLocaleString()} 토큰</p>
          )}
        </section>
        <section>
          <h3 className="text-xs font-semibold text-[var(--text-muted)]">확장</h3>
          <p>도구 다양성<InfoTip info={METRIC_INFO.toolBreadth} /> {num(toolEntropy(mine.byTool), 2)}{delta(toolEntropy(mine.byTool), med((m) => toolEntropy(m.byTool)), true)} · 사용 모델 {mine.models.size}종</p>
        </section>
        <p className="text-[11px] text-[var(--text-muted)]">
          이 카드는 본인에게만 보입니다. 나무(성장)는 습관 동기부여용, 스코어카드는 정밀 분석 — 다르게 보이면 스코어카드가 기준입니다.
        </p>
      </div>
    </Card>
  );
}
