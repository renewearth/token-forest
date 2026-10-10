import { getViewer } from "@/lib/auth";
import { connectDb, Member } from "@/lib/db";
import { getGrowthDays, getUnconfirmedGrowthDates } from "@/lib/queries";
import { computeGrowth, GP_RULES, MILESTONE_CATALOG } from "@/lib/growth";
import { todayKst, teamEpoch } from "@/lib/date";

export default async function GrowthCard({ memberId }: { memberId: string }) {
  const viewer = await getViewer();
  if (viewer.status !== "member" || viewer.member.id !== memberId) return null;
  await connectDb();
  const member = await Member.findById(memberId).lean();
  if (!member) return null;
  const from = member.onboardedAt ? new Date(member.onboardedAt).toISOString().slice(0, 10) : "1970-01-01";
  const today = todayKst();
  const [days, unconfirmed] = await Promise.all([getGrowthDays(memberId, from), getUnconfirmedGrowthDates(today)]);
  const g = computeGrowth(days, teamEpoch(), today, undefined, unconfirmed);
  const earned = new Set(g.milestones);
  return (
    <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <summary className="cursor-pointer px-4 py-3 font-medium">성장 보기 · 본인만</summary>
      <div className="space-y-3 px-4 pb-4 text-sm">
        <p className="text-[var(--text-muted)]">게임 규칙에 따른 표시이며 업무 성과를 평가하지 않습니다.</p>
        <div className="flex items-center gap-4"><span aria-hidden className="text-5xl">{g.stageEmoji}</span><p>{g.stageLabel} · Lv{g.level} · {g.gp} GP</p></div>
        <p>기록된 활동 {g.activeDays}일 · 최고 연속 기록 {g.bestStreak}일 · 최근 사용 보너스 +{g.efficiencyBonusToday}</p>
        <div className="flex flex-wrap gap-2">{MILESTONE_CATALOG.filter((m) => earned.has(m.key)).map((m) => <span key={m.key} className="rounded bg-[var(--surface-2)] px-2 py-1">{m.emoji} {m.label}</span>)}</div>
        <details className="text-xs text-[var(--text-secondary)]"><summary className="cursor-pointer">게임 규칙</summary>
          <div className="mt-2 space-y-2">
            <p>AI를 쓴 날마다 10 GP에 연속 기록 배수를 적용하고 사용 보너스(최대 5)를 더합니다. 모든 수집 도구와 Claude 일별 보고서의 사용을 합쳐서 봅니다.</p>
            <p>사용 보너스는 두 가지입니다. 사용량: 그날 쓴 양이 넘은 단계(토큰 {GP_RULES.tokenSteps.map((n) => n.toLocaleString()).join(" / ")} 또는 요청 {GP_RULES.requestSteps.map((n) => n.toLocaleString()).join(" / ")}번 중 높은 쪽)에 따라 2단계부터 1점씩, 최대 4점. 다양성: 그날 사용량의 10% 이상을 차지한 모델 계열 수에서 1을 뺀 값, 최대 {GP_RULES.diversityBonusCap}점.</p>
            <p>토큰은 캐시 읽기를 뺀 기준 모델 환산값입니다. 끊긴 연속 기록을 되살리는 조건은 요청 {GP_RULES.floorRequests}건 또는 사용량 {GP_RULES.floorVolumeStep}단계입니다. 이는 게임 조건이며 업무에 필요한 사용량을 권하는 기준이 아닙니다.</p>
            <p>보고서가 아직 오지 않은 최근 날은 확인 중으로 두어 연속 기록을 끊지 않습니다. 데이터가 수집되지 않은 기간이나 개인 일정까지 반영한 평가가 아닙니다.</p>
          </div>
        </details>
      </div>
    </details>
  );
}
