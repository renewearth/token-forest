import { getViewer } from "@/lib/auth";
import { connectDb, Member } from "@/lib/db";
import { getGrowthDays } from "@/lib/queries";
import { computeGrowth, MILESTONE_CATALOG } from "@/lib/growth";
import { todayKst, teamEpoch } from "@/lib/date";

export default async function GrowthCard({ memberId }: { memberId: string }) {
  const viewer = await getViewer();
  if (viewer.status !== "member" || viewer.member.id !== memberId) return null;
  await connectDb();
  const member = await Member.findById(memberId).lean();
  if (!member) return null;
  const from = member.onboardedAt ? new Date(member.onboardedAt).toISOString().slice(0, 10) : "1970-01-01";
  const g = computeGrowth(await getGrowthDays(memberId, from), teamEpoch(), todayKst());
  const earned = new Set(g.milestones);
  return (
    <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
      <summary className="cursor-pointer px-4 py-3 font-medium">기존 성장 보기 · 본인만</summary>
      <div className="space-y-3 px-4 pb-4 text-sm">
        <p className="text-[var(--text-muted)]">기존 게임 규칙에 따른 표시이며 업무 성과를 평가하지 않습니다.</p>
        <div className="flex items-center gap-4"><span aria-hidden className="text-5xl">{g.stageEmoji}</span><p>{g.stageLabel} · Lv{g.level} · {g.gp} GP</p></div>
        <p>기록된 활동 {g.activeDays}일 · 최고 연속 기록 {g.bestStreak}일 · 최근 게임 보너스 +{g.efficiencyBonusToday}</p>
        <div className="flex flex-wrap gap-2">{MILESTONE_CATALOG.filter((m) => earned.has(m.key)).map((m) => <span key={m.key} className="rounded bg-[var(--surface-2)] px-2 py-1">{m.emoji} {m.label.replace("효율 보너스", "게임 보너스")}</span>)}</div>
        <details className="text-xs text-[var(--text-secondary)]"><summary className="cursor-pointer">기존 게임 규칙</summary>
          <div className="mt-2 space-y-2">
            <p>활동일의 10 GP에 연속 기록 배수를 적용하고 게임 보너스(최대 5)를 더합니다. 게임 보너스에는 출력/캐시 쓰기 비율과 도구 수가 사용됩니다.</p>
            <p>과거 복구 규칙은 요청 수 20건 또는 출력 50,000토큰의 조건을 포함합니다. 이는 게임 조건이며 업무에 필요한 사용량을 권하는 기준이 아닙니다.</p>
            <p>계산 규칙과 원본 기록은 유지했습니다. 데이터가 수집되지 않은 기간이나 개인 일정까지 반영한 평가가 아닙니다.</p>
          </div>
        </details>
      </div>
    </details>
  );
}
